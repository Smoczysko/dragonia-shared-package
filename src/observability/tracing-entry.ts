// Preload entry — the only module in this lib with a side effect on import.
//
// Apps load it *before their own code* so the instrumentations can patch modules as they're imported:
//
//   node --import @dragonia/shared/observability/tracing dist/main.js
//
// It is deliberately not part of the package's main entry: importing `@dragonia/shared/observability`
// from inside an app is already too late to instrument that app's own imports.
import { register } from 'node:module';
import {
  register as registerSyncHooks,
  supportsSyncHooks,
} from 'import-in-the-middle/register-hooks.mjs';
import { startTracing } from './tracing.js';

// OpenTelemetry's instrumentations patch modules by hooking module *loading*, and the built-in hook
// only sees CommonJS `require`. The whole monorepo is ESM ("type": "module"), so without this every
// auto-instrumentation silently no-ops — verified: an inbound request handler runs with no active
// span until this hook is registered. `import-in-the-middle` is the ESM equivalent, and registering
// it here (rather than asking every app for an extra `--experimental-loader` flag) keeps the whole
// contract to the single `--import` above.
//
// Two ways in. The synchronous hook runs in-thread and costs no IPC round-trip per resolved module,
// but needs a Node with the fix from nodejs/node#59929 (>= 22.22.3 / 24.11.1 / 25.1.0 / 26). The
// async `module.register` path works everywhere but is deprecated as of Node 26 — so each is exactly
// the other's blind spot, and we pick per-runtime instead of pinning one.
if (supportsSyncHooks()) {
  registerSyncHooks();
} else {
  register('import-in-the-middle/hook.mjs', import.meta.url);
}

startTracing();
