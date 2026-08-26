# Releasing Schegent

Schegent uses a hybrid release process. A maintainer chooses the version, commits it, and pushes an exact matching `v<version>` tag. GitHub Actions then verifies and packages the extension, generates integrity material, attests the build, and creates the GitHub Release. No checked-in job publishes to the Visual Studio Marketplace.
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Release boundary

The durable release workflow runs on tags matching `v*`; it can also be started manually with `workflow_dispatch`. A tag run creates a GitHub Release. A manual dispatch runs the build and uploads a 90-day workflow artifact but skips tag/version parity and skips the GitHub Release because its ref is not a tag.
<!-- Source: docs/release/actions-terminal-record.md -->

The tag must be exactly `v` followed by the root `package.json` version. The workflow removes the leading `v` and compares the rest byte-for-byte; a mismatch fails before dependency installation.
<!-- Source: docs/release/actions-terminal-record.md -->

## 1. Choose and record the version

Keep these four files aligned:

- `package.json`
- `package-lock.json`
- `webview-ui/package.json`
- `webview-ui/package-lock.json`

The documentation gate compares the two manifest versions, and both lockfiles record their package tree's version. One non-tagging way to update each manifest and lockfile pair is:

```bash
npm version <version> --no-git-tag-version
npm --prefix webview-ui version <version> --no-git-tag-version
```

Replace `<version>` with the exact version string without a leading `v`. Review all four resulting diffs. The release workflow itself checks only the root manifest against the tag, so local review must catch lockfile or webview drift before the tag exists.
<!-- Source: package.json -->
<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: scripts/check-docs.mjs -->
<!-- Source: docs/release/actions-terminal-record.md -->

Update [operator-visible release notes](docs/operations/release-notes.md) without inferring changes from a version number. The release workflow links that path from every generated GitHub Release body but does not generate the document.
<!-- Source: docs/release/actions-terminal-record.md -->

Commit the version and release-note changes before creating the tag. The repository has no release-preparation script and no automated version bump.
<!-- Source: package.json -->
<!-- Source: docs/release/actions-terminal-record.md -->

## 2. Run the pre-tag gates

Run both aggregate local gates from the repository root:

```bash
npm run verify:all
npm run ci
```

`verify:all` covers contract and documentation freshness, secrets, action pins, licenses, types, lint, host tests, and covered webview tests. `ci` adds the broader build, visual, evaluation, performance, E2E, package-smoke, and Extension Development Host paths but does not call `verify:all`.
<!-- Source: package.json -->

The checked-in **Full gate** workflow runs weekly and on manual dispatch. It separately exercises host/webview/test typechecking, host lint, tests/evals, build/package smoke, visual regression, E2E, Extension Development Host integration, and a sustained 20,000-record evidence soak.

**A tag run requires a green Full gate on the exact release commit, mechanically** (FR-R3-060). The release job's first step queries that workflow's completed runs for `github.sha` and fails when none succeeded, naming what is missing and what to do about it. It fails closed: an unreadable API is not evidence of a green gate. This replaces the previous maintainer-confirmation step, under which a tag could publish with signed provenance over an artifact whose full gate ran on a different commit or not at all.

> **This binding is withdrawn, 2026-08-26, and the reason it was kept was false.** `S14` and
> FR-R3-095 recorded that *"this project does not run GitHub Actions"*, so `full-gate.yml` produced no
> runs and the binding had no records to read. **That was wrong, and wrong in the more damaging
> direction.** The principal review checked the live API and found **185 runs since 2026-05-18** —
> `full-gate.yml` weekly for 14 weeks, all red; `ci.yml` red at the then-current `HEAD` with the
> Windows leg failing; CodeQL green at `HEAD`; `backend-canary.yml` green on the same day its own
> header said it does not run. Runs existed **at the current commit**, and nothing anywhere consumed
> one of them. A conclusion about the remote, written without checking the remote, is this round's
> signature defect turned on the audit itself.
>
> The operator has since decided the question: **Actions are retired, entirely, for budget**
> (`FR-R3-099`). So the premise FR-R3-095 §5 kept this binding under — *"for a process this project
> may adopt"* — is decided against, and `require-full-gate.mjs` and `release.yml` are **deleted**
> rather than left inert. What they were is recorded in
> [withdrawn CI controls](docs/release/withdrawn-ci-controls.md); the fourteen weeks of unread signal
> are read once in [the terminal record](docs/release/actions-terminal-record.md).
>
> **The binding that operates is the local one in §2a, and it is now the only one.** It is not a
> substitute for the matrix, the Node floor, code scanning or dependency review — and those are not
> pending, they are **gone**, with no local equivalent for code scanning at all. Single-platform,
> single-machine verification is a permanent stated limit of this project, not a state awaiting a
> push.
<!-- Source: docs/release/withdrawn-ci-controls.md -->
<!-- Source: docs/features/round_3/DONE_95_FR-R3-095_a_release_gate_that_exists.md -->

The check applies to tag runs only. A `workflow_dispatch` creates no release, so requiring release evidence from it would block the dry-run described below. The decision logic is a pure function with unit coverage (`tests/unit/build/require-full-gate.test.ts`), because a gate exercised only by cutting a release is a gate nobody exercises.
<!-- Source: docs/release/actions-terminal-record.md -->

## 2a. Bind the release to a gate result for THIS commit (local path)

Running the gates is not the same as having evidence that they ran, and until FR-R3-095 the local release path had neither a script nor a binding — `npm run package` would package any tree at all.

```bash
npm run gate:record      # runs `npm run ci` under observation and records the result
npm run release          # refuses unless a recorded PASS names HEAD over a clean tree
```

`gate:record` **spawns** the gate and records the exit code it observed, at the commit, on the platform, with the tree confirmed clean before and after. The writer sits outside the thing the record vouches for, so it cannot record a pass it did not see — a gate step that wrote its own attestation would prove only that the step ran. A red run is recorded too, so a failure leaves anti-evidence instead of leaving an older commit's pass as the newest record anyone finds.

`release` runs the check and then packages. It refuses, naming which of six causes applies, when: the tree is dirty, no record exists, the record names another commit, it records a different command, it records a failing gate, or it is a version this checker does not read. The record is untracked — it describes one machine's observation of one tree, and a committed one would travel to a clone that never earned it.

### What the attested gate covers

This list is **derived from the script chain, not typed beside it** (FR-R3-100, FR-017).
`scripts/check-gate-coverage-parity.mjs` computes the transitive closure of `npm run gate` over
`package.json` and refuses when this block and the chain disagree — in **both** directions, because a
stage the document claims and the chain does not reach is worse than one it forgets. Regenerate with
`node scripts/check-gate-coverage-parity.mjs --write`.

Before this item the binding named `npm run ci`, which did **not** run the secret scan, the
workflow-pin check, the license check, the docs check or `contracts:check`. A release could therefore
be attested past a failing secret scan. `GATE_COMMAND` now names `npm run gate`, which runs those five
and then `ci`; the host coverage floors moved inside it too, by `ci` running `test:coverage` rather
than `test:host`.

<!-- BEGIN DERIVED: gate-coverage -->

<!-- Generated by scripts/check-gate-coverage-parity.mjs. Do not edit by hand. -->

`npm run gate` reaches **22** checks that do work of their own:

- `a11y` — `node scripts/check-playwright-browser.mjs && npm run build:webview && playwright test --config playwright.a11y.config.ts`
- `build:host` — `node esbuild.config.mjs`
- `build:webview` — `npm --prefix webview-ui run build`
- `contracts:check` — `node scripts/generate-contract-schemas.mjs --check`
- `docs:check` — `node scripts/check-docs.mjs && node scripts/check-doc-links.mjs && node scripts/check-gate-coverage-parity.mjs`
- `license:check` — `node scripts/check-licenses.mjs`
- `lint` — `node scripts/lint.mjs host`
- `lint:webview` — `node scripts/lint.mjs webview`
- `package:smoke` — `node scripts/package-vsix-smoke.mjs`
- `security:actions` — `node scripts/check-workflow-pins.mjs`
- `security:secrets` — `node scripts/scan-secrets.mjs`
- `test:coverage` — `vitest run --coverage`
- `test:e2e` — `vitest run --config vitest.e2e.config.ts`
- `test:evals` — `vitest run --config vitest.evals.config.ts --reporter=verbose`
- `test:integration` — `npm run build && npm run test:integration:compile && node ./out/tests/integration/runTest.js`
- `test:integration:compile` — `tsc -p tsconfig.integration.json`
- `test:perf` — `vitest run --config vitest.perf.config.ts`
- `test:visual` — `node scripts/check-playwright-browser.mjs && npm run build:webview && playwright test --config playwright.config.ts`
- `test:webview:coverage` — `npm --prefix webview-ui run test:coverage`
- `typecheck` — `tsc --noEmit`
- `typecheck:tests` — `tsc -p tsconfig.tests.json --noEmit`
- `typecheck:webview` — `npm --prefix webview-ui run typecheck`

<!-- END DERIVED: gate-coverage -->

**Wall-clock and coverage, measured 2026-08-26.** The host suite under coverage measures
**89.47 / 88.03 / 91.37 / 89.47** (statements / branches / functions / lines) against declared floors
of 80 / 75 / 80 / 80 — so the floors are a real control with roughly nine to thirteen points of
headroom, which is why FR-R3-100 enforced them rather than taking its other option of deleting them.
A threshold breach makes the run exit non-zero: verified by raising a floor above actual coverage and
observing the refusal, not assumed from the configuration.

The instrumented host suite takes about **2m10s** against roughly **35s** uninstrumented, and the five
folded checks add a few seconds between them; none of them builds the webview, so the build count is
unchanged at five. **No stage was dropped to protect any of these figures.**

One honest caveat, recorded rather than discovered later: two consecutive instrumented runs disagreed,
with seven timing-sensitive tests failing on the first and none on the second. The failures are
assertions about exact debounce coalescing after wall-clock sleeps — the load-sensitivity class
`FR-R3-114` row 3 files — so an instrumented gate is more likely to need a re-run than the
uninstrumented one was. The measurement is in `specs/156-round-3-close/baselines.md`.

**Still not covered, stated rather than implied.** `npm run security:audit` queries the npm registry,
so it is operator-invoked and outside the gate: a gate that fails for want of a network is a gate
people learn to bypass. `npm run selftest:install` performs a real network install and is outside for
the same reason. Both are named in `SECURITY.md` and `CONTRIBUTING.md` with the occasion to run them.

**What this is not.** A local attestation is not tamper-evident against the operator whose machine wrote it: anyone who can run the release can also edit the file it reads. It reduces the risk of releasing a commit whose gate never ran, or whose gate ran on a different tree. It is not a substitute for independent verification, and the success message says so along with the single platform the gate ran on.
<!-- Source: scripts/gate-attestation.mjs -->
<!-- Source: scripts/record-gate-run.mjs -->
<!-- Source: package.json -->

## 3. Optionally dry-run the release job

Use the **Release package** workflow's manual-dispatch control on the commit you intend to tag. A dispatch performs the same dependency installation, `verify:all`, build, package smoke, Extension Development Host integration, VSIX packaging and policy check, SBOM/checksum generation, provenance attestation, and 90-day artifact upload. It deliberately creates no GitHub Release.
<!-- Source: docs/release/actions-terminal-record.md -->

The packaging policy requires exactly one VSIX, a closed entry allowlist, safe archive paths, at most 2 MiB compressed, and at most 5 MiB uncompressed. It includes the extension manifest, license, root README/RELEASE/SECURITY documents, branding assets, built host/webview files, and every file in `examples/`; `.vscodeignore` excludes source, tests, implementation docs, maps, and local state.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

The current workflow does not set `NODE_ENV=production`. Consequently `esbuild.config.mjs` takes its non-production branch for the host bundle; source maps are emitted by the build and then excluded from the VSIX. Do not describe the current tagged artifact as minified unless the workflow changes to set that environment value.
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: .vscodeignore -->

## 4. Create and push the release tag

After the version commit is on the intended release branch, create an annotated tag and push that one tag:

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

Both occurrences of `<version>` must equal `package.json`'s version without the `v` prefix. Pushing the tag is the deployment trigger.
<!-- Source: docs/release/actions-terminal-record.md -->

The repository does not encode a signing requirement for Git tags. If maintainers require signed tags operationally, that policy exists outside the checked-in release automation.
<!-- Source: docs/release/actions-terminal-record.md -->

## 5. What the tag workflow does

On Ubuntu with the Node version from `.nvmrc`, the job performs this sequence:

1. Check out the tagged commit and verify tag/manifest parity.
2. Run `npm ci --ignore-scripts` in the root and `webview-ui`.
3. Run `npm run verify:all` and `npm run build`.
4. Run `npm run package:smoke`.
5. Run `xvfb-run -a npm run test:integration` against a real VS Code host.
6. Run `npm run package` and require exactly one root-level `.vsix`.
7. Re-run the archive policy against that exact released VSIX.
8. Generate `schegent-sbom.cdx.json` with `npm sbom --sbom-format cyclonedx`.
9. Generate `SHA256SUMS` over the VSIX and SBOM with `sha256sum`.
10. Attest the VSIX and SBOM with GitHub OIDC build provenance.
11. Upload the VSIX, SBOM, and checksums as `schegent-release-artifacts` for 90 days.
12. Create a durable GitHub Release containing the same three files.

All `v0.*` tags are marked as prereleases by the workflow. Other tags are not, even if their version string contains a prerelease suffix.
<!-- Source: docs/release/actions-terminal-record.md -->

## 6. Verify the published artifacts

Download the VSIX, `schegent-sbom.cdx.json`, and `SHA256SUMS` from the GitHub Release. The generated release body provides this provenance-verification shape:

```bash
gh attestation verify <vsix-file> \
  --repo <owner>/<repository> \
  --signer-workflow <owner>/<repository>/.github/workflows/release.yml
```

Use the actual downloaded filename and repository identity. An independently built VSIX is expected to fail this workflow-identity verification. `SHA256SUMS` establishes transfer integrity for the VSIX and SBOM; provenance verification binds the attested subjects to this repository and workflow.
<!-- Source: docs/release/actions-terminal-record.md -->

Install or smoke-test the downloaded VSIX according to the consumer environment before announcing it. The workflow's automated integration test exercises the build before packaging; it does not reinstall the final released archive into a second VS Code host.
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: scripts/package-vsix-smoke.mjs -->

## 7. Marketplace publication is manual and unspecified

No workflow or npm script runs `vsce publish`, `ovsx publish`, or another Marketplace deployment command. No Marketplace token name or credential procedure is checked in. `npm run package` creates a VSIX only.

Therefore the repository supports an automated, attested GitHub Release but only records that Marketplace publication is manual. A maintainer must use the externally governed publisher account and procedure; this document cannot supply an exact publish command or credential name from repository evidence.
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Failure and rerun policy

- A tag/version mismatch means the version bump was not committed before tagging. Do not publish the mismatched artifact.
- The GitHub Release is created last, after verification, policy checks, checksums, and attestation. An earlier failure leaves no durable Release from this job.
- If a GitHub Release already exists for the tag, the workflow fails instead of updating it. Do not silently retag. Cut a new version, or coordinate a deliberate release cleanup outside this workflow.
- A manually dispatched artifact expires after 90 days; only a tag run creates the durable GitHub Release.

<!-- Source: docs/release/actions-terminal-record.md -->
