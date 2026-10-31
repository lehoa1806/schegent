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

A file over the limit is refused before it is read. For a local file the host checks the size from the open file and refuses with `too-large` without reading its contents, and otherwise reads at most one byte past the limit, so a file that grew after the check is still refused. A document from another file provider is checked with `stat` first and then read whole, because the editor's file-system API offers no ranged read; the parser's own limit still applies to what it returns. The refusal, its text and its audit row are the same whichever check noticed the size.

A Phase `capabilities` list longer than the four capabilities that exist is refused as `too-many-members` before any member is looked up, in the YAML reader and in the definition validator alike. Every such list already held an unknown or a repeated member, so nothing that was accepted is refused. A line of many spaces is scanned in time proportional to its length.

A Phase `model` is refused on import when it could not be passed to a backend as its own command-line argument: more than 128 characters (`invalid-length`), or not starting with a letter or digit and made of letters, digits and `. _ : / -` (`invalid-charset`), so `--dangerously-skip-permissions` is refused in the plan and not only at the commit. The reader and the definition validator call one check, and `tests/parity/phase-yaml-definition-parity.test.ts` holds their answers together on the boundary values of every Phase field they both check. The one listed difference is `retryCondition`: the reader never parses the expression, because it is inert text during exchange, while the definition validator parses it.

Exports write a sequence item that the reader would take for the start of a mapping entry, such as the model identifier `ollama:llama3`, double-quoted (`- "ollama:llama3"`), and a value that opens with a double quote quoted as well. The same text as a mapping value stays plain (`model: ollama:llama3`), so every other export is byte for byte what it was. The unquoted item `- ollama:llama3` is still refused on import, and `apiVersion` is unchanged: the quoted form was already accepted, and the exchange format's closed subset did not widen. Documents exported before this change that held such an item were refused on import and could not be read back.

<!-- Source: src/services/process-yaml/yaml-scanner.ts -->
<!-- Source: src/activation/process-yaml-document-read.ts -->
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
