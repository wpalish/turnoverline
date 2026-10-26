import { createServer } from './core/server.js';
import { runtimeConfig, inspectBootstrap, startupFailure, RuntimeConfigurationError } from './core/runtime.js';
import definition from './module.js';

process.umask(0o077);
try {
  const config = runtimeConfig(process.env, { defaultPort: 8792 });
  inspectBootstrap(config, definition);
  const { server, store } = createServer(definition, config);
  server.once('error', error => {
    console.error(JSON.stringify(startupFailure(error)));
    try { store.close(); } catch { /* No running listener owns this connection. */ }
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: 'listening', product: definition.slug, origin: config.origin, host: config.host, port: config.port }));
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
    server.close(() => clearTimeout(timer));
  });
} catch (error) {
  console.error(JSON.stringify(startupFailure(error)));
  process.exitCode = error instanceof RuntimeConfigurationError ? 78 : 1;
}
