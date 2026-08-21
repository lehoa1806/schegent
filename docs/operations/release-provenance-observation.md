# Release-provenance observation record

**Status**: mechanism landed, observation **outstanding**
**Opened**: 2026-08-22
**Source finding**: `P3-PROV` (Low likelihood / Low impact), audit Table 5 row P3

## What the release workflow could and could not establish

[`release.yml`](../../.github/workflows/release.yml) was already the strictest
chain in the repository: `verify:all`, `build`, `package:smoke`, the only
`test:integration` that runs to completion, every action pinned to a commit
SHA, `permissions: contents: read`, a CycloneDX SBOM, and `SHA256SUMS` over
both payloads.

`SHA256SUMS` was generated and uploaded by that same unsigned job. So
[`RELEASE.md`](../../RELEASE.md)'s instruction to "verify it against
`SHA256SUMS`" established that a download arrived intact and nothing at all
about where it came from — anyone able to substitute the artifact could
substitute the digest file beside it. The prescribed step existed and was one
signature short of meaning something.

Two smaller gaps sat beside it. Nothing compared the tag to the manifest, so a
`v0.3.0` tag on a commit declaring `0.2.0` produced a `schegent-0.2.0.vsix`
under it with no step noticing — and when this record was opened the manifest
(`0.2.0`) was already ahead of the only tag in the repository (`v0.1.0`).
And `package:smoke` asserts the entry allowlist over a temporary-directory
package built from the same `dist/`, deliberately not over the file that ships,
so the allowlist held over an archive that was probably byte-identical to the
released one on an assumption the workflow neither stated nor tested.

## What was changed

Five steps added to one job, one step amended, one job-level `permissions:`
block:

| Change | What it establishes |
|---|---|
| `actions/attest-build-provenance`, pinned | each released file's digest is bound to this repository, this workflow file, and the commit it was built from |
| tag/manifest parity, before `npm ci` | a tag that disagrees with `package.json` fails in seconds, naming both values |
| released-file policy assertion | the entry allowlist and size budgets hold over the bytes that ship, not only over a temp-dir package |
| single resolution of the released `.vsix` | five consumers read one path, so no step can act on an archive another step never checked |
| `gh release create` on tag runs | the artifact outlives the 90-day workflow-run retention, so the attestation points at something fetchable |

The permission widening is job-scoped: `contents: write`, `id-token: write` and
`attestations: write` on the `package` job, with the workflow-level default left
at `contents: read`. A job-level block replaces the workflow default rather than
extending it, which is why `contents: read` is restated inside it.

Ordering is the load-bearing part. Attestation runs *after* the released-file
assertion, and the release is published last. An attestation over an archive
this project's own gate would refuse is worse than no attestation, because it is
what an operator trusts *instead of* reading the archive.

## What holds locally, and what does not

Locally checkable, and checked:

- `npm run security:actions` — the new pin is a 40-hex commit SHA. The SHA is
  the commit `refs/tags/v4` dereferences to, not the annotated tag object, which
  would have satisfied the regex while pinning something other than a commit.
- `npm run docs:check` — `RELEASE.md` still carries the strings the gate
  requires, and every relative link here resolves.
- The released-file assertion reuses
  [`scripts/check-vsix-smoke.mjs`](../../scripts/check-vsix-smoke.mjs) through
  its existing path argument, so the allowlist has one definition rather than a
  second copy in YAML.
- The released-file assertion was run end to end against a real `npm run
  package` archive and reported the same figures as `package:smoke` in the same
  tree: 52 entries, 956717 compressed bytes, 2654160 uncompressed. That is the
  strongest available local evidence that the two assertions see the same
  content; the requirement is that they agree **within one CI run**, which only
  a run can answer.
- The parity and resolution step bodies were exercised directly against five and
  three cases respectively: matching tag, mismatched tag, malformed tag (`vfoo`
  fails as a mismatch rather than crashing), non-tag ref (skips, exit 0), a tag
  name carrying `;` and a command (treated as data — the ref name reaches the
  shell through the step environment, never through `${{ }}` interpolation into
  a script body), and zero / one / two archives in the workspace root.

Not locally checkable: everything the attestation actually is. There is no
attestation without a tagged run on the remote, and no verification output
without an attestation.

## Observation procedure — outstanding

Cutting a release requires pushing a tag, which is an outward action outside the
authority of the cycle that made this change. The conclusions below are
therefore recorded as **outstanding by decision** rather than left implied or
filled in on assumption.

Once a tag is on the remote, an operator should run each command and fill in the
result:

| # | Step | Command | Observed |
|---|---|---|---|
| 1 | Cut a release from a commit whose manifest matches the tag | `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z` | _(unfilled)_ |
| 2 | Confirm the run is green and `security:actions` passed inside it | `gh run list --workflow=release.yml --limit=1` | _(unfilled)_ |
| 3 | Confirm two attestation subjects exist | `gh attestation list --repo lehoa1806/schegent` (or the run's Attestations tab) | _(unfilled)_ |
| 4 | Verify the released package as an outside operator would | `gh attestation verify schegent-X.Y.Z.vsix --repo lehoa1806/schegent --signer-workflow lehoa1806/schegent/.github/workflows/release.yml` | _(unfilled)_ |
| 5 | Verify the SBOM the same way | same command against `schegent-sbom.cdx.json` | _(unfilled)_ |
| 6 | Confirm a local build fails it | `npm run package` then the command from step 4 against that file — **expected to fail** | _(unfilled)_ |
| 7 | Confirm the released-file entry count equals `package:smoke`'s in the same run | read both step logs | _(unfilled)_ |
| 8 | Confirm the GitHub Release exists, is published, and is marked prerelease while the version is `0.x` | `gh release view vX.Y.Z` | _(unfilled)_ |
| 9 | Confirm a mismatched tag is refused | tag a commit whose manifest differs, push, and read the first failure — **expected to fail**, naming both values | _(unfilled)_ |
| 10 | Confirm the artifact is still reachable after 90 days | `gh release download vX.Y.Z` past the retention window | _(unfilled)_ |

Step 6 is the one that turns the provenance claim into a distinction. Delete the
local `.vsix` afterwards: an archive in the working tree is a leftover, not a
candidate.

## Expect the first run to surface something

This chain has never executed with these steps. Four failure modes are worth
recognising, because each is a **new finding** rather than a regression of this
change:

1. **The attestation step failing outright.** Artifact attestations need the
   repository to be public or on a plan that includes them. `lehoa1806/schegent`
   answers an unauthenticated API request today, so it is public and this should
   not fire — but a visibility change would break the release chain rather than
   the build, and this is where that would show up.
2. **The released-file assertion failing where `package:smoke` passed.** That
   would mean packaging is *not* deterministic from a fixed `dist/`, which is
   exactly the assumption this step exists to test. It is the most interesting
   outcome available and should be read as information, not as a broken step.
3. **`gh release create` refusing because a release already exists.** On a
   re-run of a tag this fails by design, naming the situation. `RELEASE.md` says
   do not retag: delete that release deliberately, or cut a new version.
4. **`gh attestation verify` failing on the operator's machine for tooling
   reasons.** The subcommand arrived in `gh` 2.49.0 and the lookup is an API
   call. A missing subcommand or a missing login is not a verdict on the
   artifact — `RELEASE.md` says this too, in the place an operator reads it.

## The gate that does not exist yet

The business request for this item scoped it to the workflow and the release
document: no source change, no test change, no dependency. That boundary was
honored, and the consequence belongs here rather than nowhere.

`tests/unit/build/release-qualification.test.ts` asserts only that
`release.yml` exists. Nothing asserts the properties this change is made of, so
after it they are held by `security:actions` (pins only) and by reading. The
missing gate is a `tests/lint/` test that parses `release.yml` and asserts:

1. the workflow-level `permissions:` block is exactly `contents: read`;
2. every widening beyond it is declared at job level;
3. no attestation or upload step appears before the released-file assertion;
4. no step after `npm run package` expands a `*.vsix` glob of its own;
5. the parity step precedes the first `npm ci`.

Items 3 and 4 are the ones worth having: they are ordering and
single-resolution properties that a well-intentioned future edit can break
silently, and neither leaves a trace in any other gate. This is a follow-up,
recorded and not built.

## Related

- [../../RELEASE.md](../../RELEASE.md) — the pre-release checklist, the
  cutting-a-release procedure, and the operator-facing verification command.
- [merge-gate-observation.md](merge-gate-observation.md) — the same shape of
  record for the workflow-trigger retarget, and the reason both exist.
- [release-notes.md](release-notes.md) — operator-visible changes per release.
