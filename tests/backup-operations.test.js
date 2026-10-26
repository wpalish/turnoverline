import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  lstat,
  readdir,
  rm,
  symlink,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import definition from "../module.js";
import { createServer } from "../core/server.js";
import { parseArguments } from "../scripts/sqlite-operations.mjs";

const randomSecret = () => randomBytes(24).toString("hex");
const cli = (kind, ...args) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/" + kind + ".mjs", import.meta.url)),
      ...args,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
async function seedData() {
  if (definition.slug === "orta-inbox")
    return {
      collection: "branches",
      data: { name: "BACKUP SYNTHETIC branch" },
    };
  if (definition.slug === "dalel-check")
    return {
      collection: "checklists",
      data: {
        code: "BACKUP_SYNTHETIC",
        title: "BACKUP synthetic checklist",
        descriptionRu: "Ручная синтетическая проверка",
        descriptionKk: "Қолмен синтетикалық тексеру",
      },
    };
  const scenario = JSON.parse(
    await readFile(new URL("./scenario.json", import.meta.url), "utf8"),
  );
  return scenario.find((step) => !step.error);
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "full-backup-")),
    identity = await lstat(dir),
    path = join(dir, "live.sqlite"),
    password = randomSecret();
  const running = createServer(definition, {
    database: path,
    admin: { username: "backup_owner", password },
  });
  await new Promise((resolve) =>
    running.server.listen(0, "127.0.0.1", resolve),
  );
  const origin = "http://127.0.0.1:" + running.server.address().port;
  const request = async (path, method = "GET", data, auth = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(auth.cookie
          ? { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf }
          : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return {
      status: response.status,
      value: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const login = await request("/api/login", "POST", {
    username: "backup_owner",
    password,
  });
  assert.equal(login.status, 200);
  const auth = { cookie: login.cookie, csrf: login.value.user.csrf };
  await request("/api/login", "POST", {
    username: "backup_owner",
    password: randomSecret(),
  });
  const seed = await seedData();
  running.store.transact(
    {
      operation: "save",
      collection: seed.collection,
      data: seed.data,
      revision: running.store.read().revision,
    },
    { name: "backup_owner", role: "admin" },
  );
  if (definition.slug === "dalel-check") {
    const put = (collection, data) =>
      running.store.transact(
        {
          operation: "save",
          collection,
          data,
          revision: running.store.read().revision,
        },
        { name: "backup_owner", role: "admin" },
      );
    const last = (collection) => running.store.read().data[collection].at(-1);
    const checklist = last("checklists");
    put("requirements", {
      checklist: checklist.id,
      code: "SCOPE",
      position: 1,
      textRu: "Синтетическое требование",
      textKk: "Синтетикалық талап",
    });
    put("publications", { checklist: checklist.id });
    const publication = last("publications");
    put("documents", {
      title: "BACKUP synthetic evidence",
      language: "ru",
      body: "SYN backup evidence.",
      requestKey: randomUUID(),
    });
    const document = last("documents");
    put("worksheets", {
      document: document.id,
      publication: publication.id,
      requestKey: randomUUID(),
    });
    const worksheet = last("worksheets");
    put("findings", {
      worksheet: worksheet.id,
      requirementCode: "SCOPE",
      verdict: "supported",
      start: "0",
      end: "3",
      secondStart: "",
      secondEnd: "",
      note: "SYN explicit manual evidence",
    });
    put("reports", {
      worksheet: worksheet.id,
      note: "SYN complete manual report",
      requestKey: randomUUID(),
    });
    assert.equal(last("reports").report.status, "complete");
  }
  const before = running.store.read();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await new Promise((resolve) => running.server.close(resolve));
    }
  };
  t.after(async () => {
    await close();
    const actual = await lstat(dir);
    assert.equal(actual.ino, identity.ino);
    assert.equal(actual.dev, identity.dev);
    await rm(dir, { recursive: true });
  });
  return {
    dir,
    path,
    password,
    running,
    origin,
    request,
    auth,
    seed,
    before,
    close,
  };
}
function readFull(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      ["workspace", "audit", "users", "sessions", "failures"].map((name) => [
        name,
        db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
async function noStage(dir) {
  assert.deepEqual(
    (await readdir(dir)).filter((name) =>
      name.startsWith(".sqlite-operation-"),
    ),
    [],
  );
}

test("CLI rejects implicit paths, duplicates and unsupported options", () => {
  assert.throws(() => parseArguments([], "backup"));
  assert.throws(() =>
    parseArguments(
      ["--database", "x", "--output", "y", "--output", "z"],
      "backup",
    ),
  );
  assert.throws(() =>
    parseArguments(["--database", "x", "--force", "y"], "backup"),
  );
  assert.deepEqual(
    parseArguments(["--database", "x", "--output", "y"], "backup"),
    { source: "x", output: "y", operation: "backup" },
  );
  assert.deepEqual(
    parseArguments(["--input", "x", "--output", "y"], "restore"),
    { source: "x", output: "y", operation: "restore" },
  );
});
test("running WAL full snapshot preserves accounts, sessions, failures, domain data and audit across restore/restart", async (t) => {
  const f = await fixture(t),
    snapshot = join(f.dir, "snapshot.sqlite"),
    restored = join(f.dir, "restored.sqlite");
  assert.ok((await lstat(f.path + "-wal")).size > 0);
  const expected = readFull(f.path);
  assert.ok(
    expected.users.length &&
      expected.sessions.length &&
      expected.failures.length &&
      expected.audit.length,
  );
  const saved = cli("backup", "--database", f.path, "--output", snapshot);
  assert.equal(saved.status, 0, saved.stderr);
  const info = JSON.parse(saved.stdout);
  assert.equal(info.product, definition.slug);
  assert.equal(info.revision, f.before.revision);
  assert.equal((await lstat(snapshot)).mode & 0o777, 0o600);
  assert.deepEqual(readFull(snapshot), expected);
  await noStage(f.dir);
  const first = f.running.store.read().data[f.seed.collection][0],
    data = { ...f.seed.data };
  const field = definition.collections.find((c) => c.key === f.seed.collection)
    .fields[0].key;
  data[field] = String(data[field]) + (field === "code" ? "_LATER" : " later");
  f.running.store.transact(
    {
      operation: "save",
      collection: f.seed.collection,
      id: first.id,
      data,
      revision: f.running.store.read().revision,
    },
    { name: "backup_owner", role: "admin" },
  );
  const later = await f.request(
    "/api/users",
    "POST",
    { username: "later_user", password: randomSecret(), role: "operator" },
    f.auth,
  );
  assert.equal(later.status, 201);
  assert.deepEqual(
    readFull(snapshot),
    expected,
    "Later live writes must not contaminate an earlier snapshot",
  );
  const recovered = cli("restore", "--input", snapshot, "--output", restored);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(readFull(restored), expected);
  assert.equal((await lstat(restored)).mode & 0o777, 0o600);
  assert.equal(await lstat(snapshot + "-wal").catch(() => null), null);
  await noStage(f.dir);
  const restarted = createServer(definition, {
    database: restored,
    admin: { username: "not_created", password: randomSecret() },
  });
  await new Promise((resolve) =>
    restarted.server.listen(0, "127.0.0.1", resolve),
  );
  try {
    const origin = "http://127.0.0.1:" + restarted.server.address().port;
    const existing = await fetch(origin + "/api/state", {
      headers: { Cookie: f.auth.cookie },
    });
    assert.equal(
      existing.status,
      200,
      "The stored session is part of the full snapshot",
    );
    assert.deepEqual((await existing.json()).data, f.before.data);
    const logged = await fetch(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "backup_owner", password: f.password }),
    });
    assert.equal(
      logged.status,
      200,
      "Original account hash must authenticate after reopening",
    );
    assert.equal(
      restarted.store.db
        .prepare(
          "SELECT count(*) n FROM users WHERE name IN ('later_user','not_created')",
        )
        .get().n,
      0,
    );
  } finally {
    await new Promise((resolve) => restarted.server.close(resolve));
  }
  assert.ok(
    !saved.stdout.includes(f.password) &&
      !recovered.stdout.includes(f.password),
  );
});
test("corrupt, wrong-product, unsupported-schema and invalid-domain inputs never publish a restore", async (t) => {
  const f = await fixture(t),
    snapshot = join(f.dir, "base.sqlite");
  assert.equal(
    cli("backup", "--database", f.path, "--output", snapshot).status,
    0,
  );
  const corrupt = join(f.dir, "corrupt.sqlite");
  await writeFile(corrupt, "synthetic non-SQLite data", { mode: 0o600 });
  const wrong = join(f.dir, "wrong.sqlite"),
    schema = join(f.dir, "schema.sqlite"),
    payload = join(f.dir, "payload.sqlite"),
    version = join(f.dir, "version.sqlite");
  for (const file of [wrong, schema, payload, version])
    await copyFile(snapshot, file);
  let db = new DatabaseSync(wrong);
  db.exec("PRAGMA application_id=123;");
  db.close();
  db = new DatabaseSync(schema);
  db.exec("ALTER TABLE users ADD COLUMN unexpected TEXT;");
  db.close();
  db = new DatabaseSync(version);
  db.exec("PRAGMA user_version=99;");
  db.close();
  db = new DatabaseSync(payload);
  db.prepare("UPDATE workspace SET payload=?").run('{"unexpected":[]}');
  db.close();
  for (const [index, file] of [
    corrupt,
    wrong,
    schema,
    payload,
    version,
  ].entries()) {
    const output = join(f.dir, `rejected-${index}.sqlite`),
      result = cli("restore", "--input", file, "--output", output);
    assert.notEqual(result.status, 0);
    assert.equal(await lstat(output).catch(() => null), null);
    assert.ok(!result.stderr.includes(f.password));
    await noStage(f.dir);
  }
});
test("existing outputs, sidecars and symlinks are refused without replacing or following targets", async (t) => {
  const f = await fixture(t),
    snapshot = join(f.dir, "safe.sqlite");
  assert.equal(
    cli("backup", "--database", f.path, "--output", snapshot).status,
    0,
  );
  const target = join(f.dir, "existing.sqlite"),
    sentinel = Buffer.from("synthetic existing target");
  await writeFile(target, sentinel, { mode: 0o600 });
  for (const kind of ["backup", "restore"]) {
    const result = cli(
      kind,
      kind === "backup" ? "--database" : "--input",
      kind === "backup" ? f.path : snapshot,
      "--output",
      target,
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(target), sentinel);
  }
  const sidecarTarget = join(f.dir, "sidecar.sqlite");
  await writeFile(sidecarTarget + "-wal", sentinel, { mode: 0o600 });
  assert.notEqual(
    cli("restore", "--input", snapshot, "--output", sidecarTarget).status,
    0,
  );
  assert.deepEqual(await readFile(sidecarTarget + "-wal"), sentinel);
  assert.equal(await lstat(sidecarTarget).catch(() => null), null);
  const inputLink = join(f.dir, "input-link.sqlite"),
    outputLink = join(f.dir, "output-link.sqlite");
  await symlink(snapshot, inputLink);
  await symlink(target, outputLink);
  assert.notEqual(
    cli(
      "restore",
      "--input",
      inputLink,
      "--output",
      join(f.dir, "no-follow.sqlite"),
    ).status,
    0,
  );
  assert.notEqual(
    cli("restore", "--input", snapshot, "--output", outputLink).status,
    0,
  );
  assert.deepEqual(await readFile(target), sentinel);
  await noStage(f.dir);
});

test("concurrent snapshot publishers never overwrite the winning new destination", async (t) => {
  const f = await fixture(t),
    output = join(f.dir, "race.sqlite");
  const invoke = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url)),
        "--database",
        f.path,
        "--output",
        output,
      ]);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const results = await Promise.all([invoke(), invoke()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 1]);
  assert.deepEqual(readFull(output), readFull(f.path));
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await noStage(f.dir);
});
test("unsafe writable output directories and source sidecar symlinks fail closed", async (t) => {
  const f = await fixture(t),
    unsafe = join(f.dir, "unsafe"),
    snapshot = join(f.dir, "safe-base.sqlite"),
    alias = join(f.dir, "alias.sqlite"),
    sentinel = join(f.dir, "sentinel");
  assert.equal(
    cli("backup", "--database", f.path, "--output", snapshot).status,
    0,
  );
  await mkdir(unsafe, { mode: 0o700 });
  await chmod(unsafe, 0o777);
  assert.notEqual(
    cli(
      "restore",
      "--input",
      snapshot,
      "--output",
      join(unsafe, "refused.sqlite"),
    ).status,
    0,
  );
  assert.deepEqual(await readdir(unsafe), []);
  await chmod(unsafe, 0o700);
  await copyFile(snapshot, alias);
  await writeFile(sentinel, "unchanged synthetic sentinel", { mode: 0o600 });
  await symlink(sentinel, alias + "-shm");
  assert.notEqual(
    cli(
      "backup",
      "--database",
      alias,
      "--output",
      join(f.dir, "refused-source.sqlite"),
    ).status,
    0,
  );
  assert.equal(
    await readFile(sentinel, "utf8"),
    "unchanged synthetic sentinel",
  );
  await noStage(f.dir);
});
