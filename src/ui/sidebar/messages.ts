// Host shim — re-exports the authoritative sidebar IPC contract module.
//
// Adding a new command MUST happen in `src/contracts/sidebar-ipc.ts`.
// This file exists only as the historical import path used by the host;
// the drift guard at `tests/unit/contracts/sidebar-ipc-drift.test.ts`
// asserts module identity between this shim and the authoritative
// module via `===`, which is only true if this file is a single
// `export *` re-export with no local declarations.
export * from '../../contracts/sidebar-ipc';
