# Operator-visible release notes

This file is the release workflow's stable pointer for changes that affect operators. It is maintained manually: neither the version field nor the release job can determine which source changes are operator-visible.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

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
