// Webview shim — re-exports the authoritative sidebar IPC contract
// module. Adding a new command MUST happen in
// `src/contracts/sidebar-ipc.ts`. The `.js` extension is required by
// the webview's "type": "module" declaration; the Vite bundler maps
// it to the .ts source at build time.
//
// The drift guard at `tests/unit/contracts/sidebar-ipc-drift.test.ts`
// asserts this file is a single `export *` re-export with no local
// declarations.
export * from '../../../src/contracts/sidebar-ipc.js';
