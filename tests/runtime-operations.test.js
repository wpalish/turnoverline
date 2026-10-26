import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, chmodSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import definition from '../module.js';
import { createServer } from '../core/server.js';
import { runtimeConfig, inspectBootstrap, RuntimeConfigurationError, startupFailure } from '../core/runtime.js';

const password = 'synthetic-runtime-password-2026';
const temporary = () => mkdtempSync(join(tmpdir(), definition.slug + '-runtime-'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
function request(port, host, path, { method = 'GET', body, origin, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (body) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('Test request timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function launch(env) {
  const child = spawn(process.execPath, ['start.js'], { env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', WORK_ADMIN_USER: 'test_admin', WORK_ADMIN_PASSWORD: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Startup deadline: ' + stderr)); }, 8000);
    const onData = () => { if (stdout.includes('"event":"listening"')) { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); resolve(); } };
    const onExit = code => { clearTimeout(timer); child.stdout.off('data', onData); reject(new Error('Startup exited ' + code + ': ' + stderr)); };
    child.stdout.on('data', onData); child.once('exit', onExit); onData();
  });
  return { child, logs: () => stdout + stderr };
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 7500); timer.unref();
  const [code, signal] = await exited; clearTimeout(timer);
  assert.equal(signal, null, 'graceful stop must not require SIGKILL'); assert.equal(code, 0);
}

test('first boot refuses missing owner secret without creating a database', () => {
  const dir = temporary();
  try {
    const path = join(dir, 'missing', 'workspace.sqlite');
    assert.throws(() => inspectBootstrap(runtimeConfig({ DATABASE_PATH: path }), definition), error => error.code === 'BOOTSTRAP_REQUIRED');
    assert.equal(existsSync(join(dir, 'missing')), false);
    assert.deepEqual(inspectBootstrap(runtimeConfig({ DATABASE_PATH: path, WORK_ADMIN_PASSWORD: password }), definition), { existing: false, bootstrap: true });
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('external plaintext, credentials in origin and ambiguous production data paths fail closed', () => {
  for (const env of [
    { PUBLIC_ORIGIN: 'http://app.example.test' },
    { HOST: '0.0.0.0' },
    { PUBLIC_ORIGIN: 'https://admin:do-not-print-this@app.example.test' },
    { PUBLIC_ORIGIN: 'https://app.example.test/workspace' },
    { PUBLIC_ORIGIN: 'https://app.example.test?secret=do-not-print-this' },
    { NODE_ENV: 'production', DATABASE_PATH: '/tmp/example.sqlite' },
    { NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://127.0.0.1:8792', DATABASE_PATH: '/tmp/example.sqlite' },
    { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://app.example.test', DATABASE_PATH: '.data/workspace.sqlite' },
  ]) {
    assert.throws(() => runtimeConfig(env), error => error instanceof RuntimeConfigurationError && !JSON.stringify(startupFailure(error)).includes('do-not-print-this'));
  }
  const valid = runtimeConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://APP.example.test/', DATABASE_PATH: '/tmp/example.sqlite' });
  assert.equal(valid.origin, 'https://app.example.test');
});

test('invalid runtime, bind address, port and bootstrap credentials are rejected', () => {
  for (const env of [{ PORT: '0' }, { PORT: '8792oops' }, { PORT: '65536' }, { HOST: 'untrusted-hostname' }, { WORK_ADMIN_USER: 'a' }, { WORK_ADMIN_PASSWORD: 'short' }]) assert.throws(() => runtimeConfig(env), RuntimeConfigurationError);
  for (const nodeVersion of ['22.20.0', '24.14.0', '25.0.0']) assert.throws(() => runtimeConfig({}, { nodeVersion }), RuntimeConfigurationError);
});

test('preflight reads an existing owner without creating or rotating accounts', () => {
  const dir = temporary();
  try {
    const database = join(dir, 'workspace.sqlite'), first = runtimeConfig({ DATABASE_PATH: database, WORK_ADMIN_PASSWORD: password });
    const app = createServer(definition, first); app.store.close();
    const before = hash(database), config = runtimeConfig({ DATABASE_PATH: database, WORK_ADMIN_USER: 'ignored_admin', WORK_ADMIN_PASSWORD: 'different-valid-secret-2026' });
    assert.deepEqual(inspectBootstrap(config, definition), { existing: true, bootstrap: false });
    assert.equal(hash(database), before);
    const db = new DatabaseSync(database, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT name,role FROM users').all().map(x => ({ ...x })), [{ name: 'admin', role: 'admin' }]); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preflight refuses foreign databases and symlinks without changing the file', () => {
  const dir = temporary();
  try {
    const database = join(dir, 'foreign.sqlite'); const db = new DatabaseSync(database); db.exec('PRAGMA application_id=42; CREATE TABLE foreign_data(value TEXT);'); db.close();
    const before = hash(database);
    assert.throws(() => inspectBootstrap(runtimeConfig({ DATABASE_PATH: database, WORK_ADMIN_PASSWORD: password }), definition), error => error.code === 'DATABASE_PRODUCT');
    assert.equal(hash(database), before);
    const link = join(dir, 'linked.sqlite'); symlinkSync(database, link);
    assert.throws(() => inspectBootstrap(runtimeConfig({ DATABASE_PATH: link, WORK_ADMIN_PASSWORD: password }), definition), error => error.code === 'DATABASE_PATH');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('start refuses unsafe production config before touching its database', () => {
  const dir = temporary();
  try {
    const database = join(dir, 'never-created.sqlite');
    const result = spawnSync(process.execPath, ['start.js'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://app.example.test', DATABASE_PATH: database, WORK_ADMIN_PASSWORD: password } });
    assert.equal(result.status, 78); assert.equal(existsSync(database), false); assert.equal((result.stdout + result.stderr).includes(password), false);
    assert.equal(JSON.parse(result.stderr.trim()).event, 'startup_refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cold start, health command, graceful restart and saved sessions work on a real file', async () => {
  const dir = temporary(), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const env = { PORT: String(port), PUBLIC_ORIGIN: origin, DATABASE_PATH: join(dir, 'workspace.sqlite'), WORK_ADMIN_PASSWORD: password };
  let running;
  try {
    running = await launch(env);
    const login = await request(port, new URL(origin).host, '/api/login', { method: 'POST', origin, body: { username: 'test_admin', password } });
    assert.equal(login.status, 200); const cookie = login.headers['set-cookie'][0].split(';')[0];
    const checked = spawnSync(process.execPath, ['scripts/healthcheck.mjs'], { env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', ...env }, encoding: 'utf8', timeout: 5000 });
    assert.equal(checked.status, 0, checked.stderr); assert.deepEqual(JSON.parse(checked.stdout), { status: 'ok', product: definition.slug });
    assert.equal(running.logs().includes(password), false); await stop(running.child);
    running = await launch({ ...env, WORK_ADMIN_PASSWORD: '' });
    const resumed = await request(port, new URL(origin).host, '/api/session', { cookie }); assert.equal(resumed.body.user.name, 'test_admin');
    const relogin = await request(port, new URL(origin).host, '/api/login', { method: 'POST', origin, body: { username: 'test_admin', password } }); assert.equal(relogin.status, 200);
    await stop(running.child); running = null;
  } finally { if (running?.child.exitCode === null) await stop(running.child); rmSync(dir, { recursive: true, force: true }); }
});

test('configured HTTPS proxy origin sets Secure cookies and keeps exact Host and Origin checks', async () => {
  const dir = temporary(), port = await freePort(), origin = 'https://app.example.test';
  let running;
  try {
    const env = { NODE_ENV: 'production', PORT: String(port), PUBLIC_ORIGIN: origin, DATABASE_PATH: join(dir, 'workspace.sqlite'), WORK_ADMIN_PASSWORD: password };
    running = await launch(env);
    const result = await request(port, 'app.example.test', '/api/login', { method: 'POST', origin, body: { username: 'test_admin', password } });
    assert.equal(result.status, 200); assert.match(result.headers['set-cookie'][0], /; Secure/); assert.match(result.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    const wrong = await request(port, 'app.example.test', '/api/login', { method: 'POST', origin: 'https://other.example.test', body: { username: 'test_admin', password } }); assert.equal(wrong.status, 403);
    const wrongHost = await request(port, 'other.example.test', '/healthz'); assert.notEqual(wrongHost.status, 200);
    const inspected = new DatabaseSync(env.DATABASE_PATH, { readOnly: true });
    assert.equal(inspected.prepare('PRAGMA application_id').get().application_id > 0, true); inspected.close();
    assert.equal((await import('node:fs')).statSync(env.DATABASE_PATH).mode & 0o077, 0);
    await stop(running.child); running = null;
  } finally { if (running?.child.exitCode === null) await stop(running.child); rmSync(dir, { recursive: true, force: true }); }
});

test('production requires private process-owned database files, sidecars and a real parent directory', () => {
  const dir = temporary(), database = join(dir, 'workspace.sqlite');
  const config = runtimeConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://app.example.test', DATABASE_PATH: database, WORK_ADMIN_PASSWORD: password });
  let app;
  try {
    chmodSync(dir, 0o755);
    assert.throws(() => inspectBootstrap(config, definition), error => error.code === 'DATABASE_DIRECTORY_PERMISSIONS');
    assert.equal(existsSync(database), false, 'Unsafe production bootstrap must not create a database.');
    chmodSync(dir, 0o700);
    app = createServer(definition, config);
    chmodSync(database, 0o600);
    for (const suffix of ['-wal', '-shm']) chmodSync(database + suffix, 0o600);
    writeFileSync(database + '-journal', '', { mode: 0o600 });
    const before = hash(database);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      chmodSync(database + suffix, 0o644);
      assert.throws(() => inspectBootstrap(config, definition), error => error.code === 'DATABASE_PERMISSIONS', suffix + ' with mode 0644 must be refused.');
      chmodSync(database + suffix, 0o600);
      const previous = database + suffix + '.original';
      renameSync(database + suffix, previous);
      try {
        symlinkSync(database, database + suffix);
        assert.throws(() => inspectBootstrap(config, definition), error => error.code === 'DATABASE_PATH');
      } finally { rmSync(database + suffix, { force: true }); renameSync(previous, database + suffix); }
    }
    if (typeof process.getuid === 'function') {
      const getuid = process.getuid, uid = getuid();
      // Simulate each foreign owner without requiring privileged chown on the test host.
      for (const [index, label] of ['directory', '-wal', '-shm', '-journal', 'database'].entries()) {
        let reads = 0;
        process.getuid = () => reads++ === index ? uid + 1 : uid;
        try {
          assert.throws(() => inspectBootstrap(config, definition), error => error.code === 'DATABASE_OWNER', label + ' owned by another UID must be refused.');
          assert.equal(reads, index + 1, label + ' ownership must be checked before opening SQLite.');
        } finally { process.getuid = getuid; }
      }
    }
    const alias = join(dir, 'alias'); symlinkSync(dir, alias);
    assert.throws(() => inspectBootstrap({ ...config, database: join(alias, 'workspace.sqlite') }, definition), error => error.code === 'DATABASE_DIRECTORY');
    assert.equal(hash(database), before, 'Refused permission checks must not modify the database.');
    assert.deepEqual(inspectBootstrap(config, definition), { existing: true, bootstrap: false });
  } finally { app?.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('health command has an absolute deadline even when a responder continuously trickles bytes', async () => {
  let chunks = 0, child;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
    const interval = setInterval(() => { chunks++; res.write(' '); }, 100);
    res.once('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, started = performance.now();
  let stdout = '', stderr = '', killTimer;
  try {
    child = spawn(process.execPath, ['scripts/healthcheck.mjs'], { env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, WORK_ADMIN_USER: 'test_admin', WORK_ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5500); killTimer.unref();
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'Health command must finish without an external kill.');
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.deepEqual(JSON.parse(stderr.trim()), { status: 'unavailable', product: definition.slug });
    assert.ok(chunks >= 2, 'Responder must have emitted repeatedly to defeat an inactivity-only timeout.');
    assert.ok(performance.now() - started < 4500, 'A trickling response must still meet the wall-clock deadline.');
  } finally {
    clearTimeout(killTimer);
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
