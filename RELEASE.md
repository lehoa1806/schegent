# Release Process

This document captures the release-gate guardrails for the Schegent VS
Code extension. The release process is intentionally manual — the gate
is automation-verifiable but a human owns the cut.

Feature 056 (principal architecture hardening, Track 6) introduced the
two-tier CI shape this document codifies.

## CI shape

Three validation workflows live under [.github/workflows/](.github/workflows/):

| Workflow | Trigger | Jobs | Purpose |
|---|---|---|---|
| [`pr.yml`](.github/workflows/pr.yml) | `pull_request` | host/webview/test-source typechecks, `lint`, unit/eval tests, production build, Linux visual matrix, exact package smoke | Fast PR gate. Required on every PR. |
| [`ci.yml`](.github/workflows/ci.yml) | `push`, `pull_request`, or manual dispatch | full cross-platform validation; Linux additionally runs coverage, visual regression, and isolated integration | Main-branch and PR redundancy for the release-critical path. |
| [`full-gate.yml`](.github/workflows/full-gate.yml) | `schedule: '0 6 * * 1'` (Mondays 06:00 UTC) + `workflow_dispatch` | ten jobs: `typecheck-host`, `typecheck-webview`, `typecheck-tests`, `lint`, `test`, `build`, `visual`, `e2e`, `integration`, `evidence-soak` | Heavier deterministic E2E, isolated extension-host integration, screenshot regression, and high-volume evidence coverage. Required green before cutting a release. |

The PR gate is fast enough to run inline with normal code review. The
full gate is the release-readiness signal; the weekly cron exists so a
release cut on a quiet Monday is never blocked waiting for a manual
dispatch.

## Pre-release checklist

Before tagging a release, verify each item:

0. **Local consolidated gate.** Run `npm run ci:fast`. It runs
   `npm run verify:all` — contract and documentation freshness, version parity,
   secret/license/action-pin checks, typechecks, lint, and host/webview tests —
   and adds the eval and visual suites, the host build, and
   `npm run package:smoke`. Reach for the whole chain rather than `verify:all`
   alone: `verify:all` does not run the packaging policy, so it is not the chain
   to release on.

1. **Full gate ≤ 7 days old.** The most recent successful `full-gate.yml`
   run against `develop` (or the release branch) must be within seven days.
   If older, dispatch a fresh run:
   ```bash
   gh workflow run full-gate.yml --ref develop
   gh run watch
   ```
2. **All ten full-gate jobs green** on the run you are releasing from.
   Spot-check with:
   ```bash
   gh run list --workflow=full-gate.yml --branch=develop --limit=3
   ```
3. **`npm audit` cadence.** Run at the repo root and the webview tree:
   ```bash
   npm audit --audit-level=low
   ( cd webview-ui && npm audit --audit-level=low )
   ```
   Zero advisories is the target. Advisories with no compatible fix
   available are acceptable IF each is documented under
   [Known advisories](#known-advisories) below with the rationale and a
   tracking link.
4. **Never `npm audit fix --force`.** The `--force` flag is allowed to
   downgrade dependencies across major versions or pull in incompatible
   patches; either consequence can break the build in ways that won't
   surface until runtime. The only acceptable remediations are:
   - `npm audit fix` (compatibility-safe minor/patch only), OR
   - hand-edit `package.json` to bump a single dependency to a known-good
     version and re-run `npm ci`, OR
   - accept the advisory and document it under
     [Known advisories](#known-advisories).
5. **Conventional-commit history.** The release-tag commit range should
   contain only `feat`, `fix`, `refactor`, `perf`, `docs`, `test`,
   `build`, `ci`, `chore`, `style`, or `revert`. No drive-by reformatting
   commits.
6. **Spec / docs / code in sync.** See the workspace `CLAUDE.md` PR
   expectations — both Master Workspace and Execution Repository hashes
   must be recorded and match.
7. **Exact package policy green.** `npm run package:smoke` must report exactly
   the audited entry allowlist within its compressed and uncompressed size
   budgets. The command packages into a private temporary directory and removes
   the artifact after inspection; an unexpected or missing entry fails the
   command.

## Dependency hygiene

- **Dev/build dependencies** may be bumped on patch/minor cadence
  between releases. Each bump is a separate commit (`build(deps): bump
  X from Y to Z`); the diff must fit in a single small PR.
- **Production dependencies** require justification: what changed in
  the upstream changelog, why we want it, what it costs.
- The Dependabot configuration at
  [`.github/dependabot.yml`](.github/dependabot.yml) opens grouped PRs
  on a weekly cadence; treat those as the default mechanism.

## Known advisories

Advisories with no compatible fix available, with rationale:

| Advisory | Affected package | Severity | Rationale | Tracking |
|---|---|---|---|---|
| _(none recorded as of 2026-08-01)_ | | | | |

Add a row here when an `npm audit` advisory cannot be resolved without
a `--force` or a major-version dependency bump. The expectation is that
this table stays short; if it grows past three entries, schedule a
dependency-refresh sprint.

## Cutting a release

1. Verify the pre-release checklist (above).
2. Bump the version in `package.json` and `webview-ui/package.json`
   (semver matching the change set).
3. Append a release-notes entry to
   [`docs/operations/release-notes.md`](docs/operations/release-notes.md)
   summarizing operator-visible changes.
4. Commit the bump, then tag the release:
   `git tag -a vX.Y.Z -m "Release vX.Y.Z"`. The release job compares the tag to
   `package.json`'s `version` before it installs anything and refuses a
   mismatch, naming both values — so step 2 has to be committed on the commit
   the tag points at, not after it.
5. Push the tag: `git push origin vX.Y.Z`.
6. The marketplace publish step is manual. Download the artifacts from the
   tag's GitHub Release, which the workflow publishes and which does not
   expire; the `schegent-release-artifacts` bundle on the workflow run holds the
   same files and is kept for 90 days. Then, in order: verify provenance with
   the command under [Artifact provenance](#artifact-provenance), verify the
   bundle against `SHA256SUMS`, and publish the `.vsix` with
   `vsce publish --packagePath <file>`. There is no automated publish job.

## Artifact provenance

A distributable `.vsix` comes from a tagged `release.yml` run and from
nowhere else. Local packaging exists only to check the archive: `npm run
package:smoke` writes into a temporary directory and deletes it, and a
`.vsix` sitting in the working tree is a leftover, not a candidate — it is
gitignored, it carries no record of the commit or the toolchain that
produced it, and nothing distinguishes it from one built with uncommitted
changes. Delete it rather than shipping it.

That is now checkable rather than conventional. A tagged run attaches a
GitHub build-provenance attestation to the `.vsix` and to
`schegent-sbom.cdx.json`, binding each file's digest to this repository,
this workflow file, and the commit it was built from. Verify a download
before installing or publishing it:

```bash
gh attestation verify schegent-<version>.vsix \
  --repo lehoa1806/schegent \
  --signer-workflow lehoa1806/schegent/.github/workflows/release.yml
```

Read the result this way. A success prints a line per verified attestation
naming the predicate type (`https://slsa.dev/provenance/v1`) and the signing
workflow. The `--signer-workflow` constraint is what makes that line mean
anything: without it, an attestation from any workflow in any repository
would satisfy the check. The commit the artifact was built from lives in
the attestation's build definition, which `--format json` prints in full if
you need to match it against the tag.

What the command needs: the `gh` CLI authenticated as any GitHub account
(`gh auth login`), because attestation lookup is an API call. No repository
write access, and no local checkout. It also needs a `gh` build that has the
`attestation` subcommand, which arrived in 2.49.0 — confirm with
`gh attestation verify --help` before reading a failure as a verdict on the
artifact. A missing subcommand or a missing login is not a failed provenance
check.

**A locally built `.vsix` is expected to fail this command, and that is the
point.** `npm run package` produces a file with no attestation, so
verification reports that none was found. A local build is not a release: it
is an archive you can inspect, never one you can attribute.

`SHA256SUMS` is still generated and still worth checking — it catches a
corrupted download — but it is produced and uploaded by the same unsigned job
as the artifact, so on its own it establishes transfer integrity rather than
origin. It is deliberately not an attestation subject: its content is the
digests of the two files that *are* attested, so verifying those directly is
strictly stronger than verifying a manifest of them.

The one thing this cannot establish from a working tree is itself. The real
tagged run, the attestation it produces, and the verification output are
recorded as outstanding in
[docs/operations/release-provenance-observation.md](docs/operations/release-provenance-observation.md),
together with the commands that close them.

## Rollback

A release tag is a marker, not a deployment. The VS Code marketplace
serves whatever version the operator's extension host fetches; a
rollback is a forward-fix: bump the version, fix the regression, cut a
new release. Do not retag.

If a regression is severe enough to block all operators, post an
advisory under [`docs/operations/`](docs/operations/) and the
extension's GitHub Discussions or Issues thread.
