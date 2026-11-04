# Composable Workflow YAML grammar (`FR-R5-F04`)

This reference specifies the canonical key ordering, closed field sets, and validation boundaries for `kind: Workflow` documents under `apiVersion: schegent/v1`. For the overview of process YAML exchange and preflight, see [Process YAML exchange format](../features/phase-yaml-exchange.md).

<!-- Source: src/services/process-yaml/workflow-document.ts -->
<!-- Source: src/services/process-yaml/yaml-serializer.ts -->
<!-- Source: src/config/workflow-definition-validator.ts -->

## Root envelope

Every composable Workflow YAML document is a top-level mapping with keys emitted in this exact order:

```yaml
apiVersion: schegent/v1
kind: Workflow
metadata:
  # ...
spec:
  # ...
included:
  # optional; omitted under references-only
```

- `apiVersion`: literal `schegent/v1`; any other value refuses the document with `unsupported-version`.
- `kind`: literal `Workflow`; `Pipeline` is retired and refused with `unsupported-kind`.
- `metadata`: required mapping (`id`, `name`, `version`, optional `description`).
- `spec`: required mapping (`inputs?`, `outputs?`, `nodes`, `connections`, `bindings?`, `startNodeIds`, `executionDefaults?`, `recommendedNext?`).
- `included`: optional mapping (`workflows?`, `phases?`).

## `metadata` section

Keys are emitted in order: `id`, `name`, `version`, `description`.

- `id`: mapped to `WorkflowDefinition.workflowId` (`^[a-z][a-z0-9-]*$`, 1–64 chars).
- `name`: non-empty string (1–128 chars).
- `version`: positive integer (`1..1_000_000`), unquoted in YAML.
- `description`: optional string (up to 2,048 chars).

## `spec` section

Keys are emitted in order: `inputs`, `outputs`, `nodes`, `connections`, `bindings`, `startNodeIds`, `executionDefaults`, `recommendedNext`.

### `spec.inputs` and `spec.outputs`

Each item in `spec.inputs` emits keys in order: `name`, `type`, `required`, `description`, `default`.

- `type`: `'string' | 'number' | 'boolean' | 'json' | 'artifactRef' | 'path'`.
- `required`: unquoted boolean (`true` or `false`).

Each item in `spec.outputs` emits keys in order: `name`, `type`, `required`, `description`, `from`.

- `from` (`source: 'node-output'`): emits `source`, `nodeId`, `field`.
- `from` (`source: 'workflow-input'`): emits `source`, `name`.

### `spec.nodes`

`spec.nodes` is a non-empty sequence (`1..64` nodes).

- Phase node (`kind: phase`): emits `nodeId`, `kind`, `phaseId`, optional `label`.
- Child Workflow node (`kind: workflow`): emits `nodeId`, `kind`, `workflowId`, optional `label`.
- Legacy `pipelineId` on any node is rejected with `unknown-field`.

### `spec.connections`

`spec.connections` is a sequence (`0..256` connections; may be `[]`). Each item emits keys in order: `from`, `to`, `handoff`, `condition`, `priority`, `isDefault`, `selection`.

- `from`: target `nodeId` string.
- `to`: mapping with `kind: node` (`kind`, `nodeId`) or `kind: return` (`kind`, optional `outcome`).
- `handoff`: optional mapping with `artifactRefs` (string sequence, `1..16` items) and/or `notes` (string up to 2,048 chars).
- `condition`: optional structured mapping (`left`, `operator`, `right`) with no string expression syntax.
- `priority`: optional integer (`0..1_000`).
- `isDefault`: optional boolean.
- `selection`: optional `'firstMatch' | 'allMatching' | 'exactlyOne'`.

### `spec.bindings`

Each item in `spec.bindings` emits `target` (`<nodeId>.<inputName>`) and `source` (`workflow-input`, `node-output`, or `literal`). Positional `phaseIndex` is rejected with `index-addressing-forbidden`.

### `spec.startNodeIds`, `spec.executionDefaults`, and `spec.recommendedNext`

- `startNodeIds`: non-empty string sequence of node IDs in `spec.nodes`.
- `executionDefaults`: optional mapping (`maxParallelism`, `timeoutSeconds`, `spendCapUsd`, `spendCapTokens`, `failFast`).
- `recommendedNext`: optional string sequence (`1..16` workflow IDs).

## `included` section (`include-closure`)

When present, `included` emits keys in order: `workflows`, `phases`. Any `included.pipelines` key is rejected with `unknown-field`.

- `included.workflows`: deduplicated transitive child Workflows in deterministic pre-order depth-first traversal order (`nodes[]` declaration order), excluding the root Workflow. Each entry emits `metadata` and `spec`.
- `included.phases`: deduplicated Phase definitions in first-encountered order across the root Workflow and `included.workflows`. Each entry emits `metadata` and `spec`.

