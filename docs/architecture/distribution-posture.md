# Distribution posture

**Decided 2026-08-27** · `FR-R3-120` · Companion to
[release posture, engineering preview](release-posture-engineering-preview.md)

## The decision

**Private-to-author.** The VSIX is built and installed by the person who built it. It
is not passed to anyone, published to a marketplace, or offered for download.

## Why this is a decision and not a description

`RELEASE.md` was already honest about what a release *is* — *"entirely local"*,
producing a VSIX, publishing nothing. What it did not say is what the project
**intends**, and that gap is what `FR-R3-120` filed: the tasks after it are scoped by
the answer, and without one they were scoped by an assumption.

There is one operator, no signing key, no key-distribution channel, and no recipient.
Declaring a hand-passed or published posture would be planning for a state that does
not exist, and would make three of this item's tasks urgent that are not.

## What this scopes, and what it does not

### Taken anyway — the SBOM (FR-013)

An SBOM ships despite the posture, and the reasoning cuts against it deliberately.

`repo/package.json` declares **no `dependencies` key at all** — not an empty one,
absent. So the SBOM is cheap to produce, short, and says something unusually strong:
the extension has zero runtime dependencies, and now says so verifiably rather than
by assertion. It costs nothing to produce and nothing to carry.

The general principle: **evidence that is free to produce should be produced before
it is needed, not when.** If the posture changes, the evidence gap should not have to
change with it.

`schegent-sbom.cdx.json`, CycloneDX 1.5, written beside the VSIX and packaged inside
it — inside because a recipient is handed one file, and an SBOM on the builder's disk
describes the artifact to nobody.

### Declined — the detached signature (FR-012)

`FR-R3-120` T1442 is written conditionally: *"If the artifact ever leaves the
machine."* It does not, so the task is **declined**, not deferred and not forgotten.

**What declining costs**: a recipient cannot distinguish an authentic build from any
other file with the same name. Under this posture there is no recipient, so the cost
is zero today and the full amount on the day the posture changes.

**The condition that reverses this**: the first time a VSIX is passed to anyone. Not
"when convenient" and not "before 1.0" — the trigger is the act itself, because that
is the moment the posture stops being an internal note and becomes something someone
relies on.

**What reversing it requires**: a signing key, a place to publish the public half,
and a documented verification command that names neither a workflow nor a service
this project does not have. That is more than an afternoon, which is the honest
reason to record the trigger now rather than discover it later.

### Unconditional regardless of posture

- **FR-011** — `release-provenance-observation.md` taught a `gh attestation verify
  --signer-workflow` path over a `release.yml` deleted by `FR-R3-099`. A document
  teaching an impossible check is wrong whether or not anyone is reading it.
- **FR-014** — `release:preflight` now refuses when the four version-bearing
  manifests disagree, or when a `v*` tag on `HEAD` disagrees with them. This restores
  locally what the retired tag job did, and it is a local correctness property, not a
  distribution one.

## The single reviewer

`.github/CODEOWNERS` routes every path — including `src/lib/logger.ts`, `src/audit/`,
`src/headless/`, `src/runner/claude-cli.ts` and `docs/security/` — to one person, who
is also the only operator and, since the Actions retirement, the only enforcement.

**This is recorded as an accepted limit** in [`SECURITY.md`](../../SECURITY.md), which
is what `FR-R3-120` T1445 offers as a legitimate completion. There is no second
reviewer to name, and naming an absent one would be worse than stating the fact. The
limit being closed is the *unstated* version.

A four-eyes rule and an unbypassable gate are two independent controls, and this tree
has neither. Both are now written down as absent, with the conditions that would
change each.

## What this record does not claim

- It does not claim the local gate is weak. `.gate-attestation.json` and the backend
  qualification record are two independent bindings that fail closed, and a stale
  attestation refuses a release. The gap is that their evidence never leaves the
  machine that produced it.
- It does not claim the product will stay undistributed. It claims that it is not
  distributed today, and names the trigger that changes the answer.
