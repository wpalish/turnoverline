import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  realpath,
  mkdtemp,
  chmod,
  open,
  readdir,
  unlink,
  rmdir,
  link,
} from "node:fs/promises";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import definition from "../module.js";
import { cleanRow } from "../core/store.js";

// Local OS ownership is the authority. This tool never reads a plaintext password.
// Node v24.19: https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html#sqlitebackupsource-db-path-options
const tables = {
  workspace: [
    ["id", "INTEGER", 0, 1],
    ["revision", "INTEGER", 1, 0],
    ["payload", "TEXT", 1, 0],
  ],
  audit: [
    ["id", "TEXT", 0, 1],
    ["at", "TEXT", 1, 0],
    ["actor", "TEXT", 1, 0],
    ["command", "TEXT", 1, 0],
  ],
  users: [
    ["name", "TEXT", 0, 1],
    ["password", "TEXT", 1, 0],
    ["role", "TEXT", 1, 0],
  ],
  sessions: [
    ["digest", "TEXT", 0, 1],
    ["username", "TEXT", 1, 0],
    ["csrf", "TEXT", 1, 0],
    ["expires", "INTEGER", 1, 0],
  ],
  failures: [
    ["name", "TEXT", 0, 1],
    ["count", "INTEGER", 1, 0],
    ["since", "INTEGER", 1, 0],
  ],
};
const schemaSql = {
  workspace:
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL)",
  audit:
    "CREATE TABLE audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,command TEXT NOT NULL)",
  users:
    "CREATE TABLE users(name TEXT PRIMARY KEY,password TEXT NOT NULL,role TEXT NOT NULL)",
  sessions:
    "CREATE TABLE sessions(digest TEXT PRIMARY KEY,username TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL)",
  failures:
    "CREATE TABLE failures(name TEXT PRIMARY KEY,count INTEGER NOT NULL,since INTEGER NOT NULL)",
};
const normalizedSql = (sql) => sql.toLowerCase().replace(/\s+/g, "");
const sidecars = ["-wal", "-shm", "-journal"];
const uuid = /^[a-f0-9-]{36}$/;
const hex = /^[a-f0-9]{64}$/;
const account = /^[a-zA-Z0-9_.-]{3,80}$/;
const ownUid = () => {
  if (typeof process.getuid !== "function")
    fail("OWNER_REQUIRED", "POSIX ownership checks are required.");
  return process.getuid();
};
export class OperationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function fail(code, message) {
  throw new OperationError(code, message);
}
function ensure(ok, code, message) {
  if (!ok) fail(code, message);
}
async function statMaybe(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function ownedRegular(stat) {
  return (
    stat?.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === ownUid() &&
    (stat.mode & 0o022) === 0
  );
}
async function trustedDirectory(path, { leafOwned = false } = {}) {
  const canonical = await realpath(path),
    leaf = await lstat(canonical);
  ensure(
    leaf.isDirectory() &&
      !leaf.isSymbolicLink() &&
      (!leafOwned || leaf.uid === ownUid()),
    "UNSAFE_DIRECTORY",
    "The directory must be owned by the current OS user.",
  );
  let at = canonical;
  while (true) {
    const stat = await lstat(at);
    const stickySystem = (stat.mode & 0o1000) !== 0 && stat.uid === 0;
    ensure(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        ((stat.mode & 0o022) === 0 || stickySystem),
      "UNSAFE_DIRECTORY",
      "Use a directory hierarchy that other users cannot replace.",
    );
    if (dirname(at) === at) break;
    at = dirname(at);
  }
  return { path: canonical, stat: leaf };
}
function explicitPath(path) {
  ensure(
    typeof path === "string" &&
      path.trim() !== "" &&
      !path.includes("\0") &&
      path !== ":memory:",
    "PATH_REQUIRED",
    "Explicit filesystem paths are required.",
  );
  return resolve(path);
}
async function inputPath(path) {
  const requested = explicitPath(path),
    initial = await statMaybe(requested);
  ensure(
    ownedRegular(initial),
    "UNSAFE_INPUT",
    "Input must be an existing regular file owned by the current OS user, not a symlink.",
  );
  const parent = await trustedDirectory(dirname(requested));
  const canonical = join(parent.path, basename(requested)),
    stat = await lstat(canonical);
  ensure(
    ownedRegular(stat) && sameFile(initial, stat),
    "UNSAFE_INPUT",
    "Input identity changed during path validation.",
  );
  for (const suffix of sidecars) {
    const sibling = await statMaybe(canonical + suffix);
    ensure(
      !sibling || ownedRegular(sibling),
      "UNSAFE_INPUT",
      "SQLite sidecars must be regular owned files, not symlinks.",
    );
  }
  return { path: canonical, stat };
}
async function outputPath(path) {
  const requested = explicitPath(path),
    parent = await trustedDirectory(dirname(requested), { leafOwned: true });
  const canonical = join(parent.path, basename(requested));
  for (const suffix of ["", ...sidecars])
    ensure(
      !(await statMaybe(canonical + suffix)),
      "OUTPUT_EXISTS",
      "Output or its SQLite sidecar already exists; choose a new filename.",
    );
  return { path: canonical, parent };
}
function validObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail("INVALID_DATA", "Database JSON data is invalid.");
  }
}
function validateWorkspace(row) {
  ensure(
    row?.id === 1 && Number.isSafeInteger(row.revision) && row.revision >= 0,
    "INVALID_DATA",
    "Workspace revision or singleton is invalid.",
  );
  const data = parsed(row.payload),
    keys = definition.collections.map((c) => c.key).sort();
  ensure(
    validObject(data) &&
      JSON.stringify(Object.keys(data).sort()) === JSON.stringify(keys),
    "INVALID_DATA",
    "Workspace collections do not match this product.",
  );
  for (const c of definition.collections) {
    ensure(
      Array.isArray(data[c.key]),
      "INVALID_DATA",
      "Workspace collection is invalid.",
    );
    const ids = new Set();
    for (const row of data[c.key]) {
      ensure(
        validObject(row) &&
          typeof row.id === "string" &&
          uuid.test(row.id) &&
          !ids.has(row.id),
        "INVALID_DATA",
        "Workspace record identity is invalid.",
      );
      ids.add(row.id);
      ensure(
        typeof row.createdBy === "string" &&
          row.createdBy.length > 0 &&
          Number.isFinite(Date.parse(row.createdAt)) &&
          Number.isFinite(Date.parse(row.updatedAt)) &&
          typeof row.archived === "boolean",
        "INVALID_DATA",
        "Workspace history metadata is invalid.",
      );
      try {
        cleanRow(c, row, data);
      } catch {
        fail("INVALID_DATA", "Workspace fields fail the product validator.");
      }
    }
  }
  try {
    definition.validate(
      data,
      data,
      { operation: "restore" },
      { name: "backup-owner", role: "admin" },
    );
  } catch {
    fail("INVALID_DATA", "Workspace data fails the product invariants.");
  }
  return {
    revision: row.revision,
    collections: Object.fromEntries(keys.map((key) => [key, data[key].length])),
  };
}
export function validateDatabase(db) {
  db.exec("PRAGMA trusted_schema=OFF;");
  const app = Number.parseInt(
    createHash("sha256").update(definition.slug).digest("hex").slice(0, 7),
    16,
  );
  ensure(
    db.prepare("PRAGMA application_id").get().application_id === app,
    "WRONG_PRODUCT",
    "The database belongs to another product.",
  );
  ensure(
    db.prepare("PRAGMA user_version").get().user_version === 1,
    "UNSUPPORTED_SCHEMA",
    "Unsupported database schema version.",
  );
  const actual = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  ensure(
    JSON.stringify(actual) === JSON.stringify(Object.keys(tables).sort()),
    "UNSUPPORTED_SCHEMA",
    "The full database table schema is unsupported.",
  );
  ensure(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_schema WHERE type IN ('view','trigger') OR (type='index' AND name NOT LIKE 'sqlite_autoindex_%')",
      )
      .get().n === 0,
    "UNSUPPORTED_SCHEMA",
    "Unexpected database views, triggers or indexes.",
  );
  for (const [table, expected] of Object.entries(tables)) {
    const storedSql = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table)?.sql;
    ensure(
      typeof storedSql === "string" &&
        normalizedSql(storedSql) === normalizedSql(schemaSql[table]),
      "UNSUPPORTED_SCHEMA",
      "A database table has unsupported SQL constraints.",
    );
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => [c.name, c.type, c.notnull, c.pk]);
    ensure(
      JSON.stringify(columns) === JSON.stringify(expected),
      "UNSUPPORTED_SCHEMA",
      "A database table has unsupported columns.",
    );
  }
  ensure(
    db
      .prepare("PRAGMA integrity_check")
      .all()
      .every((row) => Object.values(row)[0] === "ok"),
    "CORRUPT_DATABASE",
    "SQLite integrity validation failed.",
  );
  ensure(
    db.prepare("PRAGMA foreign_key_check").all().length === 0,
    "CORRUPT_DATABASE",
    "SQLite foreign key validation failed.",
  );
  const workspace = db.prepare("SELECT * FROM workspace").all();
  ensure(
    workspace.length === 1,
    "INVALID_DATA",
    "Workspace must contain exactly one row.",
  );
  const summary = validateWorkspace(workspace[0]);
  const users = db.prepare("SELECT * FROM users").all(),
    names = new Set();
  for (const user of users) {
    ensure(
      typeof user.name === "string" &&
        account.test(user.name) &&
        /^[a-f0-9]{64}:[a-f0-9]{128}$/.test(user.password) &&
        ["admin", "operator"].includes(user.role),
      "INVALID_DATA",
      "Account data has an unsupported format.",
    );
    names.add(user.name);
  }
  for (const session of db.prepare("SELECT * FROM sessions").all())
    ensure(
      hex.test(session.digest) &&
        names.has(session.username) &&
        hex.test(session.csrf) &&
        Number.isSafeInteger(session.expires) &&
        session.expires >= 0,
      "INVALID_DATA",
      "Session data is invalid.",
    );
  for (const failure of db.prepare("SELECT * FROM failures").all())
    ensure(
      hex.test(failure.name) &&
        Number.isSafeInteger(failure.count) &&
        failure.count >= 0 &&
        Number.isSafeInteger(failure.since) &&
        failure.since >= 0,
      "INVALID_DATA",
      "Login failure data is invalid.",
    );
  for (const event of db.prepare("SELECT * FROM audit").all())
    ensure(
      typeof event.id === "string" &&
        uuid.test(event.id) &&
        Number.isFinite(Date.parse(event.at)) &&
        typeof event.actor === "string" &&
        event.actor.length > 0 &&
        validObject(parsed(event.command)),
      "INVALID_DATA",
      "Audit data is invalid.",
    );
  return {
    product: definition.slug,
    schemaVersion: 1,
    ...summary,
    tableCounts: Object.fromEntries(
      Object.keys(tables).map((table) => [
        table,
        db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      ]),
    ),
  };
}
async function createStage(parent) {
  const path = await mkdtemp(join(parent.path, ".sqlite-operation-"));
  await chmod(path, 0o700);
  const stat = await lstat(path),
    marker = randomBytes(32).toString("hex");
  const owner = await open(
    join(path, ".owner"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  await owner.writeFile(marker);
  await owner.close();
  const file = join(path, "snapshot.sqlite"),
    handle = await open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  await handle.close();
  return { path, root: parent.path, stat, marker, file };
}
async function assertStage(stage) {
  const at = await lstat(stage.path),
    rel = relative(stage.root, stage.path);
  ensure(
    rel &&
      rel !== "." &&
      !rel.startsWith(".." + sep) &&
      !rel.includes(sep) &&
      rel.startsWith(".sqlite-operation-") &&
      sameFile(at, stage.stat) &&
      at.isDirectory() &&
      at.uid === ownUid() &&
      (at.mode & 0o077) === 0 &&
      (await realpath(stage.path)) === stage.path,
    "CLEANUP_REFUSED",
    "Owned staging directory validation failed.",
  );
  const owner = await open(
    join(stage.path, ".owner"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    ensure(
      (await owner.stat()).uid === ownUid() &&
        (await owner.readFile("utf8")) === stage.marker,
      "CLEANUP_REFUSED",
      "Owned staging marker validation failed.",
    );
  } finally {
    await owner.close();
  }
}
async function cleanupStage(stage) {
  await assertStage(stage);
  const allowed = new Set([
    ".owner",
    "snapshot.sqlite",
    ...sidecars.map((s) => "snapshot.sqlite" + s),
  ]);
  const entries = await readdir(stage.path);
  for (const name of entries) {
    ensure(
      allowed.has(name),
      "CLEANUP_REFUSED",
      "Unexpected file in owned staging directory; cleanup refused.",
    );
    const stat = await lstat(join(stage.path, name));
    ensure(
      ownedRegular(stat),
      "CLEANUP_REFUSED",
      "Unexpected staging file identity; cleanup refused.",
    );
  }
  for (const name of entries) await unlink(join(stage.path, name));
  await rmdir(stage.path);
}
async function fileDigest(path) {
  const hash = createHash("sha256"),
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
export async function snapshotDatabase({
  source,
  output,
  operation = "backup",
}) {
  ownUid();
  let sourceDb,
    stage,
    published = false,
    result;
  try {
    const input = await inputPath(source),
      destination = await outputPath(output);
    sourceDb = new DatabaseSync(input.path, {
      readOnly: true,
      allowExtension: false,
      defensive: true,
      timeout: 5000,
    });
    sourceDb.exec("PRAGMA query_only=ON; BEGIN;");
    validateDatabase(sourceDb);
    stage = await createStage(destination.parent);
    await backup(sourceDb, stage.file);
    sourceDb.exec("ROLLBACK");
    sourceDb.close();
    sourceDb = null;
    const current = await lstat(input.path);
    ensure(
      sameFile(input.stat, current) && ownedRegular(current),
      "UNSAFE_INPUT",
      "Input identity changed during backup.",
    );
    const staged = new DatabaseSync(stage.file, {
      allowExtension: false,
      defensive: true,
      timeout: 5000,
    });
    try {
      staged.exec("PRAGMA journal_mode=DELETE;");
      result = validateDatabase(staged);
    } finally {
      staged.close();
    }
    await chmod(stage.file, 0o600);
    const handle = await open(
      stage.file,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertStage(stage);
    const parent = await trustedDirectory(destination.parent.path, {
      leafOwned: true,
    });
    ensure(
      sameFile(parent.stat, destination.parent.stat),
      "UNSAFE_DIRECTORY",
      "Output directory identity changed.",
    );
    for (const suffix of ["", ...sidecars])
      ensure(
        !(await statMaybe(destination.path + suffix)),
        "OUTPUT_EXISTS",
        "Output or its SQLite sidecar appeared; no file was replaced.",
      );
    await link(stage.file, destination.path);
    published = true;
    const directoryHandle = await open(
      destination.parent.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    result = {
      operation,
      ...result,
      output: destination.path,
      bytes: (await lstat(destination.path)).size,
      sha256: await fileDigest(destination.path),
    };
    await cleanupStage(stage);
    stage = null;
    return result;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    if (error.code === "EEXIST")
      fail("OUTPUT_EXISTS", "Output already exists; no file was replaced.");
    if (published)
      fail(
        "PUBLISHED_WITH_ERROR",
        "A new output was published but post-publication verification/cleanup failed; inspect it before reuse.",
      );
    fail(
      "OPERATION_FAILED",
      "Database operation failed; check input integrity, ownership, disk space and filesystem support.",
    );
  } finally {
    if (sourceDb) {
      try {
        sourceDb.close();
      } catch {}
    }
    if (stage) await cleanupStage(stage);
  }
}
export function parseArguments(args, kind) {
  const inputKey = kind === "backup" ? "--database" : "--input",
    valid = new Set([inputKey, "--output"]);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    ensure(
      valid.has(key) &&
        value &&
        !value.startsWith("--") &&
        !Object.hasOwn(parsed, key),
      "USAGE",
      "Use explicit " + inputKey + " PATH --output NEW_PATH.",
    );
    parsed[key] = value;
  }
  ensure(
    Object.keys(parsed).length === 2,
    "USAGE",
    "Use explicit " + inputKey + " PATH --output NEW_PATH.",
  );
  return {
    source: parsed[inputKey],
    output: parsed["--output"],
    operation: kind,
  };
}
export async function runCli(kind, args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args, kind);
    console.log(JSON.stringify(await snapshotDatabase(options), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof OperationError ? error.code : "OPERATION_FAILED",
        message:
          error instanceof OperationError
            ? error.message
            : "Database operation failed.",
      }),
    );
    process.exitCode = 1;
  }
}
