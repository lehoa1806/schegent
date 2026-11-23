# Declarative IPC and Snapshot Contract Descriptors

<!-- Source: ../../scripts/generate-contract-schemas.mjs -->
<!-- Source: ../../scripts/contracts/descriptor-dsl.mjs -->
<!-- Source: ../../scripts/contracts/ipc-descriptors/index.mjs -->
<!-- Source: ../../scripts/contracts/snapshot-descriptors.mjs -->
<!-- Source: ../../scripts/contracts/emit-backend-descriptors.mjs -->

Schegent derives its inbound sidebar IPC validators, live host IPC/host-message/snapshot types, self-contained webview mirrors (`snapshot-mirror.ts`, `backend-descriptors.ts`, `action-keys.ts`, `queue-failure-policy.ts`), and Draft 2020-12 JSON Schema from a single set of pure-ESM descriptors under `scripts/contracts/` with **zero external runtime or dev dependencies**.

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
├── snapshot-descriptors.mjs      # WorkflowSnapshot v4 + nested projection $defs (host + webview optionality)
├── emit-backend-descriptors.mjs  # Validates manifest/settings parity & emits webview backend-descriptors.ts
├── emit-types.mjs                # Emits all 71 live command types + 3 host messages (sidebar-ipc-types.ts) & snapshot-types.ts
├── emit-validators.mjs           # Emits zero-cast inbound validators (src/contracts/generated/validators/*.ts)
├── emit-webview-mirror.mjs       # Emits webview-ui/src/lib/generated/snapshot-mirror.ts (zero repo/src imports)
└── emit-json-schema.mjs          # Emits Draft 2020-12 src/contracts/generated/schemas/sidebar-ipc.schema.json
```

All outputs are generated deterministically by `scripts/generate-contract-schemas.mjs`.

The inbound JSON Schema models the raw message before host normalization. The host ignores extra envelope fields and rejects a payload for commands that declare none. Where legacy validators accept an empty array as an empty payload, the schema allows it alongside the object form. For trimmed fields, length bounds apply to the trimmed text. For phase-log reads, an omitted iteration number defaults to `null`. For advisory model-save fields, the schema documents the recognized shape and accepts values the host discards.

### Live Generated IPC Types

`src/contracts/generated/sidebar-ipc-types.ts` is the sole declaration site for all 71 inbound `*Command` interfaces and all 3 host-to-webview push message envelopes (`StateSnapshotMessage<S>`, `CommandAckMessage`, `PhaseLogBatchPushMessage`, and `HostMessage<S>`).

- All `src/contracts/sidebar-ipc/*.ts` sub-modules and `src/contracts/sidebar-ipc.ts` re-export these generated interfaces rather than hand-declaring `extends CommandBase<...>` copies.
- The snapshot sync metadata and positioned phase-log batch types are generated from the same definitions as their JSON Schema. The snapshot envelope fields feed both the TypeScript declaration and the legacy, full, and routine schema variants.
- Commands whose payload is a shared service request type (the six catalog lifecycle commands and `CMD_PREFLIGHT_PROCESS_YAML`) use `payloadTypeRef` in their descriptors so the generated interface references the canonical request type directly instead of re-declaring its fields.
- Editing any IPC descriptor and running `npm run contracts:generate` propagates directly into generated host types, live `sidebar-ipc.ts` / `webview-ui/src/lib/messages.ts` exports, runtime validators, and `sidebar-ipc.schema.json`.

## Commands

| Command | Purpose |
|---|---|
| `npm run contracts:generate` | Regenerate all 26 contract artifacts from descriptors and AST sources |
| `npm run contracts:check` | Verify every generated file is byte-for-byte fresh; exits non-zero naming both the stale file and its source descriptor |

## Sparse-Array Rejection Policy

Generated inbound array validators iterate elements with `for (const el of arr)` rather than `Array.prototype.every()` (which silently skips uninitialized holes). Any sparse array hole therefore yields `undefined` and fails closed with `{ ok: false, reason: 'invalid-payload' }`:

- `CMD_PUBLISH_PACKAGE.layers`
- `CMD_PUBLISH_PACKAGE.layers[].definitions`
- `CMD_SAVE_MODELS.models[k]`

This aligns in-process validation with JSON wire semantics (where holes serialize as `null` and fail item validation) so callers cannot bypass element validation by constructing sparse arrays. `tests/unit/contracts/runtime-validators.differential.test.ts` pins both this policy and isolated per-field validation coverage across all 71 commands.

## Webview Boundary (Spec 319 Generated Mirrors & Pure Contract Leaves)

The webview (`webview-ui/src/`) follows a two-tier contract boundary enforced by `tests/lint/webview-host-import-direction.test.ts` and `tests/lint/snapshot-mirror-census.test.ts`:

1. **Self-contained generated mirrors (`webview-ui/src/lib/generated/*`)**: `backend-descriptors.ts`, `snapshot-mirror.ts`, `action-keys.ts`, and `queue-failure-policy.ts` are emitted from host sources/descriptors and carry **zero** imports from host `src/`. All webview backend metadata, runner predicates (`isBackendRunnerKind`), `SUPPORTED_BACKENDS`, `DEFAULT_BACKEND`, and `BackendRunnerKind` come exclusively from `webview-ui/src/lib/generated/backend-descriptors.ts` (zero webview imports of `src/contracts/backend-kinds.ts`).
2. **Pure contract leaves (`src/contracts/`)**: `webview-ui/src/lib/messages.ts` and `webview-ui/src/lib/snapshot-types.ts` may re-export pure, Node-free and `vscode`-free contract leaves from `src/contracts/` (such as `sidebar-ipc.ts`, `snapshot-projections.ts`, and `snapshot-vocabulary.ts`) so host and webview share one declaration without duplicating wire types.

Backend-valued settings metadata in `src/config/settings-schema.ts` (`schegent.backend.runner`, `schegent.backend.uncontainedBackends` including `itemEnum`, `schegent.models`, `schegent.acp.profile`, and every `schegent.<cliPathSettingKey>`) is validated at generation time against `BACKEND_DESCRIPTORS` and `package.json` by `validateSettingsSchemaParity` in `scripts/contracts/emit-backend-descriptors.mjs`.

## Adding or Changing a Field

1. Edit the owning descriptor:
   - Inbound IPC command payload or validation bound: `scripts/contracts/ipc-descriptors/<family>.mjs`.
   - Host-push envelope, snapshot sync metadata, or phase-log batch: `scripts/contracts/ipc-descriptors/host-messages.mjs`.
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

## Migration line counts

Spec 319 SC-005 called for removing at least 2,000 hand-written lines from these four targets. Counting the stored files with `wc -l` at the pre-migration commit `2c5f3d21` and the delivery commit `8abb4851` shows a reduction of 3,959 lines.

| Target | Before | After |
|---|---:|---:|
| `src/contracts/runtime-validators.ts` | 787 | 357 |
| `src/contracts/validators/*.ts` | 3,775 | 1,753 |
| `src/ui/sidebar/snapshot.ts` | 1,212 | 334 |
| `webview-ui/src/lib/snapshot-types.ts` | 1,386 | 757 |
| Total | 7,160 | 3,201 |

## Parity Test Retirement Record (FR-R7-05)

`tests/parity/snapshot-mirror-structural-parity.test.ts` was retired when FR-R7-05 replaced the hand-maintained host/webview snapshot mirror with `webview-ui/src/lib/generated/snapshot-mirror.ts` emitted from `scripts/contracts/snapshot-descriptors.mjs`.

- **Why the former gate is redundant**: both `src/contracts/generated/snapshot-types.ts` (re-exported by `src/ui/sidebar/snapshot.ts`) and `webview-ui/src/lib/generated/snapshot-mirror.ts` (re-exported by `webview-ui/src/lib/snapshot-types.ts`) are generated from the same descriptor file.
- **What now enforces the invariant**:
  1. `npm run contracts:check` (verified by negative controls in `tests/contract/action-keys-generation.test.ts`) fails whenever any generated host or webview artifact drifts from its descriptor.
  2. `tests/contract/sidebar-ipc-schema-validation.test.ts` validates real host snapshots (`buildIdleSnapshot`, the populated visual fixture, and live `StateProjector` output) against the generated Draft 2020-12 JSON Schema.
  3. `tests/lint/snapshot-mirror-census.test.ts` ensures remaining webview-local declarations in `webview-ui/src/lib/snapshot-types.ts` do not restate host types and verifies union-superset parity across both `snapshot-types.ts` and `generated/snapshot-mirror.ts`.
