# Process YAML Exchange

Export a Phase or a Pipeline definition to a portable YAML document, and import
someone else's document back into your own catalog after inspecting exactly what
it would do. This is how a process definition moves between machines,
repositories, and operators without anybody pasting JSON into a settings file.

The exchange is a **transport**, not a second authoring surface. Everything an
imported Phase is allowed to be, it is allowed to be because
[Custom Phases](custom-phases.md) already allows it. The exchange adds no field,
no capability, and no path into the catalog that the Phase manager does not
already have.

Most of this page describes the Phase document, which is the simpler case and
the one every rule is stated on. A Pipeline document follows all of the same
rules and adds one thing — it can carry the Phases it references, making the file
a runnable **package**. What that changes is collected under
[Pipeline packages](#pipeline-packages); nothing before that section is different
for a Pipeline.

## When you'd use it

- A teammate wrote a `lint-and-scan` Phase you want on your machine too.
- You keep a repository of reviewed Phase definitions and want them checked in
  as readable files rather than as fragments of `settings.json`.
- You are moving to a new machine and want your user-scope Phases to come with
  you.
- You want a Phase definition in a code review, where a YAML diff is legible and
  a settings-blob diff is not.

## The document format

A document is a single YAML mapping with four top-level keys, in this order:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: lint-and-scan
  name: Lint and Scan
  version: 1
spec:
  instruction: Run the linter and the security scanner.
```

That is the minimal valid document — the three required `metadata` fields plus
exactly one directive under `spec`. Every other field is optional.

`apiVersion` and `kind` are checked first, and in that order, so a document from
a future format version is refused for its version rather than for whichever
field happens to have changed shape inside it.

### Every portable field

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: lint-and-scan
  name: Lint and Scan
  version: 3
  description: Lint, then scan, then report.
spec:
  instruction: |-
    Run the linter and the security scanner.
    If both pass, emit [SCHEGENT_STATUS: CLEAR] on the last line.
  runner: claude
  model: claude-sonnet-4-6
  effort: medium
  timeoutSeconds: 900
  loopable: true
  isRequired: false
  retryCondition: exitCode != 0 && iteration < 3
```

A Phase that runs a skill instead of an inline instruction:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: brainstorm
  name: Brainstorm
  version: 1
spec:
  skill: superpowers:brainstorming
```

`instruction` and `skill` are mutually exclusive and exactly one is required —
the same rule the Phase manager enforces when you author a row by hand.

### Field reference

| Field | Required | Type | Bound |
|---|---|---|---|
| `metadata.phaseId` | yes | string | `^[a-z][a-z0-9-]{0,63}$` |
| `metadata.name` | yes | string | 1–80 characters |
| `metadata.version` | yes | integer | ≥ 1 |
| `metadata.description` | no | string | ≤ 1024 characters |
| `spec.instruction` | one of the two | string | 1–8192 characters |
| `spec.skill` | one of the two | string | 1–256 characters |
| `spec.runner` | no | enum | `claude`, `codex`, `agy` |
| `spec.model` | no | string | non-empty |
| `spec.effort` | no | enum | `low`, `medium`, `high`, `xhigh`, `max` |
| `spec.timeoutSeconds` | no | integer | 1–3600 |
| `spec.loopable` | no | boolean | — |
| `spec.isRequired` | no | boolean | — |
| `spec.retryCondition` | no | string | non-empty |

Those bounds are not a second copy maintained by hand. The document validator
imports them from the Phase catalog's own validator, so the format cannot drift
away from what the catalog will accept. `runner: agy` with `effort: xhigh` or
`max` is rejected for the same reason it is rejected in the manager: Agy does
not have those levels.

`spec.skill` is a plain reference. An export never resolves it, inlines it, or
checks that the skill exists on your machine — a document that names a skill you
do not have imports fine and fails at run time, which is the same behavior as
typing that skill name into the manager.

`spec.retryCondition` is inert text to this feature. The exchange never parses,
evaluates, or rewrites it; the sandboxed retry-condition DSL evaluator remains
the only thing that ever reads it, at run time, exactly as for a hand-authored
Phase. See [Custom Phases](custom-phases.md) for what the DSL admits.

### One resource per document

A document declares **exactly one** subject — one Phase, or one Pipeline. There
is no resource list, no `items:`, and no multi-document stream. A file holding a
second `---` document start, or nothing at all, is refused at the document level
before any field is looked at.

This keeps the unit of exchange the same as the unit of review: one file, one
subject, one decision. A Pipeline package is not an exception: it carries the
Phases its one Pipeline references, as that Pipeline's dependencies, and you are
still reviewing and deciding on a single Pipeline.

### The subset of YAML the format reads

The exchange has its own scanner for a deliberately small subset, not a general
YAML parser. What it reads: block mappings, block sequences whose entries are
scalars or mappings, plain scalars, double-quoted scalars, block literals
(`|`, `|-`), comments, and blank lines. What it refuses outright: anchors (`&x`),
aliases (`*x`), merge keys (`<<:`), tags (`!!str`), directives (`%YAML`), flow
collections (`{a: b}`, `[a, b]`), folded scalars (`>`), single-quoted scalars,
and tab characters.

The block sequence is the one production the Pipeline format added, and it is
written one way: `- ` is exactly two characters, with the entry's body one indent
level past the dash. `-` with no space, `-` followed by two spaces, and a bare
`-` on its own line are each refused as `disallowed-syntax`. A Phase document
uses no sequences at all, and every document the Phase-only reader accepted still
parses to the same tree.

A quoted or block scalar is always text — the scanner never re-types a scalar —
so `version: "1"` is a defect rather than silently the number 1. On the way out,
the serializer quotes any value another reader would re-type, so a `model` named
`on` or `1.0` survives a round trip through a tool that is not this one.

The reason is containment. A general parser's alias and merge machinery is a
reachable amplification and aliasing surface for a file you did not write. A
subset that cannot express those constructs cannot be made to expand them.

### Exports are byte-stable

Serialization writes a fixed key order — `apiVersion`, `kind`, `metadata`,
`spec`; then `phaseId`, `name`, `version`, `description`; then `instruction`,
`skill`, `runner`, `model`, `effort`, `timeoutSeconds`, `loopable`,
`isRequired`, `retryCondition` — with a two-space indent and no other step.
Absent optional fields are omitted rather than written as `null`.

Exporting the same Phase twice produces identical bytes, so a checked-in
document only shows a diff when the Phase actually changed.

## Exporting

Each row in the Phase manager has its own **Export** control. It writes a file
you name; the suggested name is `<phaseId>.phase.yaml`.

Export reads the **effective** catalog — the definition this installation would
actually run, after precedence and validity filtering. Two consequences worth
knowing:

- A `shadowed` row's Export stays enabled, and writes the definition that
  *resolves* for that id, not the shadowed row's own contents. The row's
  `shadowed` badge already tells you it is not the one in force. Disabling the
  control would leave you with no way to obtain the definition that is.
- An `invalid` row cannot be exported: there is no valid definition to
  serialize. The control is disabled and says
  `This Phase has errors, so there is nothing valid to export.`

An unsaved draft cannot be exported either —
`Save this Phase before exporting it.` Export serializes what the catalog holds,
and a draft is not in the catalog yet.

Export changes no catalog state, so it stays available even while a Phase
mutation is pending, where every other row control is closed.

## Importing: inspect, then commit

An import is two separate steps, and the first one writes nothing.

### Step 1 — preflight

You choose a file. The host reads it once, decides what an import *would* do,
and returns a plan. Nothing is saved, and nothing about the file is retained
past that single read.

Each plan row is one of three outcomes:

| Outcome | Meaning |
|---|---|
| `import` | The document is valid and its `phaseId` is in no layer. Committing adds it. |
| `skip` | A Phase with that id is already present. Committing would not change it. |
| `invalid` | The document parsed but a field is out of bounds. The defects are listed per field. |

An `invalid` row lists its defects field by field, capped at 20 for display, and
reports the true total alongside — so a document with 50 defects says 50 rather
than looking like it had exactly 20.

A document-level refusal produces no plan at all, not a partial one.

### The skip guarantee

An import **never** overwrites an existing Phase. Not a user-scope one, not a
workspace-scope one, not an invalid one, not a shadowed one.

Presence is computed across **every layer** — `built-in`, `user`, `workspace` —
and across **every row status**, including `shadowed` and `invalid`. If any layer
holds a row with that `phaseId`, the outcome is `skip`, and the row says which
layer claims it and what status that row has:

> `Already present in the workspace layer as an invalid row, so this import would not change it.`

Including invalid rows is the point rather than an oversight. A broken row is
still an operator's authored work; an import that replaced it would erase an
edit-in-progress that its author is about to fix.

Note the deliberate asymmetry with export:

| Direction | Reads | Why |
|---|---|---|
| Export | the effective catalog | you want the definition that actually runs |
| Import presence | every layer's stored rows, every status | you want nothing of yours silently replaced |

Reading the effective catalog for presence would treat a shadowed or invalid row
as absent, and the import would then write over it.

To replace a Phase you already have, remove or rename the existing row in the
Phase manager first, or edit the document's `metadata.phaseId` before importing.

### The two capabilities an import can require

Committing an import is a Phase-catalog write, so it passes the same
per-capability trust gates as any other. Two can apply:

| Capability | When it is required |
|---|---|
| `schegent.trust.allowCustomPhases` | Always. An imported Phase is a custom Phase. |
| `schegent.trust.allowCustomRetryConditions` | Additionally, when the document declares a `spec.retryCondition`. |

A plan row whose document declares a retry condition carries the advisory
`Declares a retry condition, which the commit checks separately.` It is an
advisory, not a decision: the capability is **re-read at commit time**, never
carried over from preflight. A trust setting that changes between the two steps
is honored as of the commit.

A refusal on either gate is audited by the trust gate itself, as
`trust.capability-denied` — the same event, with the same shape, as any other
denied catalog write. See [Trust Scopes](../operations/trust-scopes.md).

### Step 2 — commit

Confirming an import sends the ordinary Phase save: the target layer as it is
stored, plus the one new row, with the revision the plan was computed against
and a declared `import` mutation intent.

That means an import inherits the catalog's existing write semantics unchanged:

- **All-or-nothing.** One write of one layer, or no write at all.
- **Revision-gated.** If the target layer changed since preflight, the save is
  rejected as `stale-catalog` and you re-run the preflight against the current
  layer. The revision gate runs *before* the trust gate, so a stale untrusted
  save tells you it is stale.
- **Validated again.** The save command's own validator is the gate. The
  document's declared values are forwarded verbatim, so a value the catalog
  would reject is rejected by the catalog, with the catalog's own message.
- **One target scope.** `user` or `workspace`, chosen by you after seeing the
  plan. `built-in` is never a save target.

An import cannot be started while a Phase mutation is outstanding —
`Save or discard your pending Phase changes before importing.` The commit sends
the whole persisted layer, so starting one with a draft open would ask you to
confirm a write that silently drops the edit you are mid-way through.

## Pipeline packages

A Pipeline document declares `kind: Pipeline` and carries the Pipeline's own
fields under `spec`. It may additionally carry an `included:` section holding the
complete definitions of the Phases its `phaseIds` name — that is what makes the
file a **package**, runnable on a machine that has none of those Phases yet.

```yaml
apiVersion: schegent/v1
kind: Pipeline
metadata:
  id: review-and-ship
  name: Review and Ship
  version: 2
spec:
  phaseIds:
    - lint-and-scan
    - ship
included:
  phases:
    - metadata:
        phaseId: lint-and-scan
        name: Lint and Scan
        version: 1
      spec:
        instruction: Run the linter and the security scanner.
```

An included Phase entry is the same `metadata` + `spec` body as a standalone
Phase document, minus the two declaration keys the root already carries. Every
Phase field rule above applies unchanged. `included` is omitted entirely when
there is nothing to include, like every other empty collection in the format.

### Choosing what an export discloses

Exporting a Pipeline asks you one question that exporting a Phase does not:

| Choice | What the file carries | When you want it |
|---|---|---|
| References only | `phaseIds` and nothing else | The recipient already has the Phases, or you do not want their text leaving. |
| Include referenced Phases | `phaseIds` plus an `included:` definition for each | The recipient should be able to run this Pipeline with nothing else. |

The choice is yours and travels with the request, because the same Pipeline is
legitimately exported both ways and only you know which the recipient needs.

Including resolves each referenced Phase against the **effective** catalog. If
one does not resolve, the export is refused and **names** the first unresolved
Phase in reference order — nothing partial is written, because a package missing
one of its Phases is exactly the file this choice exists to avoid. A
references-only export needs nothing to resolve: it writes identifiers, and an
identifier does not have to be satisfiable to be written down.

### What the plan shows

A package preflight produces one plan row per resource — one for the Pipeline,
one for each included Phase — with the same `import` / `skip` / `invalid`
outcomes, plus a fourth that only a Pipeline can have:

| Outcome | Meaning |
|---|---|
| `blocked` | The Pipeline references a Phase this catalog cannot resolve, and the package does not supply it. Committing would write a Pipeline that cannot run. |

The skip guarantee is unchanged and applies per resource: nothing you already
have is overwritten, whichever layer holds it and whatever status it has.

That produces one row pair worth recognizing, because it reads like a
contradiction and is not:

> The Phase row says `skip` — the id is already claimed.
> The Pipeline row says `blocked` on that same id — the claim does not resolve.

Both are true at once. Presence and resolution are different questions:
presence asks "would a write destroy something someone authored?" and counts
shadowed and invalid rows, because those are still authored work. Resolution asks
"can this Pipeline actually run?" and does not, because a shadowed or invalid row
is not what runs. Fix the existing row, and both go away.

### Committing a package: two writes, in order

A package commit is **two** catalog writes, not one: the Phases first, then the
Pipeline. The order is load-bearing — a Pipeline written first would, for as long
as the second write took, reference Phases the catalog did not have.

Each write carries its own revision and its own declared intent, and each passes
its own trust gate. So the two can disagree, and the outcome says so:

| Outcome | Meaning |
|---|---|
| `imported` | Both writes were accepted. |
| `partial` | The Phases landed and the Pipeline did not, or the reverse was never reached. |
| `failed` | Nothing was written. |

**A `partial` is reported, not repaired.** Nothing already written is retracted.
A compensating delete would mean this feature deciding to remove rows from your
catalog on the strength of a write it did not manage to finish — a worse outcome
than an unfinished import. Re-run the same document once the cause is addressed
and it finishes the job; the part that already landed simply reads as `skip`.

The most common cause of a `partial` is the third capability a package can
require: the Pipeline layer needs `schegent.trust.allowPipelineOverrides` on top
of the two a Phase import needs. Grant it and re-run. See
[Trust Scopes](../operations/trust-scopes.md).

## Refusal classes

Seven document-level refusals, each with a fixed operator sentence:

| Code | What you see |
|---|---|
| `unreadable` | This file could not be read as text. |
| `too-large` | This document is larger than an import will read. |
| `unsupported-version` | This document declares a format version this build does not read. |
| `unsupported-kind` | This document declares a different kind of resource. Fires for any `kind:` other than `Phase` or `Pipeline`. |
| `disallowed-syntax` | This document uses YAML the Phase format does not accept. |
| `multi-document` | This file holds more than one document, and an import reads exactly one. |
| `empty` | This document declares no Phase. |

`unreadable` covers invalid UTF-8 and a leading byte-order mark. Neither is
repaired: silently stripping a BOM would mean accepting a file whose encoding
the exchange cannot vouch for.

`too-large` fires at **1 MiB of decoded text**, checked *before* the scanner is
entered. A file over the bound is never parsed, so an oversized document cannot
spend parse time to be refused.

## What never crosses the boundary

By construction, not by convention:

- **No filesystem path.** The file picker runs host-side; the path never reaches
  the webview, and no plan row, audit payload, or error message carries one. An
  export write failure reports the generic `Could not write the document.`
  precisely because an adapter's own error text can name the location.
- **No session, run, or evidence data.** A document carries a Phase definition
  and nothing else. There is no run history, no transcript, no `runId`.
- **No policy or trust state.** A document cannot grant itself a capability,
  raise a trust scope, or declare which scope it should land in. The target
  scope is your choice, made in your window, after the plan.
- **No provenance link.** An imported Phase is a Phase. It is not marked as
  imported, does not remember where it came from, and behaves identically to one
  you typed in.
- **No retained state.** The exchange persists nothing of its own — no workspace
  state key, no cache between preflight and commit, no last-export memory.

## Audit events

Three events, all metadata-only:

| Event | When |
|---|---|
| `process-exchange-export` | Every export attempt, whatever its outcome — `saved`, `canceled`, `failed`, or `unavailable`. |
| `process-exchange-import-refused` | A preflight refuses a document at the document level, **or** a confirmed package write is refused at any gate. |
| `process-exchange-import-committed` | One catalog layer of a package import landed. |

The payload carries the operation (`export`, `import-preflight`, or
`import-commit`), the resource kind (`phase` or `pipeline`), the resource ids
involved, the scope, the outcomes, and counts. It does not carry document
contents, field values, instruction text, port labels, a file name, or a
filesystem path. An export additionally counts `includedPhases` — how many
complete Phase definitions actually left this installation — because without it
a package export and a references-only export record identically, and the
difference between them is precisely whether someone else's Phase text was
disclosed.

A successful **single-Phase** import is still not audited by this feature. It is
audited as what it is — a Phase catalog save — by the save path that performs it,
and one write either landed or it did not, so the catalog itself is the record.

A **package** import is different, and that is the whole reason the third event
exists. It writes two layers that can succeed independently, so a workspace
holding the Phases and no Pipeline is indistinguishable from an operator who
imported the Phases alone. The commit and refusal records are what tell those
apart after the fact — which is also why a refusal is recorded at *every* gate a
package write can be turned away by. An unaudited refusal is indistinguishable
from an operator who closed the dialog.

A capability denial is **not** one of these. It stays `trust.capability-denied`,
the same event as any other denied catalog write, because it is a different
decision taken at a different time about a different thing.

## Things to watch out for

- **Importing your own export is a no-op.** The id is already present, so the
  plan is a `skip`. That is correct behavior, not a failure.
- **`version` is yours to manage.** Nothing bumps it for you. A document
  exported at `version: 3` imports at `version: 3`.
- **`model` is not validated against your installed models.** A document naming
  a model your backend does not offer imports fine; the manager shows it as
  unavailable, exactly as for a hand-authored row.
- **Round-tripping normalizes formatting, not content.** Import a document that
  used a different (still legal) scalar style and re-export it, and the bytes
  will be the serializer's canonical form. The Phase is unchanged.
- **`built-in` ids are claimed.** A document whose `phaseId` matches a built-in
  Phase skips, because the built-in layer holds that id. To shadow a built-in,
  author the override in the Phase manager, where the shadowing is explicit.

## Troubleshooting

**The Import button is disabled.**
The reason is shown next to it, and there are three:
`This workspace is not trusted, so an imported Phase could not be saved.`,
`A Phase save is still in progress.`, or
`Save or discard your pending Phase changes before importing.`

**Confirm is disabled after a successful preflight.**
Checked in order: a commit or a validation is still running; the document was
refused; the preflight was canceled or failed; no plan has been computed; the
plan has nothing to import (every row is `skip` or `invalid`); the plan holds
more than one Phase; or no target scope has been chosen yet. The surface says
which.

**The commit failed with `stale-catalog`.**
The target layer changed between your preflight and your confirm — another
window, a settings edit, or a sync. Re-run the preflight so the plan is computed
against the current layer, then confirm again. Nothing was written.

**The commit was refused for trust.**
Check `schegent.trust.allowCustomPhases`, and — if the document declares a
`retryCondition` — `schegent.trust.allowCustomRetryConditions`. Both are read at
commit time, so a setting changed after preflight takes effect. Grep the audit
log for the denial:

```bash
grep '"eventType":"trust.capability-denied"' .schegent/audit.log | jq .
```

**The document was refused for `disallowed-syntax` and looks like valid YAML.**
It probably is valid YAML. The exchange reads a subset — no anchors, aliases,
merge keys, tags, directives, flow collections, sequences, or tabs. Rewrite the
construct as a plain block mapping.

**A field I set was dropped on export.**
Only the fields in the reference table above are portable. Anything the Phase
catalog does not model as a portable Phase field is not in the format.

## References

- Specification: [specs/084-phase-yaml-exchange/spec.md](../../../specs/084-phase-yaml-exchange/spec.md)
- Grammar: [specs/084-phase-yaml-exchange/contracts/phase-yaml-grammar.ebnf](../../../specs/084-phase-yaml-exchange/contracts/phase-yaml-grammar.ebnf)
- Data model: [specs/084-phase-yaml-exchange/data-model.md](../../../specs/084-phase-yaml-exchange/data-model.md)
- Pipeline packages — specification: [specs/085-pipeline-package-exchange/spec.md](../../../specs/085-pipeline-package-exchange/spec.md)
- Pipeline packages — grammar: [specs/085-pipeline-package-exchange/contracts/yaml-grammar.md](../../../specs/085-pipeline-package-exchange/contracts/yaml-grammar.md)
- Pipeline packages — IPC contract: [specs/085-pipeline-package-exchange/contracts/process-yaml-ipc.md](../../../specs/085-pipeline-package-exchange/contracts/process-yaml-ipc.md)
- Pipeline packages — data model: [specs/085-pipeline-package-exchange/data-model.md](../../../specs/085-pipeline-package-exchange/data-model.md)
- [Custom Phases](custom-phases.md) — authoring a Phase directly, and the retry-condition DSL.
- [Trust Scopes](../operations/trust-scopes.md) — the per-capability gates a commit passes.
- [Glossary](../reference/glossary.md) — layer, effective catalog, revision, mutation intent.
