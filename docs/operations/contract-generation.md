# Generate and verify shared contracts

Schegent's handwritten TypeScript remains the runtime source of truth. The
contract generator extracts selected literals and interface metadata into
reviewable artifacts shared with tests and the webview. Generated JSON schemas
are parity catalogs; they do not replace the handwritten runtime validators.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: src/contracts/runtime-validators.ts -->

## Commands

Run these commands from the repository root:

```bash
npm run contracts:generate
npm run contracts:check
```

`contracts:generate` writes the current generated set. `contracts:check` runs
the same derivation with `--check`, writes nothing, and exits non-zero if any
artifact is missing or byte-for-byte stale. The check is the first target in
`verify:all`, and the pull-request, CI, and release workflows run that
consolidated gate.

<!-- Source: package.json -->
<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: ../release/actions-terminal-record.md -->

## Generated artifacts

The generator currently owns ten files:

```text
src/contracts/generated/
├── boundary-contracts.ts
└── schemas/
    ├── audit-events.schema.json
    ├── backend-runner.schema.json
    ├── contract-families.json
    ├── queue.schema.json
    ├── settings.schema.json
    ├── sidebar-ipc.schema.json
    └── state.schema.json

webview-ui/src/lib/
├── fatal-signature-registry.ts
└── retry-condition.ts
```

Do not edit these files by hand. Change the authoritative source, regenerate,
and review the resulting diff. The TypeScript outputs carry generated banners;
the JSON outputs carry generator and source metadata.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: src/contracts/generated/boundary-contracts.ts -->
<!-- Source: src/contracts/generated/schemas/contract-families.json -->

## What each contract family contains

| Family | Authoritative inputs | Generated projection |
| --- | --- | --- |
| Sidebar IPC | `src/contracts/sidebar-ipc.ts`, `src/ui/sidebar/snapshot.ts` | Command types, host-message types, IPC schema version, and `WorkflowSnapshot` field metadata. |
| Settings | `package.json`, with `src/config/settings-schema.ts` named as the parity source | Sorted `schegent.*` keys plus contribution type, default, scope, enum, bounds, pattern, and item constraints. |
| Queue | `src/contracts/queue-snapshot.ts`, `src/queue/feature-request.ts` | Queue status literals, FeatureRequest status literals, and FeatureRequest/QueueState field metadata. |
| Workflow state | `src/contracts/state-schema.ts`, `src/state/workflow-run.ts` | State schema version, run statuses, pause/retry causes, and `WorkflowRun` field metadata. |
| Audit events | `src/contracts/audit-events.ts` | Audit schema version, exhaustive event literals, and `warn-and-preserve` unknown-event policy. |
| Backend runner | `src/contracts/backend-runner.ts`, `src/runner/invocation-result.ts` | `InvocationRequest` and `RawInvocationOutput` field metadata. |
| Raw transcript bytes | `src/audit/raw-transcript-writer.ts` | No schema or binding; the manifest records this family as `typescript-only`. |

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: src/contracts/generated/schemas/contract-families.json -->

`boundary-contracts.ts` consolidates the extracted sidebar, host-message,
audit, setting, queue, FeatureRequest, and WorkflowRun literals plus the family
manifest. The six `.schema.json` files use JSON Schema draft 2020-12 syntax to
describe these projections. An interface projection is an ordered list of
`{name, optional, type}` records; it is not a complete wire-value validator.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: src/contracts/generated/boundary-contracts.ts -->

Raw transcript bytes are deliberately excluded from UI-facing generation.
They contain unredacted sink-only diagnostics and must not become a cross-boundary
payload merely because the generator can enumerate other contract families.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: tests/unit/contracts/generated-contracts.test.ts -->

## Generated webview sources

The two webview files have different generation modes:

- `webview-ui/src/lib/retry-condition.ts` is the complete host
  `src/lib/retry-condition.ts` source under a generated banner.
- `webview-ui/src/lib/fatal-signature-registry.ts` is a named AST projection.
  It includes the shared types, stream literals, and signature registry, but
  intentionally excludes host-only matching and classification logic.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: tests/parity/retry-condition-parity.test.ts -->
<!-- Source: tests/parity/fatal-signatures-parity.test.ts -->

The fatal-signature projection selects top-level declarations by name and emits
them in source order. If a selected declaration is renamed or removed,
generation fails rather than widening the copied region or silently dropping
the declaration.

<!-- Source: scripts/generate-contract-schemas.mjs -->

## Change workflow

1. Edit the handwritten source of truth. Do not begin in `generated/` or either
   generated webview file.
2. Run `npm run contracts:generate`.
3. Review every generated diff. Confirm literal additions/removals, optionality,
   schema versions, setting defaults/bounds, and family metadata match the
   intended boundary change.
4. Run `npm run contracts:check` to prove the checked-in output is fresh.
5. Run the contract and parity tests appropriate to the change. Before opening
   a pull request, run `npm run verify:all`.

<!-- Source: package.json -->
<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: tests/unit/contracts/generated-contracts.test.ts -->

Regeneration is required after any change to:

- sidebar command or host-message literal arrays;
- `WorkflowSnapshot` fields or IPC schema version;
- `schegent.*` contribution keys, defaults, scopes, patterns, or numeric bounds;
- queue, FeatureRequest, or WorkflowRun statuses and projected fields;
- state or audit schema versions, audit event literals, or unknown-event policy;
- backend invocation request/output fields;
- retry-condition host source; or
- any declaration included by the fatal-signature projection.

<!-- Source: scripts/generate-contract-schemas.mjs -->

## Failure messages

In check mode, freshness failures are explicit:

```text
Generated contract artifacts are stale.
- missing generated file: <path>
- stale generated file: <path>
Run: npm run contracts:generate
```

A missing source symbol, unsupported AST shape, circular constant-array spread,
or unreadable input fails generation immediately with its source path. The
generator also refuses TypeScript output that does not parse and JSON artifacts
whose required contract collections are empty.

<!-- Source: scripts/generate-contract-schemas.mjs -->

`contracts:check` proves that committed output matches this generator. That is
not the same as proving the generator's design is semantically complete: a
deterministic generator defect can produce stable output. Parse and non-empty
guards catch two high-risk forms of that defect; tests and human diff review
remain required for meaning.

<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: tests/unit/contracts/generated-contracts.test.ts -->

## Verification coverage

`tests/unit/contracts/generated-contracts.test.ts` reruns check mode, compares
generated sidebar/audit literals with their authoritative modules, pins the
unknown-event policy, verifies the complete family set, and confirms raw
transcript bytes have no UI schema. Separate parity tests protect the retry
condition mirror and fatal-signature projection. The contract-module
reachability lint gate additionally rejects contract modules that appear
authoritative but have no consumer outside themselves and the barrel.

<!-- Source: tests/unit/contracts/generated-contracts.test.ts -->
<!-- Source: tests/parity/retry-condition-parity.test.ts -->
<!-- Source: tests/parity/fatal-signatures-parity.test.ts -->
<!-- Source: tests/lint/contracts-module-reachability.test.ts -->
