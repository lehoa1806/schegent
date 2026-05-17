# Release process

Schegent ships as a VSIX. The release gate enforces a layered CI model so
PR review stays cheap while pre-release gets the full surface area.

## CI gate layout (Feature 056 Track 6)

| Workflow | Trigger | Coverage |
|---|---|---|
| `.github/workflows/pr.yml` | `pull_request` on `main` (ubuntu/macos/windows) | typecheck (host + webview), lint, test, build |
| `.github/workflows/ci.yml` | `push` to `main`, `workflow_dispatch` | the PR set plus integration smoke and (non-blocking) `test:perf` |
| `.github/workflows/full-gate.yml` | weekly `cron: '0 6 * * 1'`, `workflow_dispatch` | all 7 jobs: typecheck (host), typecheck (webview), lint, unit tests, build, deterministic E2E (feature 055), `@vscode/test-electron` integration smoke |
| `.github/workflows/security-audit.yml` | weekly `cron: '0 3 * * 1'`, `workflow_dispatch` | root and webview `npm audit --audit-level=low`, findings as GITHUB_STEP_SUMMARY annotations |

The PR gate is fast (<10 min target). The full gate is slow (E2E +
integration) and is **not** a blocker on individual PRs; it gates
release candidates only.

## Pre-release checklist

Required before tagging a release:

1. **Full gate green**: latest run of `.github/workflows/full-gate.yml`
   on `main` must be green AND less than 7 days old. Trigger manually
   if needed:
   ```bash
   gh workflow run full-gate.yml --ref main
   gh run watch
   ```
   All seven jobs must succeed (`typecheck-host`, `typecheck-webview`,
   `lint`, `test`, `build`, `e2e`, `integration`).

2. **Security audit clean (or triaged)**: latest run of
   `.github/workflows/security-audit.yml` on `main` should show zero
   advisories at `--audit-level=low`. If any remain, document the
   triage decision in the release notes:
   - Direct deps with a compatible fix → land the fix in a separate PR
     and re-run the audit.
   - Transitive deps with no compatible fix → document in this file
     under **Known dependency findings (post-audit)** and ship.

3. **Manual smoke**: launch the extension in `--extensionDevelopmentPath`
   mode and exercise the [quickstart](specs/056-principal-arch-hardening/quickstart.md)
   end-to-end on a real workspace.

4. **CHANGELOG / version bump**: bump `package.json` `version` and
   prepend a changelog entry; if the spec dir under `specs/` introduced
   a new track of work, list its FR coverage.

5. **Tag and publish**: `git tag vX.Y.Z`, `git push --tags`, then run
   `vsce package` and upload to the Marketplace.

## Dependency hygiene

- Root and webview audits run weekly on Mondays at 03:00 UTC via
  `.github/workflows/security-audit.yml`. Findings appear as workflow
  step-summary annotations only; the workflow does **not** apply fixes
  automatically.
- Operators (release shepherds) triage in a single, compatibility-safe
  dependency-refresh PR. The two chains most prone to advisories are:
  - Root: Vite / Vitest / esbuild
  - Webview: Svelte / devalue / Vite / esbuild
- **Never** run `npm audit fix --force` as part of a release. Forced
  major-version upgrades change behavior (e.g., Vite 5→6 changes the
  default Rollup output shape). Major upgrades require an explicit
  spec / plan, not a one-line fix.
- After applying compatibility-safe minor/patch bumps, re-run the full
  gate before publishing.

## Known dependency findings (post-audit)

Document any advisories that remain after a release here, with:

- CVE / advisory id
- Affected package + version
- Reason for deferring (no compatible fix, behavioral risk, etc.)
- Tracking issue or follow-up PR link

(Empty at time of writing — refresh on each release.)

## Workflow trigger reference

```bash
# Manually trigger the full gate before tagging a release.
gh workflow run full-gate.yml --ref main

# Trigger a security audit on demand.
gh workflow run security-audit.yml --ref main

# View latest run for either workflow.
gh run list --workflow=full-gate.yml --limit=5
gh run list --workflow=security-audit.yml --limit=5
```

## Why we keep three workflows instead of one

The PR gate is hot-path. Forcing every PR through E2E + integration
would add 15-20 minutes to the median review cycle and surface flake
that would land on the wrong PR. By splitting:

- PR authors get fast feedback on typecheck / lint / test / build.
- Release shepherds get full coverage on a known cadence.
- Flake in the slow tracks (E2E especially, per Feature 056 R4) is
  isolated from individual PRs and addressed in a focused follow-up.
