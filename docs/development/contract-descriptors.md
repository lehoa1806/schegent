# Declarative IPC and Snapshot Contract Descriptors

<!-- Source: ../../scripts/generate-contract-schemas.mjs -->
<!-- Source: ../../scripts/contracts/descriptor-dsl.mjs -->
<!-- Source: ../../scripts/contracts/ipc-descriptors/index.mjs -->
<!-- Source: ../../scripts/contracts/snapshot-descriptors.mjs -->

Schegent derives its inbound sidebar IPC validators, host IPC/snapshot types, self-contained webview snapshot mirror, and Draft 2020-12 JSON Schema from a single set of pure-ESM descriptors under `scripts/contracts/` with **zero external runtime or dev dependencies**.

## Architecture

```text
scripts/contracts/
├── descriptor-dsl.mjs            # Field & container primitives (d.str, d.int, d.enum, d.obj, d.discUnion, ...)
├── canonical-enums.mjs           # AST extraction of canonical TypeScript enum literals (no hand-copied lists)
├── ipc-descriptors/              # 9 command-family modules covering all 71 inbound CMD_* commands + 3 host messages
│   ├── queue-core.mjs
│   ├── queue-management.mjs
│   ├── phase-control.mjs
│   ├── navigation-settings.mjs
│   ├── history-evidence.mjs
│   ├── catalog.mjs
│   ├── phase-log.mjs
│   ├── analytics-reporting.mjs
│   ├── execution-workflow.mjs
│   ├── host-messages.mjs
│   └── index.mjs
├── snapshot-descriptors.mjs      # WorkflowSnapshot v4 + 16 mirrored projection slices (host + webview optionality)
├── emit-types.mjs                # Emits host TypeScript interfaces (sidebar-ipc-types.ts, snapshot-types.ts)
├── emit-validators.mjs           # Emits zero-cast inbound validators (src/contracts/generated/validators/*.ts)
├── emit-webview-mirror.mjs       # Emits webview-ui/src/lib/generated/snapshot-mirror.ts (zero repo/src imports)
└── emit-json-schema.mjs          # Emits Draft 2020-12 src/contracts/generated/schemas/sidebar-ipc.schema.json
```

All outputs are generated deterministically by `scripts/generate-contract-schemas.mjs`.

## Commands

| Command | Purpose |
|---|---|
| `npm run contracts:generate` | Regenerate all 24 contract artifacts from descriptors and AST sources |
| `npm run contracts:check` | Verify every generated file is byte-for-byte fresh; exits non-zero naming both the stale file and its source descriptor |

## Adding or Changing a Field

1. Edit the owning descriptor:
   - Inbound IPC command payload or validation bound: `scripts/contracts/ipc-descriptors/<family>.mjs`.
   - Snapshot projection field: `scripts/contracts/snapshot-descriptors.mjs` (use `webviewOptional: true` when a field is required on the host producer but optional on the webview receiver for legacy-host tolerance).
2. Run `npm run contracts:generate`.
3. Update or add differential test cases in `tests/unit/contracts/runtime-validators.differential.test.ts` (for IPC commands) or fixture assertions in `tests/contract/sidebar-ipc-schema-validation.test.ts` (for snapshots).
4. Run `npm run contracts:check`, `npm run typecheck`, `npm run build:webview`, and the contract test suites.

## Adding a New Inbound Command

1. Register the `CMD_*` constant in `src/contracts/sidebar-ipc.ts` (and `MUTATING_COMMANDS` / `sidebar-command-metadata.ts` if mutating).
2. Add the command descriptor to the matching family module under `scripts/contracts/ipc-descriptors/`.
3. Run `npm run contracts:generate` — the generator asserts a 1:1 bijection between `COMMAND_TYPES` in `src/contracts/sidebar-ipc.ts` and the descriptor registry.
4. Wire the new `case CMD_*:` arm in `src/contracts/runtime-validators.ts` to the generated validator.
5. Do **not** introduce `as SidebarCommand` casts — `tests/lint/no-sidebar-command-casts.test.ts` pins the ceiling across `src/` at `0`.

## Parity Test Retirement Record (FR-R7-05)

`tests/parity/snapshot-mirror-structural-parity.test.ts` was retired when FR-R7-05 replaced the hand-maintained host/webview snapshot mirror with `webview-ui/src/lib/generated/snapshot-mirror.ts` emitted from `scripts/contracts/snapshot-descriptors.mjs`.

- **Why the former gate is redundant**: both `src/contracts/generated/snapshot-types.ts` (re-exported by `src/ui/sidebar/snapshot.ts`) and `webview-ui/src/lib/generated/snapshot-mirror.ts` (re-exported by `webview-ui/src/lib/snapshot-types.ts`) are generated from the same descriptor file.
- **What now enforces the invariant**:
  1. `npm run contracts:check` (verified by negative controls in `tests/contract/action-keys-generation.test.ts`) fails whenever any generated host or webview artifact drifts from its descriptor.
  2. `tests/contract/sidebar-ipc-schema-validation.test.ts` validates real host snapshots (`buildIdleSnapshot`, the populated visual fixture, and live `StateProjector` output) against the generated Draft 2020-12 JSON Schema.
  3. `tests/lint/snapshot-mirror-census.test.ts` ensures remaining webview-local declarations in `webview-ui/src/lib/snapshot-types.ts` do not restate host types and verifies union-superset parity across both `snapshot-types.ts` and `generated/snapshot-mirror.ts`.
