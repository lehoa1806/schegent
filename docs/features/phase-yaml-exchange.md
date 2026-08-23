# Process YAML exchange format

Schegent exports and imports portable YAML for four resource kinds: `Phase`, `Pipeline`, `Workflow`, and `ModelCatalog`. Every supported document declares `apiVersion: schegent/v1`; decoded input is limited to 1,048,576 bytes before parsing.

<!-- Source: src/services/process-yaml/types.ts -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->

## Document families

| `kind` | Root identity/body | Optional dependency payload |
|---|---|---|
| `Phase` | `metadata.phaseId`, `metadata.name`, numeric `metadata.version`, optional description; one `spec.instruction` or `spec.skill` plus authored optional Phase fields | None |
| `Pipeline` | `metadata.id`, name, version, optional description; ordered Phase IDs, ports, bindings, defaults, and recommendations in `spec` | `included.phases` |
| `Workflow` | `metadata.id`, name, version, optional description; nodes, connections, and start-node IDs in `spec` | Flat `included.pipelines` and `included.phases` closure |
| `ModelCatalog` | Backend groups with model identifiers | None |

An absent optional value remains absent during Phase mapping. Phase `retryCondition` is transported as inert text, and `promptVersion` and `sourceScope` are host-resolved fields that are not part of the portable Phase document. The author fields `sideEffects` and `evidencePolicy` are carried in both directions when present.

<!-- Source: src/services/process-yaml/types.ts -->
<!-- Source: src/services/process-yaml/phase-yaml-mapper.ts -->
<!-- Source: src/services/process-yaml/pipeline-document.ts -->
<!-- Source: src/services/process-yaml/workflow-document.ts -->
<!-- Source: src/services/process-yaml/model-catalog-yaml-mapper.ts -->

## Closed YAML subset

The parser accepts the block-style mapping and sequence shapes required by the four schemas. Indentation is exactly two spaces. The scanner refuses tabs, anchors, aliases, merge keys, tags, directives, flow-style collections, multiple documents, and unsupported scalar forms instead of delegating them to a general YAML evaluator.

Document-level refusal codes are:

- `unreadable` for invalid UTF-8 or a leading byte-order mark;
- `too-large` for decoded input over the byte limit;
- `unsupported-version` or `unsupported-kind` for unknown root declarations;
- `disallowed-syntax` or `multi-document` for syntax outside the subset;
- `duplicate-id` for duplicate resource identity inside a package;
- `graph-cycle` for a cyclic Workflow graph;
- `empty` when no resource is declared.

A document-level refusal produces no partial import plan.

<!-- Source: src/services/process-yaml/yaml-scanner.ts -->
<!-- Source: src/services/process-yaml/yaml-parser.ts -->
<!-- Source: src/services/process-yaml/types.ts -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->

## Export contract

`CMD_EXPORT_PROCESS_YAML` carries one of these exact selections:

| Resource | Required selection fields |
|---|---|
| Phase | `{ resourceKind: 'phase', resourceId }` |
| Pipeline | `{ resourceKind: 'pipeline', resourceId, inclusion }`, where inclusion is `references-only` or `include-referenced` |
| Workflow | `{ resourceKind: 'workflow', resourceId, inclusion }`, where inclusion is `references-only`, `include-pipelines`, or `include-closure` |
| Model Catalog | `{ resourceKind: 'modelCatalog' }` |

Export resolves the selected definition from the effective catalog. Inclusion modes are all-or-nothing at their requested depth: an unresolved required dependency returns `dependency-does-not-resolve` with the first unresolved Phase or Pipeline rather than emitting a partial closure. Other unavailable reasons are `not-found` and `does-not-resolve`.

The host opens the save dialog and reports only `saved`, `canceled`, `unavailable`, or a bounded `failed` message. The webview supplies no output path and receives none.

<!-- Source: src/contracts/sidebar-ipc/process-yaml.ts -->
<!-- Source: src/contracts/validators/process-yaml.ts -->
<!-- Source: src/services/process-yaml/export-service.ts -->
<!-- Source: tests/unit/contracts/process-yaml-no-paths.test.ts -->

## Import preflight

`CMD_PREFLIGHT_PROCESS_YAML` requires the empty payload `{}`. The host opens a document picker, reads the selected bytes, dispatches on the document's own `kind`, and returns one of `canceled`, `refused`, `planned`, or `failed`. No file location or document bytes cross the webview IPC boundary.

A planned document contains one row per declared resource. Each row has one closed outcome:

| Outcome | Meaning |
|---|---|
| `import` | The definition is valid and available for the eventual publish request. |
| `skip` | The identity is already claimed by a stored row or model entry; the row records its presence/reason. |
| `blocked` | The definition itself is valid but a required Phase or Pipeline dependency is absent, unresolvable, or transitively blocked. |
| `invalid` | The resource has validation defects; `totalDefects` records the uncapped count. |

The plan records the catalog revisions against which it was computed. The later catalog publish is a separate mutation and must use those expected revisions; capability checks are re-evaluated at commit rather than trusted from the preview alone.

<!-- Source: src/contracts/sidebar-ipc/process-yaml.ts -->
<!-- Source: src/services/process-yaml/types.ts -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->
<!-- Source: src/services/process-yaml/import-planner.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-preflight-process-yaml.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->

## Boundary guarantees

- Export and preflight are read/UI operations; publishing an import plan is the catalog mutation.
- Unknown fields and illegal resource-kind/inclusion combinations are refused at the command boundary.
- Identifiers and displayed diagnostics are sanitized and bounded before they cross IPC; the non-rendered definition body remains verbatim for the validated publish command.
- Parsing and planning return typed error values rather than executing document content.

<!-- Source: src/contracts/validators/process-yaml.ts -->
<!-- Source: src/services/process-yaml/types.ts -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
