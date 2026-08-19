# Import and Export Process Definitions

Schegent moves Phases, Pipelines, and Workflows between workspaces as
portable YAML documents. This runbook is the **operator procedure** for
both directions: what to click, what each screen is telling you, and what
to do about it.

It deliberately does not restate the document format, the refusal
taxonomy, or the closed YAML subset — those live in
[Phase YAML exchange](../features/phase-yaml-exchange.md). Read that when
you need to know what a document *is*; read this when you need to move
one.

## Before you start

An import is a catalog write, so it is gated by the same per-capability
trust scopes as any other catalog edit. Which scopes a document needs
depends on what it carries — see
[Per-capability trust scopes](trust-scopes.md), which walks the
one-scope, three-scope, and four-scope cases in order.

An **export** is a read. It needs no trust scope and asks for no
confirmation.

## The first import

On a fresh install the catalog is empty — no Phases, no Pipelines, no
Workflows, no Models — and import is the only way anything gets into it.
Nothing runs until you do one; a launch against an empty catalog is
refused with `catalog-empty` rather than started against something you
never chose.

The extension ships process documents under `examples/` for exactly this:

| Document | Supplies |
|---|---|
| `speckit-new-feature.pipeline.yaml` | one Pipeline and the nine Phases it names |
| `speckit-bugfix.pipeline.yaml` | one Pipeline and the five Phases it names |
| `model-catalog.yaml` | per-backend model identifiers |

They are ordinary documents with no privileged status. Importing one
produces `import` rows on a fresh catalog and `skip` rows on a second
run, exactly as any document you wrote would — the built-in layer is
permanently empty, so it claims no id and forces no skips.

## Import a document

### 1. Open the preview

Press **Import…** in the process catalog surface. Schegent opens a file
dialog, reads the file you choose, and shows you a plan. Nothing is
written yet — preview is read-only, and the button that writes is a
separate, later press.

You do not classify the file first. The document declares its own
`kind:`, and Schegent dispatches on that, so one **Import…** button
handles a Phase, a Pipeline package, and a Workflow package alike.

If the whole document is unusable, you get a **refusal** instead of a
plan. A refusal is document-level: nothing in the file is planned,
because the file could not be trusted enough to plan from.

| Refusal | What happened | What to do |
|---|---|---|
| `unreadable` | Not valid UTF-8, or it starts with a byte-order mark | Re-save the file as UTF-8 without a BOM |
| `too-large` | Over the size bound, refused before parsing | Split the package, or export a narrower closure |
| `unsupported-version` | `apiVersion` is absent or is not the supported one | The document came from a different Schegent generation; re-export it from the source workspace |
| `unsupported-kind` | `kind` is absent or is not a kind Schegent imports | Check the top of the file; a hand-edited document often loses it |
| `disallowed-syntax` | The file uses YAML outside the accepted subset — an anchor, alias, merge key, tag, directive, flow collection, folded or single-quoted scalar, or a tab | Rewrite that line in plain block YAML. Hand-authored files hit this most often on `[a, b]`; write a block sequence instead |
| `multi-document` | A second document start, an end marker, or a sequence of resources | One resource tree per file |
| `duplicate-id` | Two resources in the same package declare the same id | Schegent will not guess which one you meant — fix the source and re-export |

### 2. Read the plan

The plan is one row per declared resource, plus a count per outcome. The
four counts always sum to the number of rows, so nothing in the document
is silently absent from the plan.

Each row lands in exactly one of four outcomes:

| Outcome | What it means | Will it be written? |
|---|---|---|
| `import` | New to this workspace, and valid | Yes |
| `skip` | Something already claims this id | No |
| `blocked` | This resource is fine; something it depends on is not | No |
| `invalid` | This resource is itself defective | No |

**`skip` is a guarantee, not a warning.** Schegent resolves presence
against the *stored* rows of every layer — built-in, user, and workspace
— at every status, including rows that are shadowed and rows that are
currently invalid. If any layer holds that id, the import skips it. The
row tells you which scope holds it and what that stored row's status is.
The effect is that an import never overwrites work you authored,
including a broken definition you are half-way through fixing.

**`blocked` names what it is waiting on**, and the reason tells you which
kind of repair is needed:

| Reason | Meaning | What to do |
|---|---|---|
| `dependency-absent` | The named Phase or Pipeline is in no catalog layer, and this document does not supply it | Import the dependency first, or re-export the source as a package that includes it |
| `dependency-unresolvable` | A stored row claims that id, but it is not effective — it is shadowed by another layer, or it is invalid | Repair or unshadow that row; nothing about this document will fix it |
| `dependency-blocked` | The dependency resolves but is itself blocked | Ignore this row and fix the root cause it points at via `via` — this row is propagation, not a separate fault |

**`invalid` lists the defects** with the field each one is about. The row
also carries the total defect count *before* the display cap, so a
badly-broken resource says "42 defects" rather than showing you the cap's
worth and looking complete.

An `invalid` row has no id when the document did not give it a
well-formed one.

### 3. Confirm

Choose a target scope — **user** or **workspace** — and press **Confirm
import**. Scope is chosen at confirm time, not at preview, because the
same previewed plan is legitimately committed into either.

Two things are re-evaluated at this moment rather than inherited from the
preview:

- **Trust capabilities.** A scope you granted or revoked between
  previewing and confirming is honored as of the confirm. The preview's
  note that a document "requires the retry-condition capability" is
  advisory; the gate is the confirm.
- **Catalog freshness.** The plan carries the revision of each layer it
  was computed against. If that layer changed underneath you — another
  window, a settings edit — the write is refused as stale rather than
  applied to a catalog the plan never described. Re-run the preview and
  confirm again.

A package commits as **ordered writes, one per catalog layer**: Phases
first, then Pipelines, then Workflows. The order is dependency order — a
Pipeline's bindings are only satisfiable once its Phases are effective,
and a Workflow's nodes only resolve once its Pipelines are. A document
that supplies fewer layers performs fewer writes.

### 4. Read the outcome

The result is one of three words.

| Outcome | Meaning |
|---|---|
| `imported` | Every layer the document supplied was written |
| `partial` | Some layers were written and a later one was not |
| `failed` | Nothing was written |

**`partial` is a real, expected outcome — not a corrupted state.** The
layers commit independently, and the first rejection stops the sequence
where it stands. Where it stopped tells you what was missing:

- Phases written, no Pipeline → the Pipeline layer was refused (most
  often `allowPipelineOverrides`).
- Phases and Pipelines written, no Workflow → the Workflow layer was
  refused (most often `allowWorkflowOverrides`).

**Whatever landed stays written.** Schegent does not undo a partial
import. A compensating delete would remove rows you may already have
edited, and it would be a destructive write performed on a failure path
that nobody confirmed.

**Re-running the same document is the recovery, at any depth.** Fix the
cause — grant the missing scope, supply the missing dependency, repair
the shadowed row — and import the same file again. The presence scan
turns everything that already landed into `skip` rows, so the retry
writes only the part that did not. This is self-healing regardless of how
far the first attempt got.

## Export a document

### 1. Choose what to export

Press **Export** on the Phase, Pipeline, or Workflow you want to move.

Export reads the **effective** catalog — the definition that would
actually run, after layer shadowing. If a workspace row shadows a user
row, you export the workspace row, because that is the one that is real
in this workspace.

Two situations produce an **unavailable** result rather than a document:

| Reason | Meaning |
|---|---|
| `not-found` | No row in any layer carries that id — most commonly an unsaved draft. Save it first |
| `does-not-resolve` | A row exists, but the effective catalog has no valid definition for it. Repair it first |
| `dependency-does-not-resolve` | The resource itself resolves, but something it references does not. The result names the first unresolved dependency in reference order |

The third only occurs under an inclusion mode that requires that level to
resolve. A references-only export never requires any dependency to
resolve, so it succeeds where a deeper export cannot.

### 2. Choose how much travels with it

A Phase has no references, so there is no choice to make — you get one
document.

A **Pipeline** has one level of dependency below it:

| Mode | What the document carries | Use when |
|---|---|---|
| `references-only` | The Pipeline alone, naming its Phases by id | The recipient already has those Phases |
| `include-referenced` | The Pipeline plus the definitions of every Phase it references | The recipient has nothing, or you want one self-contained file |

A **Workflow** has two levels, so it has three modes rather than two:

| Mode | What the document carries | Use when |
|---|---|---|
| `references-only` | The Workflow alone | The recipient already has the whole tree |
| `include-pipelines` | The Workflow plus its referenced Pipelines, without their Phases | The Phases are shared and you are only moving the composition |
| `include-closure` | The Workflow, its Pipelines, and those Pipelines' Phases | The recipient has nothing |

The choice travels with the request rather than being inferred. The same
Workflow is legitimately exported at all three depths, and only you know
how much the recipient already has.

A self-contained package is worth preferring when in doubt: it costs
bytes, and it removes an entire class of `blocked` rows on the receiving
end.

### 3. Where the document goes

Schegent opens its own save dialog. You choose the location there.

The result reports only what happened, never where:

| Outcome | Meaning |
|---|---|
| `saved` | A document was written |
| `canceled` | You dismissed the save dialog. Nothing was written |
| `unavailable` | See the table in step 1 |
| `failed` | The write did not complete |

A `failed` export reports a generic message — "Could not write the
document." — and does not name the path it tried. Overwrite consent
belongs to the save dialog, so export registers no separate confirmation
of its own; dismissing the dialog is the cancel.

If a write fails repeatedly, check the destination directory's
permissions and free space from a terminal. Schegent will not tell you
which directory it was, by design.

## Model Catalog

The Model Catalog — the list of model ids Schegent offers per backend —
moves through the same **Import…**/**Export** buttons and the same file
dialogs as a Phase, Pipeline, or Workflow, but several of the choices
above do not apply to it. This section only covers where it differs; the
document lifecycle (preview before write, confirm before commit) is the
same one described above.

**No scope choice.** A Phase, Pipeline, or Workflow can land in **user**
or **workspace**. The Model Catalog has one writable layer — this
workspace — so there is nothing to choose at confirm time.

**Two outcomes, not four.** A Model Catalog row is never `blocked` or
`invalid`: a model id has no dependency to be blocked on, and nothing
about a model id can be defective the way a malformed Phase definition
can.

| Outcome | What it means | Will it be written? |
|---|---|---|
| `import` | This id is new for this backend | Yes |
| `skip` | Something already claims this id, or the row cannot be classified | No |

`skip` carries one of two reasons, neither of which is the `blocked` or
`invalid` reasons above:

| Reason | Meaning | What to do |
|---|---|---|
| `already-exists` | This backend already has this exact id, byte for byte — no case-folding, no whitespace-trimming | Nothing — it is already there |
| `unrecognized-backend` | The group's `backend` is not one this workspace runs | Check the backend name against the ones this workspace supports, then re-export from a workspace that has the right ones |

An empty model id is silently dropped rather than reported as a row of
its own — the same convention the catalog editor already applies to a
blank entry.

**No inclusion-depth choice on export.** Export always produces the whole
catalog, every backend, as one document. There is no
references-only/include-referenced-style choice to make, and no
per-resource **Export** button to press one entry at a time — one
**Export Model Catalog** button covers all of it, even an empty catalog.

## What the exchange never carries

No filesystem path crosses between the extension host and the webview in
either direction. You name a file in a host dialog; the panel never
learns the answer, and no plan row, payload, or message carries one.

An imported `retryCondition` is inert text to the exchange path: it is
checked for presence, carried verbatim, and handed to the catalog's own
validator, which owns its grammar. Nothing evaluates it during import.
The trust gate keys on the field being *there*, never on what it says.

## What is recorded

Exchange activity is audited as metadata only — ids, versions, statuses,
outcomes, counts, scopes. No instruction text, prompt, transcript, file
name, or workspace path appears in these entries.

| When | What is recorded |
|---|---|
| Preview | One entry per refused document. A planned document records nothing — no write was requested |
| Confirm | One entry per catalog layer of a package import, saying whether that layer landed |
| Export | One entry |

A single-Phase import records nothing at commit: one write cannot be
partial, so the catalog is already the record. A package can be partial,
which is exactly why its layers are recorded individually.

Long id lists are capped in the entry, but the untruncated count stays in
`counts`, so a cap is visible rather than silent. See
[Inspect audit logs](inspect-audit-logs.md) for how to read the log.

## References

- [Phase YAML exchange](../features/phase-yaml-exchange.md) — the
  document format, the accepted YAML subset, and the full refusal
  taxonomy
- [Per-capability trust scopes](trust-scopes.md) — which scopes each
  import shape requires
- [Inspect audit logs](inspect-audit-logs.md) — reading the recorded
  entries
- [Configuration](configuration.md) — where the catalogs live
