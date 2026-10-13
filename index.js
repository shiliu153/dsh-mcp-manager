// Host plugin: registers mcp_manager_* tools on ctx.tools, and (when the web
// profile is present) the panel's Fetch routes on the harness's own /api
// channel through ctx.connection.
// Official Host export form: named `apply`, plus `name` and `inject`.
// Tool definitions use the official hand-built shape (see lib/tools-bridge.js).
import path from 'node:path';
import os from 'node:os';
import { createToolDefs } from './lib/tools-bridge.js';
import { registerRoutes } from './lib/server.js';

/** Cordis plugin name used by loader diagnostics. */
const name = 'dsh-mcp-manager';
/** Services required by this plugin. */
const inject = ['tools'];

export function apply(ctx) {
  const patchPath = defaultPatchPath();
  const disposers = createToolDefs(patchPath).map((def) => ctx.tools.register(def));
  ctx.effect(() => () => disposers.forEach((d) => d()), 'dsh-mcp-manager.tools');

  // Dynamic injection: a host without the web profile keeps the tools and
  // stays inactive here instead of throwing.
  ctx.inject(['connection'], (scope) => {
    registerRoutes(scope, scope.connection, { patchPath });
  });
}

function defaultPatchPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'cordis.patch.yml');
}

export { createToolDefs, name, inject };
