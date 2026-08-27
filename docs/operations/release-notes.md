# Operator-visible release notes

This file is the release workflow's stable pointer for changes that affect operators. It is maintained manually: neither the version field nor the release job can determine which source changes are operator-visible.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Unreleased — operator-visible changes awaiting the first release

Recorded as they land, so the first release note is assembled from evidence rather than
from memory.

### BREAKING — a Phase is judged on its exit status by default (`FR-R3-117`, 2026-08-27)

A Phase that declares nothing used to advance on the model's own report of its work. It
is now judged on its process's exit status, and a clean termination token cannot
override a non-zero exit or a timeout.

**Who is affected**: any Phase whose `sideEffects` is other than `none` — and because
`sideEffects` resolves to `workspace` when omitted, that is most Phases. A Phase
declaring `sideEffects: none` is unchanged.

**What you may need to do**: a Phase that legitimately exits non-zero (a linter used as
a probe, a diff check) now stops the Run. Add `hostVerification: model-token` to that
Phase's spec to keep the old behaviour. Nothing else is required.

**What happens to Runs you already have**: nothing. Persisted plan snapshots are
migrated (state schema 13 → 14) carrying the verdict basis they were frozen under, so
an existing Run keeps the meaning it was approved with.

**What you gain**: a failed build, a failed test run or a crashed tool can no longer
report success, and every completed Run's evidence names which basis judged each Phase
(`phase-end.verdictBasis`).

**Shipped documents affected, swept rather than left to discovery**: both example
pipelines — `examples/speckit-new-feature.pipeline.yaml` (nine Phases; six make a
verifiable claim) and `examples/speckit-bugfix.pipeline.yaml` (five Phases) — now write
`hostVerification: exit-code` out explicitly. They would resolve to it anyway; an
example is what an operator copies, so it should say what judges each Phase rather than
let it be inherited invisibly. `examples/model-catalog.yaml` declares no Phases and is
unaffected. No other pipeline or phase document ships in the tree.

Full reasoning: [`docs/architecture/phase-verdict-default.md`](../architecture/phase-verdict-default.md).

## First release pending — 2026-08-26

**No release has shipped, and this is a dated statement rather than an empty section**
(`FR-R3-101`, FR-030). `release.yml` never ran: no `v*` tag was ever pushed, and the workflow
itself was deleted on 2026-08-26 when Actions were retired by operator decision
([terminal record](../release/actions-terminal-record.md)). So there are no operator-visible
changes to record because there has been no version for an operator to be visible to.

**Owner**: the repository operator, who is the only party who can cut a release.

**What must happen before the first entry exists**: a release goes out through the local path —
`npm run gate:record` then `npm run release`, which refuses unless a recorded gate PASS names
`HEAD` over a clean tree ([`RELEASE.md` §2a](../../RELEASE.md)). At that point this section is
replaced by a `## v<version>` heading with evidence-backed additions, changes, fixes, removals,
migration effects and security notes.

**Two limits worth stating now rather than discovering at release time**: the local path emits
**no SBOM and no attestation** — those were `release.yml`'s, and they went with it; and
verification is single-platform, single-machine, permanently, since the three-OS matrix is gone.

## Unreleased

Nothing yet. When adding the first entry, name the affected command, setting, workflow, state
transition or persisted artifact exactly as it appears in the product, and state upgrade or
rollback limits explicitly. Do not infer a historical change list from the current code snapshot
alone.

For each entry, name the affected command, setting, workflow, state transition, or persisted artifact exactly as it appears in the product. State upgrade or rollback limits explicitly. Do not infer a historical change list from the current code snapshot alone.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: src/contracts/state-schema.ts -->
