# Run a Workflow

A **connected run** is one Workflow executed one node at a time. Each node
runs its Pipeline as an ordinary Run, and when that Run finishes, Schegent
works out which successors are eligible and offers them to you. Nothing
advances on its own: **you** choose the next node, every time.

This runbook covers the two operator actions that drive a connected run —
launching one, and continuing one. For what a Workflow *is* (nodes,
connections, conditions, start nodes) see the Workflow sections of
[Phase YAML exchange](../features/phase-yaml-exchange.md); for the
catalog permissions involved see
[Per-capability trust scopes](trust-scopes.md).

## Before you start

- **A folder must be open.** A Pipeline declares output targets, and a
  target needs somewhere to be written. Without a workspace root, both
  launch and continuation refuse with `no-workspace-root`.
- **The Workflow must be published.** Runs offers exactly what is Active —
  see "Where runs are started" below.
- **The Workflow must resolve.** It has to exist in the effective catalog
  and its graph has to be valid, including every node's Pipeline.
- **The queue has to accept the run.** A connected run's children go
  through the same single task queue as any other Run.

## Where runs are started

**Runs is where work is started, and the only place it is started.** The tab
has two sections, Pipelines and Workflows. You pick a definition, press
**Trigger**, fill in what it asks for, and press **Run**. Nothing starts on
the selection itself.

**Only Active definitions are listed.** A definition you are still drafting
does not appear in Runs, and neither does one you have deactivated. This is
not a filter you can turn off — it is what the two surfaces are for. Builder
is where a definition is written and published; Runs is where a published one
is started.

**Publishing is what makes a definition appear here.** If you have just
written a Workflow and cannot find it in Runs, you have almost certainly saved
a draft without publishing it. Go back to Builder, publish, and it appears.
The reverse holds too: deactivating a definition removes it from Runs
immediately, which is the supported way to take something out of circulation
without deleting its history.

**A run keeps executing the version it froze.** When you press Run, Schegent
records which published version it started against, and that version is what
executes — even if the run sits in the queue while you publish three more
revisions, and even if you deactivate or delete the definition afterwards.
This is why a run's behaviour will not match the Builder's current view of the
same definition, and it is deliberate: you approved one process, and that is
the one that runs. Retention respects it as well — a version a queued or
running job froze is not pruned out from under it.

## Launch a connected run

### 1. Choose a Workflow and a starting node

Only a node the Workflow declares as a start node can begin a run.
Naming any other node refuses with `node-not-startable` — a mid-graph
node is reached by continuation, not by launch.

### 2. Compose the starting node's Pipeline contract

A connected run starts by running one Pipeline, so you supply exactly
what that Pipeline needs:

| Part | What it is |
|---|---|
| Inputs | One value per declared input port, matching the port's type |
| Supplemental | Extra context: a workspace file, a folder, a URL, free text, an instruction, or a named output from a prior run |
| Outputs | One target per declared output port |
| Instructions | Optional free-text guidance for this run |

Everything is workspace-relative. You never type an absolute path, and
none is stored: paths are resolved host-side against the canonical
workspace root.

### 3. Read the refusal, if it does not start

Launch refuses in one of four ways, and each points at a different place
to fix it.

**The definition is wrong** (`rejected-definition`) — fix the Workflow,
not the form:

| Reason | Meaning |
|---|---|
| `workflow-not-found` | The identifier did not resolve against the effective catalog |
| `workflow-invalid` | It resolved, but its graph is invalid, or a node's Pipeline does not resolve |
| `node-not-startable` | The node is not one of the Workflow's declared start nodes |
| `pipeline-mismatch` | The composed request names a different Pipeline than the node does |
| `no-workspace-root` | No folder is open |

**A field is wrong** (`rejected-validation`) — fix it in the composer you
are looking at. Every failing field is reported at once, not one per
attempt. The common codes:

| Code group | Codes | What to check |
|---|---|---|
| Ports | `missing-required-input`, `unknown-input-port`, `phase-fed-input-port`, `type-mismatch`, `unknown-output-port` | The value does not match the Pipeline's declared contract |
| Paths | `path-escapes-workspace`, `file-not-found`, `file-unreadable`, `symlink-limit-exceeded` | The path must stay inside the open folder and must be readable |
| Folder bounds | `folder-file-count-exceeded`, `folder-bytes-exceeded`, `folder-extension-not-allowed` | The folder you attached is too large or holds disallowed file types; attach a narrower one |
| URLs | `url-malformed`, `url-scheme-not-allowed` | Check the scheme and the syntax |
| Outputs | `output-target-missing`, `output-target-duplicate`, `output-overwrite-unconfirmed`, `output-side-effect-unconfirmed` | Two ports cannot write the same target; overwriting and external side effects each need an explicit confirmation |
| Prior output | `prior-run-not-found`, `prior-output-not-found` | The referenced run or its named output is gone |
| Length | `instructions-too-long` | Shorten the instructions |
| Workspace | `no-workspace-root` | Open a folder |

An error message names the **field**, never a resolved absolute path. If
you mistyped a path you need to know which input was wrong, not where the
host looked for it.

**The queue refused** (`rejected-queue`) — usually transient. Wait for
the queue to drain and try again.

### 4. What a successful launch gives you

A started launch returns three things: the **connected run id**, its
**revision**, and the **queue item id** of the first child Run. The child
is an ordinary Run — it appears in the same run surfaces, produces the
same logs, and is inspected the same way as any other.

**The graph and its Pipelines are frozen at launch.** The run holds a
deep copy, not a pointer into the catalog. Editing the Workflow or one of
its Pipelines afterwards changes what the *next* run will do; it never
retargets one already in flight.

## Continue a connected run

### 1. Read the projection

The connected-run view is derived on read from the aggregate — nothing
about it is stored, so it cannot go stale against the run it describes.

Each node reports a **state**:

| State | Meaning |
|---|---|
| `completed` | Its most recent attempt finished successfully |
| `in-flight` | Its most recent attempt is still going |
| `failed` | Its most recent attempt failed |
| `canceled` | Its most recent attempt was canceled |
| `available` | Offered by the most recent decision, with no non-terminal attempt |
| `blocked` | Considered, and not offered — an incoming condition did not match |
| `unvisited` | Never considered at all |

A node that reached a terminal state **stays** in it. It does not fall
back to `available` when it becomes re-startable, because being
re-startable is an *action*, not a state.

Each node also reports:

- **`actions`** — what the host would accept right now. Empty is the
  common case. `start` is a first start; `restart` is a repeat.
- **`attemptCount`** — how many child Runs this node has had. It only
  grows.
- **the latest queue item** — so you can open that attempt in the
  ordinary Run surfaces.

The projection also carries `hydrating`, true until the aggregate and
every child Run it references have loaded. Actions offered while
hydrating are provisional; let it settle before acting on a surprising
one.

### 2. Understand why a node was not offered

After each child Run finishes, Schegent evaluates that node's outgoing
connections and records a **routing decision**: which operands it
resolved, what each connection evaluated to, whether the default
connection applied, and which connections came out eligible, in offer
order.

Conditions are structured comparisons, not expressions. Each compares one
operand — a **node's status**, or a **field of a node's output** — against
a literal using one of `equals`, `notEquals`, `in`, `exists`,
`greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`. A
node status is one of `completed`, `failed`, `canceled`.

So `blocked` always has a concrete answer: the recorded decision names
the operand that was read and the value it held. A **default connection**
is considered last and applies only when no explicit condition matched —
if the default fired, no condition on that node's other connections was
true.

### 3. Choose an offered node and submit

Continuation takes the run, the **revision your view was rendered from**,
the node, and a composed request for that node's Pipeline.

A first start is prefilled from the incoming connection's bindings; a
repeat start is prefilled from the node's own contract. Either way the
prefill is a convenience for you, not an assertion to the host: the host
receives only what you submitted, and recomputes eligibility itself. It
never takes your word for why a node is legal.

### 4. Interpret each refusal

| Outcome | Reason | What it means | What to do |
|---|---|---|---|
| `rejected-run` | `run-not-found` | No such connected run | It was removed; re-open the run list |
| `rejected-stale` | — | Your view was rendered from an older revision; the run moved underneath you | The refusal carries a **fresh projection** — the view corrects itself from it. Re-read what is offered now, then resubmit |
| `rejected-state` | `child-not-terminal` | Some child Run is still non-terminal | Wait. A connected run advances only while nothing is in flight |
| `rejected-state` | `node-not-eligible` | The host's own evaluation does not offer this node | The refusal carries a fresh projection; act on what it offers |
| `rejected-definition` | `pipeline-mismatch` | The request names a different Pipeline than the node does | Recompose against the node's Pipeline |
| `rejected-definition` | `no-workspace-root` | No folder is open | Open one |
| `rejected-validation` | — | One or more fields are wrong | Same field codes as launch, above |
| `rejected-queue` | `queue-refused` | The queue would not take the child | Wait and retry |

`rejected-stale` and `rejected-state` are the two that carry a
projection, because those are the two that mean *your picture of the run
was wrong*. The definition and validation refusals say nothing about the
run's state, so they carry nothing to correct it with.

A successful continuation returns the new **revision** and the new child
**queue item id**. Echo that revision on your next continuation.

## Repeat a node

Once a node's most recent attempt is terminal, it can be started again —
its `actions` will include `restart`. This is how you retry a failed node
after fixing the cause, or re-run a completed one with different inputs.

Each repeat is a new attempt: `attemptCount` grows, the earlier attempts'
Runs remain inspectable, and the node's state becomes that of the newest
attempt.

While any child is non-terminal, nothing can start — including a repeat.

## What never crosses the boundary

No filesystem path travels between the extension host and the panel in
either direction. A launch names a Workflow and a node by identifier; a
continuation names a run, a revision, and a node. Every path inside the
nested request is workspace-relative and resolved host-side.

No field carries content. Nothing here transports a prompt, an output
body, a pasted document, or a secret — the projection is identifiers and
states, and the aggregate it derives from holds no content either.

## References

- [Phase YAML exchange](../features/phase-yaml-exchange.md) — Workflow
  documents, nodes, connections, and conditions
- [Per-capability trust scopes](trust-scopes.md) — the capabilities a
  Workflow catalog edit requires
- [Import and export process definitions](process-yaml.md) — moving a
  Workflow between workspaces
- [Schedule multiple runs](schedule-multiple.md) — how the single task
  queue orders work
- [Debug stuck runs](debug-stuck-runs.md) — when a child Run will not
  reach a terminal state
