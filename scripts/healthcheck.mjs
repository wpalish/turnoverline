import http from 'node:http';
import { runtimeConfig } from '../core/runtime.js';
import definition from '../module.js';
try {
  const config = runtimeConfig(process.env, { defaultPort: 8792 });
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const result = await new Promise((resolve, reject) => {
    let deadline, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const req = http.get({ host, port: config.port, path: '/healthz', headers: { Host: new URL(config.origin).host } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; if (raw.length > 4096) req.destroy(new Error('Invalid health response')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(raw);
          if (res.statusCode !== 200 || value.status !== 'ok' || value.product !== definition.slug) throw new Error('Unavailable');
          finish(null, { status: 'ok', product: definition.slug });
        } catch { finish(new Error('Unavailable')); }
      });
      res.on('error', error => finish(error));
    });
    deadline = setTimeout(() => req.destroy(new Error('Health timeout')), 2000);
    req.on('error', error => finish(error));
  });
  console.log(JSON.stringify(result));
} catch {
  console.error(JSON.stringify({ status: 'unavailable', product: definition.slug }));
  process.exitCode = 1;
}
