import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import definition from '../module.js';
import { createServer } from '../core/server.js';
import { cleanRow, problem } from '../core/store.js';

const PASSWORD = 'Synthetic-security-only-2026!';
async function fixture(t, options = {}) {
  let clock = Date.parse('2026-10-26T08:00:00Z');
  const instance = createServer(definition, { now: () => clock, ...options });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.server.close(resolve)));
  const origin = 'http://127.0.0.1:' + instance.server.address().port;
  async function request(path, method = 'GET', data, headers = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(username) {
    const response = await request('/api/login', 'POST', { username, password: PASSWORD });
    assert.equal(response.status, 200);
    return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': response.data.user.csrf };
  }
  return { ...instance, request, login, advance: value => { clock += value; }, now: () => clock };
}

test('admin account summary exposes only factual active-session metadata; employee access is denied', async t => {
  const f = await fixture(t, { admin: { username: 'admin', password: PASSWORD } });
  assert.equal((await f.request('/api/accounts')).status, 401);
  const admin = await f.login('admin');
  await f.login('admin');
  assert.equal((await f.request('/api/users', 'POST', { username: 'employee', password: PASSWORD, role: 'operator' }, admin)).status, 201);
  const employee = await f.login('employee');
  await f.login('employee');
  f.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-expired-digest', 'employee', 'synthetic-expired-csrf', f.now() - 1);
  assert.equal((await f.request('/api/accounts', 'GET', null, employee)).status, 403);
  const result = await f.request('/api/accounts', 'GET', null, admin);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ['currentSessionExpires', 'serverTime', 'users']);
  const user = result.data.users.find(row => row.name === 'employee');
  assert.deepEqual(Object.keys(user).sort(), ['activeSessions', 'earliestExpiry', 'isCurrentUser', 'latestExpiry', 'name', 'role']);
  assert.equal(user.activeSessions, 2);
  assert.equal(user.earliestExpiry, f.now() + 28800000);
  assert.equal(user.latestExpiry, f.now() + 28800000);
  assert.equal(user.isCurrentUser, false);
  assert.equal(result.data.users.find(row => row.name === 'admin').isCurrentUser, true);
  assert.equal(result.data.currentSessionExpires, f.now() + 28800000);
  assert.doesNotMatch(JSON.stringify(result.data), /digest|csrf|password|synthetic-expired/i);
  f.advance(28800001);
  assert.equal((await f.request('/api/accounts', 'GET', null, admin)).status, 401);
});

test('session revocation enforces admin, Origin and CSRF, preserves the requesting session and audits without tokens', async t => {
  const f = await fixture(t, { admin: { username: 'admin', password: PASSWORD } });
  const admin = await f.login('admin'), otherAdminSession = await f.login('admin');
  await f.request('/api/users', 'POST', { username: 'employee', password: PASSWORD, role: 'operator' }, admin);
  const employee = await f.login('employee'), secondEmployee = await f.login('employee');
  const payload = { username: 'employee' };
  assert.equal((await f.request('/api/accounts/revoke-sessions', 'POST', payload, employee)).status, 403);
  assert.equal((await f.request('/api/accounts/revoke-sessions', 'POST', payload, { Cookie: admin.Cookie })).status, 403);
  assert.equal((await f.request('/api/accounts/revoke-sessions', 'POST', payload, { ...admin, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/accounts/revoke-sessions', 'POST', { username: 'absent-user' }, admin)).status, 404);
  assert.equal((await f.request('/api/accounts/revoke-sessions', 'POST', { username: {} }, admin)).status, 400);
  assert.equal((await f.request('/api/state', 'GET', null, employee)).status, 200);
  const before = f.store.read();
  const revoked = await f.request('/api/accounts/revoke-sessions', 'POST', payload, admin);
  assert.deepEqual(revoked.data, { username: 'employee', revoked: 2, keptCurrent: false });
  assert.equal((await f.request('/api/state', 'GET', null, employee)).status, 401);
  assert.equal((await f.request('/api/state', 'GET', null, secondEmployee)).status, 401);
  assert.deepEqual(f.store.read(), before, 'Security operations must not change domain data/revision.');
  const own = await f.request('/api/accounts/revoke-sessions', 'POST', { username: 'admin' }, admin);
  assert.deepEqual(own.data, { username: 'admin', revoked: 1, keptCurrent: true });
  assert.equal((await f.request('/api/state', 'GET', null, admin)).status, 200);
  assert.equal((await f.request('/api/state', 'GET', null, otherAdminSession)).status, 401);
  const audit = await f.request('/api/audit', 'GET', null, admin);
  const events = audit.data.events.filter(event => event.command.operation === 'revoke_sessions');
  assert.equal(events.length, 2);
  assert.equal(events[0].actor, 'admin');
  assert.doesNotMatch(JSON.stringify(events), /digest|csrf|password|work_.*_session/i);
});

test('unexpected errors are generic500 while intentional statuses and duplicate-name behavior survive', async t => {
  const f = await fixture(t, { admin: { username: 'admin', password: PASSWORD } });
  const admin = await f.login('admin');
  const duplicate = await f.request('/api/users', 'POST', { username: 'admin', password: PASSWORD, role: 'operator' }, admin);
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.data.error, 'Такое имя уже существует.');
  assert.equal((await f.request('/api/accounts', 'GET', null, admin)).data.users[0].role, 'admin');
  const original = f.store.read;
  try {
    f.store.read = () => { throw problem('Known validation', 422); };
    assert.deepEqual(await f.request('/api/state', 'GET', null, admin).then(({ status, data }) => ({ status, data })), { status: 422, data: { error: 'Known validation' } });
    for (const message of ['private /srv/workspace.sqlite token=do-not-expose', 'UNIQUE constraint failed: private_internal_table.secret']) {
      f.store.read = () => { throw Object.assign(new Error(message), { status: 400 }); };
      const result = await f.request('/api/state', 'GET', null, admin);
      assert.equal(result.status, 500);
      assert.equal(result.data.error, 'Внутренняя ошибка сервера. Повторите позже.');
      assert.doesNotMatch(JSON.stringify(result.data), /private|token|UNIQUE|sqlite/i);
    }
  } finally { f.store.read = original; }
});

test('invalid calendar dates produce intentional validation problems instead of RangeError', () => {
  const collection = { fields: [{ key: 'date', label: 'Дата', type: 'date' }] };
  for (const date of ['2026-99-01', '2026-00-10', '2026-02-30'])
    assert.throws(() => cleanRow(collection, { date }, {}), error => error.status === 400 && error.message === 'Дата: неверная дата.');
  assert.deepEqual(cleanRow(collection, { date: '2028-02-29' }, {}), { date: '2028-02-29' });
});

test('health reports only product/status, requires DB and admin, and does not create sessions', async t => {
  const empty = await fixture(t), ready = await fixture(t, { admin: { username: 'admin', password: PASSWORD } });
  assert.deepEqual((await empty.request('/healthz')).data, { status: 'unavailable', product: definition.slug });
  assert.equal((await empty.request('/healthz')).status, 503);
  const result = await ready.request('/healthz');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { status: 'ok', product: definition.slug });
  assert.equal(ready.store.db.prepare('SELECT count(*) count FROM sessions').get().count, 0);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest({hostname:'127.0.0.1',port:ready.server.address().port,path:'/healthz',headers:{Host:'attacker.example'}}, response => {response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end();
  });
  assert.equal(wrongHost,400);
  ready.store.db.exec('DROP TABLE failures; DROP TABLE sessions; DROP TABLE users;');
  const failed = await ready.request('/healthz');
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.data, { status: 'unavailable', product: definition.slug });
  assert.doesNotMatch(JSON.stringify(failed.data), /SQL|table|error|password/i);
});
