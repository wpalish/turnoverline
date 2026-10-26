import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

export class RuntimeConfigurationError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeConfigurationError'; this.code = code; }
}
const fail = (code, message) => { throw new RuntimeConfigurationError(code, message); };
const loopback = host => host === 'localhost' || host === '[::1]' || host === '::1' || host === '127.0.0.1';
const inspectOwner = info => {
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail('DATABASE_OWNER', 'Каталог, файл базы и служебные файлы SQLite должны принадлежать пользователю процесса.');
  }
};

export function runtimeConfig(env, { defaultPort = 8792, nodeVersion = process.versions.node } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major !== 24 || !Number.isInteger(minor) || minor < 15) fail('NODE_VERSION', 'Нужен Node.js >=24.15 <25.');
  const rawPort = env.PORT ?? String(defaultPort);
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) fail('PORT', 'PORT: целое число от 1 до 65535.');
  const port = Number(rawPort), host = env.HOST || '127.0.0.1', production = env.NODE_ENV === 'production';
  if (host !== 'localhost' && !isIP(host)) fail('HOST', 'HOST: IP-адрес интерфейса или localhost.');
  if (production && !env.PUBLIC_ORIGIN) fail('PUBLIC_ORIGIN', 'Для production явно задайте PUBLIC_ORIGIN.');
  let parsed;
  try { parsed = new URL(env.PUBLIC_ORIGIN || `http://${host === '::1' ? '[::1]' : host === 'localhost' ? 'localhost' : '127.0.0.1'}:${port}`); }
  catch { fail('PUBLIC_ORIGIN', 'PUBLIC_ORIGIN: нужен полный адрес http(s).'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('PUBLIC_ORIGIN', 'PUBLIC_ORIGIN: только http(s) origin, без пути, параметров и учётных данных.');
  }
  if (parsed.protocol === 'http:' && (!loopback(parsed.hostname) || !loopback(host))) {
    fail('PUBLIC_ORIGIN', 'Открытый сетевой интерфейс или внешний hostname требуют HTTPS reverse proxy и https PUBLIC_ORIGIN.');
  }
  if (production && parsed.protocol !== 'https:') fail('PUBLIC_ORIGIN', 'Для production нужен https PUBLIC_ORIGIN.');
  if (env.DATABASE_PATH === ':memory:') fail('DATABASE_PATH', 'Для запуска нужен постоянный файл DATABASE_PATH.');
  if (production && (!env.DATABASE_PATH || !isAbsolute(env.DATABASE_PATH))) fail('DATABASE_PATH', 'Для production задайте абсолютный DATABASE_PATH.');
  const username = env.WORK_ADMIN_USER || 'admin', password = env.WORK_ADMIN_PASSWORD || undefined;
  if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username)) fail('WORK_ADMIN_USER', 'WORK_ADMIN_USER: 3–80 латинских знаков, цифр, _. или -.');
  if (password && (password.length < 14 || password.length > 200)) fail('WORK_ADMIN_PASSWORD', 'WORK_ADMIN_PASSWORD: 14–200 символов.');
  return { port, host, origin: parsed.origin, production, database: resolve(env.DATABASE_PATH || '.data/workspace.sqlite'), admin: password ? { username, password } : undefined };
}

function inspectProductionFiles(database) {
  let directory;
  try { directory = lstatSync(dirname(database)); }
  catch { fail('DATABASE_DIRECTORY', 'Для production подготовьте существующий приватный каталог базы (0700).'); }
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('DATABASE_DIRECTORY', 'Каталог базы должен быть обычным каталогом, без символьной ссылки.');
  if (directory.mode & 0o077) fail('DATABASE_DIRECTORY_PERMISSIONS', 'Для production ограничьте права каталога базы до 0700.');
  inspectOwner(directory);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let info;
    try { info = lstatSync(database + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; fail('DATABASE_READ', 'Не удалось проверить служебные файлы SQLite.'); }
    if (!info.isFile() || info.isSymbolicLink()) fail('DATABASE_PATH', 'Служебные файлы SQLite WAL/SHM/journal должны быть обычными файлами, без символьных ссылок.');
    if (info.mode & 0o077) fail('DATABASE_PERMISSIONS', 'Для production ограничьте права файлов SQLite WAL/SHM/journal до 0600.');
    inspectOwner(info);
  }
}

// Read-only inspection: never initializes an empty database or rotates an account.
export function inspectBootstrap(config, definition) {
  if (config.production) inspectProductionFiles(config.database);
  let info;
  try { info = lstatSync(config.database); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info) {
    if (!config.admin) fail('BOOTSTRAP_REQUIRED', 'Первый запуск: задайте WORK_ADMIN_PASSWORD. База не создана.');
    return { existing: false, bootstrap: true };
  }
  if (!info.isFile() || info.isSymbolicLink()) fail('DATABASE_PATH', 'DATABASE_PATH должен указывать на обычный файл, без символьной ссылки.');
  if (config.production && (info.mode & 0o077)) fail('DATABASE_PERMISSIONS', 'Для production ограничьте права файла базы до 0600.');
  if (config.production) inspectOwner(info);
  let db;
  try {
    db = new DatabaseSync(config.database, { readOnly: true });
    const id = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const expected = Number.parseInt(createHash('sha256').update(definition.slug).digest('hex').slice(0, 7), 16);
    if (!(id === 0 && version === 0 && tables.length === 0) && (id !== expected || version !== 1)) {
      fail('DATABASE_PRODUCT', 'Чужая база или неподдерживаемая схема. Файл не изменён.');
    }
    if (tables.includes('users')) {
      const total = db.prepare('SELECT count(*) n FROM users').get().n;
      const admins = db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n;
      if (admins > 0) return { existing: true, bootstrap: false };
      if (total > 0) fail('ADMIN_REQUIRED', 'В базе нет администратора. Автоматическая замена аккаунтов не выполняется.');
    }
    if (!config.admin) fail('BOOTSTRAP_REQUIRED', 'В базе нет аккаунтов: задайте WORK_ADMIN_PASSWORD для первого администратора.');
    return { existing: true, bootstrap: true };
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) throw error;
    fail('DATABASE_READ', 'Не удалось прочитать базу. Проверьте формат, права и доступность файла.');
  } finally { db?.close(); }
}

export function startupFailure(error) {
  return error instanceof RuntimeConfigurationError
    ? { event: 'startup_refused', code: error.code, error: error.message }
    : { event: 'startup_failed', code: 'STARTUP_FAILED', error: 'Не удалось запустить сервер. Проверьте конфигурацию, права, файл базы и свободный порт.' };
}
