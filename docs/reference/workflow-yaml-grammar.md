# Composable Workflow YAML grammar (`FR-R5-F04`)

This reference specifies the canonical key ordering, closed field sets, and validation boundaries for `kind: Workflow` documents under `apiVersion: schegent/v1`. For the overview of process YAML exchange and preflight, see [Process YAML exchange format](../features/phase-yaml-exchange.md).

<!-- Source: src/services/process-yaml/workflow-document.ts -->
<!-- Source: src/services/process-yaml/yaml-serializer.ts -->
<!-- Source: src/config/workflow-definition-validator.ts -->
<!-- Source: src/services/process-yaml/package-reader.ts -->
<!-- Source: src/services/process-yaml/workflow-export-closure.ts -->
<!-- Source: src/config/workflow-graph-validator.ts -->
<!-- Source: src/config/workflow-closure-resolver.ts -->
<!-- Source: src/contracts/workflow-definitions.ts -->

## Reading and writing

A Workflow document is checked in two passes. The reader parses the closed YAML subset and maps the document onto a Workflow definition, and the definition validator checks the shape of every key on this page. The cross-reference pass then checks the definition against the Phases and Workflows it names; it runs when a package is resolved for import, in the headless definition API, and when the catalog loads. The YAML dialect and the document-level refusals (`unsupported-version`, `unsupported-kind`, `disallowed-syntax`, `multi-document`, `duplicate-id`, `graph-cycle` and the others) are specified in [Process YAML exchange format](../features/phase-yaml-exchange.md#closed-yaml-subset) and are not repeated here.

- **Key order.** The reader accepts the keys of a mapping in any order. The exporter writes them in the canonical order of the table below, so a document authored in another order comes back in canonical order when it is exported.
- **Closed key sets.** A mapping admits only the keys listed for it. An unknown key is refused with `unknown-field`. A condition or operand mapping reports `unsupported-condition` instead, and `executionDefaults` reports `execution-defaults-unknown-field`. `derivedInputs` and `derivedOutputs` are unknown keys: derived ports are computed and never stored.
- **Defect paths.** A defect is reported at a positional path such as `connections[2].to` or `nodes[0].nodeId`. A metadata defect is reported at the bare key (`id`, `name`, `description`, `version`). One document can report several defects.
- **Absent keys.** An absent required key is refused with the code of its value rule, so an absent `name` is `invalid-length` and an absent port `type` is `invalid-enum`. The tables name the exceptions: `required`, `object-required`, `non-empty-required` and `invalid-start-set`.
- **Omitted keys.** The exporter leaves out an absent optional key, an empty `inputs`, `outputs`, `connections`, `bindings` or `recommendedNext` list, an `executionDefaults` mapping with no field set, and an empty `included`. It writes a present `false` verbatim. `nodes` and `startNodeIds` are always written. A Workflow with no `connections` key is valid.
- **Scalar typing.** A quoted scalar is always text. An unquoted scalar is a number when it is an integer or a decimal that prints back unchanged (`0.75`, but `1.50` stays text), and a boolean when it is exactly `true` or `false`. So `version: "3"`, `required: "true"` and `priority: "5"` are refused (`positive-integer-required`, `boolean-required`, `invalid-range`).

Canonical key order, as the exporter writes it:

| Mapping | Keys, in order |
|---|---|
| Root | `apiVersion`, `kind`, `metadata`, `spec`, `included` |
| `metadata` | `id`, `name`, `description`, `version` |
| `spec` | `inputs`, `outputs`, `nodes`, `connections`, `bindings`, `startNodeIds`, `executionDefaults`, `recommendedNext` |
| Port (`spec.inputs[]`, `spec.outputs[]`) | `portId`, `label`, `type`, `required`, `description` |
| Node (`spec.nodes[]`) | `nodeId`, `kind`, `phaseId`, `workflowId`, `label` |
| Connection | `from`, `to`, `handoff`, `condition`, `priority`, `isDefault`, `selection` |
| Endpoint (`from`, `to`) | `nodeId`, `portId`, `kind` |
| Condition | `left`, `operator`, `right` |
| Operand (`left`) | `source`, `nodeId`, `field` |
| Binding | `kind`, `nodeId`, `inputKey`, `portId`, `outputKey`, `sourcePortId`, `type`, `required`, `label`, `source`, `selection` |
| Binding `source` | `from`, `nodeId`, `portId` |
| `executionDefaults` | `runner`, `model`, `effort`, `timeoutSeconds` |
| `included` | `workflows`, `phases` |

## Root envelope

Every composable Workflow YAML document is a top-level mapping. The exporter emits its keys in this order:

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

- `apiVersion`: required; the literal `schegent/v1`. An absent or any other value refuses the document with `unsupported-version`.
- `kind`: required; the literal `Workflow`. An absent or any other value, including the retired `Pipeline`, refuses the document with `unsupported-kind`.
- `metadata`: required mapping. Absent gives `required`; a value that is not a mapping gives `mapping-required`.
- `spec`: required mapping, with the same two codes.
- `included`: optional mapping (see [`included` section](#included-section)).

## `metadata` section

| Key | Required | Rule | Code |
|---|---|---|---|
| `id` | yes | Stored as `workflowId`. An [identifier](#identifiers): `^[a-z][a-z0-9-]{0,63}$`, with `WORKFLOW_ID_MAX_LEN` of 64. | `invalid-pattern` |
| `name` | yes | Trimmed, 1 to 80 characters (`WORKFLOW_NAME_MAX_LEN`). A blank name is refused. | `invalid-length` |
| `description` | no | At most 1024 characters (`WORKFLOW_DESCRIPTION_MAX_LEN`). | `invalid-length` |
| `version` | yes | An unquoted safe integer of at least 1. | `positive-integer-required`; `required` when absent |

## `spec` section

| Key | Required | Shape | Code when wrong |
|---|---|---|---|
| `inputs` | no | Sequence of ports. | `array-required` |
| `outputs` | no | Sequence of ports. | `array-required` |
| `nodes` | yes | Non-empty sequence of nodes. | `non-empty-required` when absent, empty or not a sequence |
| `connections` | no | Sequence of connections. | `array-required` |
| `bindings` | no | Sequence of bindings. | `array-required` |
| `startNodeIds` | yes | Non-empty sequence of node ids. | `invalid-start-set` when absent or empty |
| `executionDefaults` | no | Mapping. | `object-required` |
| `recommendedNext` | no | Sequence of Workflow ids. | `array-required` |

### Identifiers

An identifier is trimmed and must match `^[a-z][a-z0-9-]{0,63}$`: lower-case letters, digits and hyphens, starting with a letter, at most 64 characters. Port ids, node ids, node targets (`phaseId`, `workflowId`), binding keys, `startNodeIds` entries and `recommendedNext` entries are all identifiers, and a failure is `invalid-pattern`.

### Ports (`spec.inputs` and `spec.outputs`)

| Key | Required | Rule | Code |
|---|---|---|---|
| `portId` | yes | An identifier, unique within its list. | `invalid-pattern`, `duplicate-port-id` |
| `label` | yes | Trimmed, 1 to 80 characters (`WORKFLOW_LABEL_MAX_LEN`). | `invalid-length` |
| `type` | yes | Inputs: `text`, `source`, `source-list`, `local-file`, `local-folder`, `web-url`, `pipeline-output`, `repository-context`. Outputs: `markdown`, `file`, `file-set`, `structured-data`, `run-request`, `external-reference`. | `invalid-enum` |
| `required` | no | An unquoted boolean. A port is required unless it declares `required: false`. | `boolean-required` |
| `description` | no | At most 1024 characters. | `invalid-length` |

### Nodes (`spec.nodes`)

A node runs one Phase or one child Workflow. There is no bound on the number of nodes in a list; the [closure limits](#closure-limits) bound the total.

| Key | Required | Rule | Code |
|---|---|---|---|
| `nodeId` | yes | An identifier, unique within the Workflow. It is the node's address, so two nodes may name the same Phase or Workflow. | `invalid-pattern`, `duplicate-node-id` |
| `kind` | no | `phase` or `workflow`. The exporter writes it only when the stored definition carries it. It must agree with the target key. | `invalid-enum` |
| `phaseId` | one of two | An identifier naming a Phase. | `invalid-pattern` |
| `workflowId` | one of two | An identifier naming a child Workflow. | `invalid-pattern` |
| `label` | no | Trimmed, 1 to 80 characters. | `invalid-length` |

- Exactly one of `phaseId` and `workflowId` names the target. Both give `ambiguous-node-target`, and neither (with no `kind`) gives `missing-node-target`. A node with `kind: phase` and no `phaseId` gives `invalid-pattern` at `nodes[i].phaseId`.
- `pipelineId` is not a node key: it is refused with `unknown-field`.
- The Phase or child Workflow a node names must resolve: it is in the destination catalog or travels under `included`. Otherwise the cross-reference pass reports `unknown-phase` or `unknown-workflow`.

### Connections (`spec.connections`)

A connection routes control from one node to the next node, or out of the Workflow.

| Key | Required | Rule | Code |
|---|---|---|---|
| `from` | yes | Source endpoint. | `object-required` |
| `to` | yes | Destination endpoint. | `object-required` |
| `handoff` | no | `auto` (the default when absent) or `manual`. A `manual` hand-off leaves the invocation in `waiting-for-handoff` until the operator continues it. | `invalid-enum` |
| `condition` | no | A structured condition (see [Conditions](#conditions)). A connection without one is the success path: it is followed after a completed attempt and never after a failed or canceled one. | `unsupported-condition` |
| `priority` | no | A safe integer. Among the matching connections out of one node the lowest number is followed. Ties, and connections without a priority, go in authored order, after every prioritized one. | `invalid-range` |
| `isDefault` | no | An unquoted boolean. A default connection is followed only when no other connection out of the node matches. At most one per source node. | `boolean-required`, `multiple-default-branches` |
| `selection` | no | `first`, `last` or `exactlyOne`. The cross-reference pass asks for it when a connection carries a `file-set` output of one child Workflow into an input of another that is not a `source-list`. | `invalid-enum`, `selection-rule-required` |

Endpoint keys (`from` and `to`):

| Key | Rule | Code |
|---|---|---|
| `nodeId` | An identifier. A `return` endpoint may omit it, and it is then read as `return`. | `invalid-pattern` |
| `portId` | An optional identifier. When the node is a child Workflow it must name a port that Workflow declares (an output on `from`, an input on `to`). On a Phase node it is accepted as written. | `invalid-pattern`, `unresolved-endpoint` |
| `kind` | `to` only: `node` or `return`. `from` may not declare `kind`. | `invalid-enum` |

A `to` endpoint is a return endpoint when its `kind` is `return`, or when its `nodeId` is `return` and no node has that id. A return endpoint is the exit of a branch and not an edge of the graph, so it takes no part in the cycle check.

### Conditions

A condition is structured data with three keys and no string expression syntax. The operator is one of `equals`, `notEquals`, `in`, `exists`, `greaterThan`, `greaterThanOrEqual`, `lessThan` and `lessThanOrEqual`; any other value is `unsupported-condition`.

The `left` operand reads one node, which must be the connection's source node or one of its ancestors (`condition-operand-not-ancestor`, reported at `condition.left`; checked only when the graph is acyclic):

| `source` | Other keys | Reads |
|---|---|---|
| `node-status` | `nodeId` | The status the node's attempt ended with. It compares only against `completed`, `failed` and `canceled` (`WORKFLOW_NODE_TERMINAL_STATUSES`); any other value is `condition-right-invalid`. |
| `node-output` | `nodeId`, `field` | The location reference that the node's completed attempt recorded for its output named `field`, never the content behind it. `field` is dot-separated identifier segments of at most 64 characters in all; a malformed one is `condition-operand-unknown` at `condition.left.field`. |

An unknown `source` is `condition-operand-unknown` at `condition.left.source`, and so is an operand that names a node the Workflow does not declare, or a `node-output` operand on a child Workflow that declares no structured output port (a Phase node is exempt from that last test).

At run time an operand that cannot be resolved makes the condition false for every operator: the node has no recorded attempt, a `node-output` attempt did not complete, or the output was not produced.

The `right` operand is optional at the shape level, and the cross-reference pass applies these rules, reported at `condition.right` as `condition-right-invalid`:

| Operator | `right` |
|---|---|
| `exists` | None. Any `right` is refused. |
| `in` | A non-empty list of literals. |
| every other operator | One literal. |

A literal is a string, a number or a boolean. Conditions compare text in v1: a node status, or the location reference of an output. An ordering operator (`greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`), or a number or boolean literal (also as a member of an `in` list), can never match a text operand, so the cross-reference pass refuses the condition with `condition-comparison-unsupported`, reported at `condition`. The shape check still accepts the four ordering operators. A right operand that is already refused with `condition-right-invalid`, such as a number against a `node-status` operand, is not also reported as unsupported.

### Bindings (`spec.bindings`)

Bindings move data. A connection never copies a value: at run time a node receives its inputs from its input bindings (or, at a `manual` hand-off, from the operator), and a Workflow returns its public outputs through its output bindings. The cross-reference pass nonetheless counts a connection's `to.portId` as naming an input of a child Workflow, so `missing-required-input` is not raised for a port that only a connection names; the value still has to come from an input binding.

Every binding has `kind` (`input` or `output`, `invalid-enum`) and `nodeId`, an identifier naming the node it belongs to (`invalid-pattern`, and `unresolved-endpoint` when the Workflow declares no such node). A `phaseIndex` key is refused with `index-addressing-forbidden`, because bindings address a node by id and never by position. The two binding kinds share one set of admitted keys, so a key that belongs to the other kind (for example `label` on an input binding) is read without complaint and dropped.

Input binding, feeding a node's input from a Workflow input or from an earlier node:

| Key | Required | Rule | Code |
|---|---|---|---|
| `inputKey` | yes | An identifier naming the node's input. For a child Workflow node it must be a port that Workflow declares. | `invalid-pattern`, `unresolved-endpoint` |
| `type` | no | An input port type. On a binding into a Phase node it is the type the source is checked against, and without it that binding is not type-checked. On a binding into a child Workflow node the declared port's type is used instead. | `invalid-enum` |
| `required` | no | An unquoted boolean. | `boolean-required` |
| `source` | yes | `{from: workflow-input, portId}` reads a declared Workflow input (a `nodeId` here is `unknown-field`). `{from: node-output, nodeId, portId}` reads an output of another node. Any other `from` is `invalid-enum`. | `object-required` |
| `selection` | no | `first`, `last` or `exactlyOne`. At run time `first` and `last` fail on an empty collection, and `exactlyOne` fails unless the collection holds exactly one item. | `invalid-enum` |

Output binding, publishing a node's output as one of the Workflow's public outputs:

| Key | Required | Rule | Code |
|---|---|---|---|
| `portId` | yes | The public output port. When the Workflow declares outputs it must be one of them. | `invalid-pattern`, `unresolved-endpoint` |
| `outputKey` | no | An identifier naming the node's output; it defaults to `portId`. | `invalid-pattern` |
| `sourcePortId` | no | An identifier that overrides `outputKey` as the node output feeding the port. The feeding output is `sourcePortId`, else `outputKey`, else `portId`. | `invalid-pattern` |
| `type` | no | An output port type. For a Phase node it is compared with the declared output's type. | `invalid-enum` |
| `label` | no | Trimmed, 1 to 80 characters. | `invalid-length` |
| `selection` | no | `first`, `last` or `exactlyOne`, as above. | `invalid-enum` |

### `executionDefaults`, `startNodeIds` and `recommendedNext`

`executionDefaults` is advisory. The frozen run snapshot keeps it for provenance, the launch projection never reads it, and a `model` that the named runner does not offer is a catalog warning, never an error.

| Key | Rule | Code |
|---|---|---|
| `runner` | `claude`, `codex` or `agy`. | `invalid-enum` |
| `model` | Non-empty text. | `non-empty-required` |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`. | `invalid-enum` |
| `timeoutSeconds` | An integer from 1 to 3600. | `invalid-range` |

Any other key, such as `maxParallelism`, is refused with `execution-defaults-unknown-field`.

`startNodeIds` lists the nodes the Workflow may be launched at, and a launch at any other node is refused. Each entry is an identifier that names a node of `nodes`, or it is refused with `invalid-start-set` at `startNodeIds[i]`. When the Workflow runs as a child of another, it is always entered at its first entry.

`recommendedNext` lists Workflow ids to suggest after this one. Each entry is an identifier (`invalid-pattern`) and there is no bound on the count. The list is advisory: an id with no effective definition is a catalog warning, never a validation error.

## `included` section

`included` carries the resources a root Workflow needs, so a document can travel to a catalog that does not hold them. It is flat: `included.workflows` lists every transitive child Workflow once, and `included.phases` lists every distinct Phase once. The exporter writes it under `include-closure` and leaves it out under `references-only`, where the Phases and Workflows the nodes name must already exist in the destination catalog (see [Export contract](../features/phase-yaml-exchange.md#export-contract)).

| Key | Entries | Notes |
|---|---|---|
| `workflows` | Workflow bodies: `metadata` and `spec` only. | A body that declares `apiVersion` or `kind` is refused as `multi-document`. Identity is `metadata.id`, and a repeat among the root and `included.workflows` is `duplicate-id`. |
| `phases` | Phase bodies: `metadata` and `spec`. | The keys follow the [Phase definition reference](../features/custom-phases.md#phase-definition-reference). Identity is `metadata.phaseId`, and a repeat within `included.phases` is `duplicate-id`. |

- An absent `included` is valid. A present one must declare at least one of `workflows` and `phases`, or it is refused with `required`. A value that is not a mapping gives `mapping-required`, and a section that is not a sequence gives `sequence-required` at `included.<section>`.
- Any other key is refused with `unknown-field` at `included.<key>`; `included.pipelines` is one such key.
- The exporter orders `included.workflows` by first mention in a pre-order depth-first walk over each Workflow's `nodes` in declaration order, with the root excluded and a repeat listed once. It orders `included.phases` by first mention across the root and then `included.workflows` in that emitted order.
- A cyclic Workflow graph is refused as `graph-cycle` on the root and on each included Workflow.

## Closure limits

Resolving a Workflow follows every child Workflow it names, and three limits bound that walk (`workflow-closure-resolver.ts`). The cross-reference pass enforces them, and an `include-closure` export enforces them too: a closure that does not resolve, or that exceeds a limit, makes the export refuse with `dependency-does-not-resolve`.

| Limit | Constant | Value | Code when exceeded |
|---|---|---|---|
| Nesting depth; the root is depth 0, so a child may sit at most 8 levels below it | `MAX_WORKFLOW_NESTING_DEPTH` | 8 | `workflow-depth-exceeded` |
| Distinct referenced definitions: Phases plus child Workflows, each counted once | `MAX_WORKFLOW_CLOSURE_DEFINITIONS` | 64 | `workflow-closure-exceeded` |
| Expanded node occurrences: a child Workflow named twice counts its nodes twice | `MAX_WORKFLOW_EXPANDED_NODES` | 256 | `workflow-expansion-exceeded` |

Resolution also reports `workflow-inclusion-cycle` when a Workflow includes itself directly or through its children, `unknown-phase` and `unknown-workflow` when a named resource is not in the effective catalog, and `phase-invalid` and `workflow-invalid` when it exists but is invalid.

## Cross-reference checks

The cross-reference pass reads a definition that already passed the shape checks and reports the following. Fields are positional paths.

| Code | Raised when | Reported at |
|---|---|---|
| `unresolved-endpoint` | A connection or binding names a node the Workflow does not declare, a port a child Workflow does not declare, or a Workflow input or output port this Workflow does not declare. | The endpoint or binding key concerned. |
| `incompatible-port-types` | A connection (between two child Workflow ports) or a node-output binding joins an output type to an input type that does not accept it (table below); a Workflow input feeds an input of a different type; a node output or output binding disagrees with the type of the Workflow output it feeds. | The connection or binding. |
| `selection-rule-required` | A `file-set` output feeds an input that is not a `source-list`, or a `source-list` Workflow input feeds an input of another type, and no `selection` is given. | The `selection` key of the connection or binding. |
| `multiple-default-branches` | Two connections out of one node both set `isDefault: true`. | `connections[i].isDefault`, at the second. |
| `duplicate-input-binding` | Two connections name the same destination node and port in `to`, or two input bindings name the same node and `inputKey`. | `connections[i].to` or `bindings[i].inputKey`, at the first of the group. |
| `binding-source-not-ancestor` | An input binding reads another node's output, and that node has no path of connections to the bound node (acyclic graphs only). | `bindings[i].source.nodeId`. |
| `missing-required-input` | A child Workflow node has a required input port that no connection names in `to.portId` and no input binding feeds. | `nodes[i].workflowId`. |
| `missing-required-output-on-branch` | A required Workflow output is not produced on every route: no output binding names it, or some route from a start node reaches the end of a branch (a node with a return connection, or with no onward connection) without passing through a node that binds it. Acyclic graphs only, and only when the Workflow declares outputs. | `outputs[i].portId`. |
| `unreachable-node` | A node cannot be reached from any start node. | `nodes[i].nodeId`. |
| `unreachable-return` | The graph has connections to `return`, and none of their source nodes is reachable from a start node (acyclic graphs only). | `connections`. |
| `graph-cycle` | The connections form a cycle. One error is reported for each group of nodes that all reach each other. | `nodes[i].nodeId`, at one node of the group. |
| `condition-operand-unknown`, `condition-operand-not-ancestor`, `condition-right-invalid`, `condition-comparison-unsupported` | See [Conditions](#conditions). | `condition` and its keys. |

An output type is accepted by these input types (`WORKFLOW_PORT_COMPATIBILITY`). A Workflow input feeding a node input is checked for the same type instead, except that a `source-list` Workflow input may feed an input of another type when the binding gives a `selection`.

| Output type | Accepted input types |
|---|---|
| `markdown` | `text`, `source` |
| `file` | `local-file`, `source` |
| `file-set` | `local-folder`, `source-list` |
| `structured-data` | `pipeline-output` |
| `run-request` | `pipeline-output` |
| `external-reference` | `web-url`, `source` |

## Shape codes

The reader and the definition validator report these codes for a key that is absent, malformed or outside its closed set.

| Code | Meaning |
|---|---|
| `required` | A required key or section is absent. |
| `mapping-required` | A mapping was expected. |
| `sequence-required` | A sequence was expected. |
| `unknown-field` | A key is outside the closed set of its mapping. |
| `object-required` | An object was expected. |
| `array-required` | A sequence was expected. |
| `non-empty-required` | A non-empty value was expected. |
| `boolean-required` | An unquoted boolean was expected. |
| `positive-integer-required` | An unquoted integer of at least 1 was expected. |
| `invalid-range` | A number is outside its range. |
| `invalid-pattern` | Text does not match the identifier pattern. |
| `invalid-length` | Text is outside its length bounds. |
| `invalid-enum` | A value is outside its closed set. |
| `duplicate-port-id`, `duplicate-node-id` | Two ports of one list, or two nodes, share an id. |
| `ambiguous-node-target`, `missing-node-target` | A node names both a Phase and a Workflow, or neither. |
| `invalid-start-set` | `startNodeIds` is absent or empty, or an entry names no node. |
| `index-addressing-forbidden` | A binding addresses a position instead of an id. |
| `unsupported-condition` | A condition is not structured data, has an unknown key, or has an operator outside the closed set. |
| `execution-defaults-unknown-field` | `executionDefaults` has a key outside its closed set. |

## Example

The document below is canonical: reading it and writing it back reproduces it byte for byte. It is a references-only document, so the destination must already hold the Phases `review-change` and `fix-findings`, or the document must carry them under `included.phases`. Checked against a catalog that holds both, the cross-reference pass reports nothing; against an empty catalog it reports `unknown-phase` for each.

```yaml
apiVersion: schegent/v1
kind: Workflow
metadata:
  id: review-then-fix
  name: Review, then fix
  description: Review a change, then fix what the review found.
  version: 1
spec:
  inputs:
    - portId: change-brief
      label: Change brief
      type: text
      required: true
  outputs:
    - portId: review-notes
      label: Review notes
      type: markdown
  nodes:
    - nodeId: review
      kind: phase
      phaseId: review-change
      label: Review the change
    - nodeId: fix
      kind: phase
      phaseId: fix-findings
      label: Fix the findings
  connections:
    - from:
        nodeId: review
      to:
        nodeId: fix
        kind: node
      handoff: manual
      condition:
        left:
          source: node-status
          nodeId: review
        operator: equals
        right: completed
      priority: 10
    - from:
        nodeId: fix
      to:
        nodeId: return
        kind: return
  bindings:
    - kind: input
      nodeId: review
      inputKey: brief
      source:
        from: workflow-input
        portId: change-brief
    - kind: output
      nodeId: review
      portId: review-notes
      outputKey: notes
  startNodeIds:
    - review
  executionDefaults:
    runner: claude
    effort: high
    timeoutSeconds: 900
  recommendedNext:
    - release-notes
```

- The first connection holds the run at a manual hand-off before `fix`, and only when `review` ended `completed`. The second leaves the Workflow after `fix`.
- The input binding feeds the `brief` input of `review` from the Workflow input `change-brief`. The output binding publishes the `notes` output of `review` as the public output `review-notes`.
- `executionDefaults` is advisory, and `release-notes` in `recommendedNext` need not exist.
