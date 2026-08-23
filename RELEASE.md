# Releasing Schegent

Schegent uses a hybrid release process. A maintainer chooses the version, commits it, and pushes an exact matching `v<version>` tag. GitHub Actions then verifies and packages the extension, generates integrity material, attests the build, and creates the GitHub Release. No checked-in job publishes to the Visual Studio Marketplace.
<!-- Source: .github/workflows/release.yml -->
<!-- Source: package.json -->

## Release boundary

The durable release workflow runs on tags matching `v*`; it can also be started manually with `workflow_dispatch`. A tag run creates a GitHub Release. A manual dispatch runs the build and uploads a 90-day workflow artifact but skips tag/version parity and skips the GitHub Release because its ref is not a tag.
<!-- Source: .github/workflows/release.yml -->

The tag must be exactly `v` followed by the root `package.json` version. The workflow removes the leading `v` and compares the rest byte-for-byte; a mismatch fails before dependency installation.
<!-- Source: .github/workflows/release.yml -->

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
<!-- Source: .github/workflows/release.yml -->

Update [operator-visible release notes](docs/operations/release-notes.md) without inferring changes from a version number. The release workflow links that path from every generated GitHub Release body but does not generate the document.
<!-- Source: .github/workflows/release.yml -->

Commit the version and release-note changes before creating the tag. The repository has no release-preparation script and no automated version bump.
<!-- Source: package.json -->
<!-- Source: .github/workflows/release.yml -->

## 2. Run the pre-tag gates

Run both aggregate local gates from the repository root:

```bash
npm run verify:all
npm run ci
```

`verify:all` covers contract and documentation freshness, secrets, action pins, licenses, types, lint, host tests, and covered webview tests. `ci` adds the broader build, visual, evaluation, performance, E2E, package-smoke, and Extension Development Host paths but does not call `verify:all`.
<!-- Source: package.json -->

The checked-in **Full gate** workflow runs weekly and on manual dispatch. It separately exercises host/webview/test typechecking, host lint, tests/evals, build/package smoke, visual regression, E2E, Extension Development Host integration, and a sustained 20,000-record evidence soak.

**A tag run now requires a green Full gate on the exact release commit, mechanically** (FR-R3-060). The release job's first step queries that workflow's completed runs for `github.sha` and fails when none succeeded, naming what is missing and what to do about it. It fails closed: an unreadable API is not evidence of a green gate. This replaces the previous maintainer-confirmation step, under which a tag could publish with signed provenance over an artifact whose full gate ran on a different commit or not at all.

The check applies to tag runs only. A `workflow_dispatch` creates no release, so requiring release evidence from it would block the dry-run described below. The decision logic is a pure function with unit coverage (`tests/unit/build/require-full-gate.test.ts`), because a gate exercised only by cutting a release is a gate nobody exercises.
<!-- Source: .github/workflows/full-gate.yml -->
<!-- Source: .github/workflows/release.yml -->

## 3. Optionally dry-run the release job

Use the **Release package** workflow's manual-dispatch control on the commit you intend to tag. A dispatch performs the same dependency installation, `verify:all`, build, package smoke, Extension Development Host integration, VSIX packaging and policy check, SBOM/checksum generation, provenance attestation, and 90-day artifact upload. It deliberately creates no GitHub Release.
<!-- Source: .github/workflows/release.yml -->

The packaging policy requires exactly one VSIX, a closed entry allowlist, safe archive paths, at most 2 MiB compressed, and at most 5 MiB uncompressed. It includes the extension manifest, license, root README/RELEASE/SECURITY documents, branding assets, built host/webview files, and every file in `examples/`; `.vscodeignore` excludes source, tests, implementation docs, maps, and local state.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

The current workflow does not set `NODE_ENV=production`. Consequently `esbuild.config.mjs` takes its non-production branch for the host bundle; source maps are emitted by the build and then excluded from the VSIX. Do not describe the current tagged artifact as minified unless the workflow changes to set that environment value.
<!-- Source: .github/workflows/release.yml -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: .vscodeignore -->

## 4. Create and push the release tag

After the version commit is on the intended release branch, create an annotated tag and push that one tag:

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

Both occurrences of `<version>` must equal `package.json`'s version without the `v` prefix. Pushing the tag is the deployment trigger.
<!-- Source: .github/workflows/release.yml -->

The repository does not encode a signing requirement for Git tags. If maintainers require signed tags operationally, that policy exists outside the checked-in release automation.
<!-- Source: .github/workflows/release.yml -->

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
<!-- Source: .github/workflows/release.yml -->

## 6. Verify the published artifacts

Download the VSIX, `schegent-sbom.cdx.json`, and `SHA256SUMS` from the GitHub Release. The generated release body provides this provenance-verification shape:

```bash
gh attestation verify <vsix-file> \
  --repo <owner>/<repository> \
  --signer-workflow <owner>/<repository>/.github/workflows/release.yml
```

Use the actual downloaded filename and repository identity. An independently built VSIX is expected to fail this workflow-identity verification. `SHA256SUMS` establishes transfer integrity for the VSIX and SBOM; provenance verification binds the attested subjects to this repository and workflow.
<!-- Source: .github/workflows/release.yml -->

Install or smoke-test the downloaded VSIX according to the consumer environment before announcing it. The workflow's automated integration test exercises the build before packaging; it does not reinstall the final released archive into a second VS Code host.
<!-- Source: .github/workflows/release.yml -->
<!-- Source: scripts/package-vsix-smoke.mjs -->

## 7. Marketplace publication is manual and unspecified

No workflow or npm script runs `vsce publish`, `ovsx publish`, or another Marketplace deployment command. No Marketplace token name or credential procedure is checked in. `npm run package` creates a VSIX only.

Therefore the repository supports an automated, attested GitHub Release but only records that Marketplace publication is manual. A maintainer must use the externally governed publisher account and procedure; this document cannot supply an exact publish command or credential name from repository evidence.
<!-- Source: .github/workflows/release.yml -->
<!-- Source: package.json -->

## Failure and rerun policy

- A tag/version mismatch means the version bump was not committed before tagging. Do not publish the mismatched artifact.
- The GitHub Release is created last, after verification, policy checks, checksums, and attestation. An earlier failure leaves no durable Release from this job.
- If a GitHub Release already exists for the tag, the workflow fails instead of updating it. Do not silently retag. Cut a new version, or coordinate a deliberate release cleanup outside this workflow.
- A manually dispatched artifact expires after 90 days; only a tag run creates the durable GitHub Release.

<!-- Source: .github/workflows/release.yml -->
