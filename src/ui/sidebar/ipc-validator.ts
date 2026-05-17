// Sidebar shim — re-exports the authoritative IPC validators.
//
// Feature 013 — Wave 5 (US5, FR-024): the validators that used to live
// here are now declared in `src/contracts/runtime-validators.ts`. This
// file exists only as the historical import path used by the sidebar.
// The lint guard at `tests/lint/no-duplicate-ipc-validators.test.ts`
// asserts no inline `validate*` definitions remain here, and the drift
// guard at `tests/unit/contracts/sidebar-ipc-drift.test.ts` keeps the
// authoritative IPC contract single-sourced.
export * from '../../contracts/runtime-validators';
