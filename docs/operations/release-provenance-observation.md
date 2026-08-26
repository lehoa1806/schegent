# Observe release provenance

> **Withdrawn, 2026-08-26.** The controls this runbook observes are gone: GitHub
> Actions were retired by operator decision, for budget, and all eight workflow files
> were deleted (`FR-R3-099`). This page is kept as a **dated historical record** of
> how those controls were observed while they ran — the observations were true when
> made and are not rewritten here — but every procedure below is now inert. What the
> workflows actually produced over fourteen weeks is read once in
> [the terminal record](../release/actions-terminal-record.md); what each withdrawn
> control was is recorded in
> [withdrawn CI controls](../release/withdrawn-ci-controls.md).

Use this runbook to verify that a published VSIX is the artifact produced by
Schegent's checked-in release workflow for a specific tag and commit. Treat
checksum integrity, workflow provenance, package policy, and Marketplace
publication as separate claims: the current automation establishes different
evidence for each one.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: RELEASE.md -->

## Know the release boundary

`Release package` runs on pushes of tags matching `v*` and on manual dispatch.
A tag run requires the tag name, after removing the leading `v`, to equal the
root `package.json` version byte-for-byte. That comparison occurs before
dependency installation. A manual dispatch skips the comparison because its
ref is not a tag.
<!-- Source: ../release/actions-terminal-record.md -->

A manual dispatch performs verification, build, package smoke, extension-host
integration, final packaging and policy inspection, SBOM/checksum generation,
attestation, and a 90-day workflow-artifact upload. It does not create a GitHub
Release. Only a tag run reaches the final release-publication step.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: RELEASE.md -->

The workflow-level permission is `contents: read`. Its one `package` job
replaces that default with `contents: write`, `id-token: write`, and
`attestations: write`: release creation, OIDC identity, and provenance creation
are all confined to that job.
<!-- Source: ../release/actions-terminal-record.md -->

All external actions in the workflow are pinned to 40-character commit SHAs,
and `npm run security:actions` checks that property across every workflow.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: scripts/check-workflow-pins.mjs -->
<!-- Source: package.json -->

## Follow the artifact through the job

The release job installs both dependency trees with lifecycle scripts disabled,
runs `verify:all`, builds the extension, runs `package:smoke`, and executes the
integration suite under `xvfb`. It then runs `npm run package` and requires
exactly one root-level `.vsix`.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

The single resolved VSIX path is reused by every later consumer. Before any
attestation or upload, `scripts/check-vsix-smoke.mjs` inspects that exact file
for archive safety, the closed content policy, size bounds, and required
manifest values. This is separate from `package:smoke`, whose qualified VSIX is
created in a temporary directory.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: scripts/package-vsix-smoke.mjs -->

The job generates three release payloads:

| File | How it is produced | Provenance subject? |
|---|---|---|
| the single `*.vsix` | `npm run package` | yes |
| `schegent-sbom.cdx.json` | `npm sbom --sbom-format cyclonedx` | yes |
| `SHA256SUMS` | `sha256sum` over the VSIX and SBOM | no |

<!-- Source: ../release/actions-terminal-record.md -->

`actions/attest-build-provenance` attests the VSIX and CycloneDX SBOM after the
released-package policy passes. `SHA256SUMS` is deliberately not attested: its
contents are the hashes of the two subjects, and verifying each subject's
attestation is the stronger identity check.
<!-- Source: ../release/actions-terminal-record.md -->

All three files are uploaded as the `schegent-release-artifacts` workflow
artifact with 90-day retention. On a tag run, the final step creates a durable
GitHub Release containing the same three paths. A pre-existing Release for the
tag is a hard failure rather than an update, and every `v0.*` tag is marked as a
prerelease.
<!-- Source: ../release/actions-terminal-record.md -->

## Observe a tag run

Start from the published tag and record these immutable identifiers:

- tag name;
- root manifest version at the tagged commit;
- tagged commit SHA;
- `Release package` run URL or identifier;
- workflow source path `.github/workflows/release.yml`;
- published GitHub Release URL or identifier.

The tag and manifest version must match, and the workflow run must be for the
tag's commit rather than a manual run or a run for another tag.
<!-- Source: ../release/actions-terminal-record.md -->

Read the job log in order and record evidence for each load-bearing boundary:

1. `Check the tag matches the manifest version` names the same tag and manifest
   version.
2. `Package smoke` succeeds after the build.
3. `Integration tests` succeeds before final packaging.
4. `Resolve the released package` finds exactly one VSIX.
5. `Released package policy` succeeds against that resolved filename.
6. SBOM and checksum generation succeed.
7. `Attest build provenance` succeeds for the VSIX and SBOM.
8. The artifact upload succeeds before `Publish the GitHub Release`.

<!-- Source: ../release/actions-terminal-record.md -->

Record the file count and compressed/uncompressed byte counts printed by the
released-package policy. If the temporary `Package smoke` step and final policy
step report different content, do not assume the final file is equivalent;
investigate the package inputs and the two archive paths.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: ../release/actions-terminal-record.md -->

## Verify downloaded payloads

Download the VSIX, `schegent-sbom.cdx.json`, and `SHA256SUMS` from the same
GitHub Release into an otherwise empty directory. First check the two hashes
against the downloaded checksum file:

```bash
sha256sum --check SHA256SUMS
```

The workflow creates `SHA256SUMS` with GNU `sha256sum` over exactly the VSIX and
SBOM. A successful check establishes consistency with that downloaded digest
file; it does not by itself authenticate who produced either file.
<!-- Source: ../release/actions-terminal-record.md -->

Then verify each attested subject using the repository identity and the exact
signer workflow:

```bash
gh attestation verify <downloaded-vsix> \
  --repo <owner>/<repository> \
  --signer-workflow <owner>/<repository>/.github/workflows/release.yml

gh attestation verify schegent-sbom.cdx.json \
  --repo <owner>/<repository> \
  --signer-workflow <owner>/<repository>/.github/workflows/release.yml
```

Use the actual repository owner/name and downloaded VSIX filename. The release
body generated by the workflow publishes the first command shape, and the
workflow attests both subjects. Preserve the successful verification output in
the observation record.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: RELEASE.md -->

As an independent content check, run the repository policy against the
downloaded VSIX from a checkout of the release source:

```bash
node scripts/check-vsix-smoke.mjs <downloaded-vsix>
```

This confirms the archive still satisfies the current checkout's content and
manifest policy. Record the checker revision as well as its result: running a
newer policy against an older release is not the same observation as the
policy step from the tagged workflow.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: ../release/actions-terminal-record.md -->

Inspect the SBOM as the document paired with that VSIX; do not substitute an
SBOM generated from a later checkout. The workflow's attestation binds the
downloaded SBOM bytes, while its checksum file pairs those bytes with the VSIX
inside the same release asset set.
<!-- Source: ../release/actions-terminal-record.md -->

## Interpret the evidence precisely

- A matching `SHA256SUMS` result proves transfer integrity relative to the
  checksum file, not workflow identity.
- A successful attestation verification binds the subject to the named
  repository and signer workflow; it does not mean the VSIX passed an unrelated
  policy revision.
- A successful released-package policy step proves the exact resolved VSIX
  passed the policy at the tagged commit.
- A successful integration step exercises the built extension before final
  packaging; the workflow does not reinstall the released VSIX into a second
  VS Code host.
- A GitHub Release proves durable publication by this workflow. It is not
  Marketplace publication.

<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: RELEASE.md -->

No checked-in workflow or npm script publishes to the Visual Studio Marketplace,
and the repository encodes no Git-tag signing requirement. Record either policy
only when separately supported by external operational evidence.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->
<!-- Source: RELEASE.md -->

## Observation record

For each release, keep a compact record like this:

| Claim | Evidence | Result |
|---|---|---|
| Tag equals manifest version | tag, manifest value, parity-step log | pass/fail |
| Source identity | tag commit SHA and run identifier | observed/not observed |
| Final VSIX policy | released-package log and policy counts | pass/fail |
| Payload integrity | checksum verification output | pass/fail |
| VSIX provenance | attestation verification output | pass/fail |
| SBOM provenance | attestation verification output | pass/fail |
| Durable publication | GitHub Release and three asset names | observed/not observed |
| Consumer smoke | environment and result for the downloaded VSIX | pass/fail/not run |

Do not mark provenance observed from a green build alone. The observation is
complete only when the published subjects have been downloaded and their
attestations verified against the repository and workflow identity.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: RELEASE.md -->

## Failure triage

- A parity failure means the tag does not match the committed root manifest;
  do not publish that artifact or silently retag it.
- Zero or multiple VSIX files means final-package selection is ambiguous; no
  later step is authorized to choose another path independently.
- A final policy failure after `package:smoke` means the archive selected for
  release differs in a policy-relevant way from the temporary smoke package.
- An attestation failure prevents the final GitHub Release step, because release
  creation is last.
- A release-already-exists failure requires a deliberate cleanup decision or a
  new version; the workflow refuses to update the existing release.

<!-- Source: ../release/actions-terminal-record.md -->
