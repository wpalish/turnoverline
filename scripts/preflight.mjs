import { access } from 'node:fs/promises';
import { runtimeConfig, inspectBootstrap, startupFailure, RuntimeConfigurationError } from '../core/runtime.js';
import definition from '../module.js';
process.umask(0o077);
try {
  const config = runtimeConfig(process.env, { defaultPort: 8792 });
  const database = inspectBootstrap(config, definition);
  await Promise.all(['index.html', 'app.js', 'styles.css', 'workspace-guide.js', 'product-view.js'].map(file => access(new URL('../public/' + file, import.meta.url))));
  console.log(JSON.stringify({ status: 'ok', product: definition.slug, node: process.versions.node, production: config.production, origin: config.origin, host: config.host, port: config.port, bootstrapRequired: database.bootstrap }));
} catch (error) {
  console.error(JSON.stringify(startupFailure(error)));
  process.exitCode = error instanceof RuntimeConfigurationError ? 78 : 1;
}
