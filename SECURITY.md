# Security policy

## Supported versions

This repository does not declare a supported-version window, long-term-support line, or backport policy. `package.json` identifies the current source version as `0.2.0`, but neither the disclosure policy nor the release workflow promises that this version—or any older line—receives security fixes. Do not infer support from a tag or version number; report the affected version or commit so the maintainers can triage it.

<!-- Source: package.json -->
<!-- Source: .github/SECURITY.md -->
<!-- Source: .github/workflows/release.yml -->

## Report a vulnerability

Do not publish suspected vulnerabilities in an issue, discussion, or pull request. Use one of the two private channels:

1. Submit a [private GitHub Security Advisory](https://github.com/lehoa1806/schegent/security/advisories/new). This is the preferred channel.
2. If GitHub private reporting is unavailable to you, email [hoalee1806@gmail.com](mailto:hoalee1806@gmail.com).

Include a description, reproduction steps, and the affected version or commit. The maintainers target acknowledgement within 7 calendar days and resolution within 90 calendar days. Resolution may be a shipped patch, a documented mitigation, or an explained close-as-won't-fix; a complex or coordinated case may receive an agreed extension before day 90.

<!-- Source: .github/SECURITY.md -->
<!-- Source: .github/ISSUE_TEMPLATE/security.yml -->
<!-- Source: .github/ISSUE_TEMPLATE/config.yml -->

## Scope

Reports about the code shipped by this repository are in scope, including the extension host, webviews, host/webview IPC, local state and ownership gates, audit and log handling, central redaction, process-definition import/export, and the Claude, Codex, and Agy runner adapters. Documentation that materially misstates a security-sensitive behavior is also useful to report privately.

<!-- Source: src/extension.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/lib/logger.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/process-yaml/import-planner.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->

The upstream Claude, Codex, and Agy CLIs are outside this repository's implementation scope. So are VS Code itself, unrelated extensions, and a workstation compromise that already grants the attacker the operator's local permissions. Reports about those components should go to their maintainers; when uncertain, report privately here and the maintainers can redirect it.

<!-- Source: .github/SECURITY.md -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

## Permission posture

Claude is the default backend. Claude and Agy are launched with their CLI approval prompts off, so the agent acts without asking; their adapters unconditionally include `--dangerously-skip-permissions`. Codex is the exception: it runs with the OS-enforced `--sandbox workspace-write` bound, which leaves `.git` read-only. A Phase's `sideEffects` declaration selects consent and rollback behavior and causes a Git-writing Phase to be refused on a runner that is not Git-capable; it does not restrict the spawned subprocess. Point Schegent at a repository you can restore.

<!-- Source: package.json -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->
<!-- Source: src/activation/git-approval.ts -->

The detailed operator threat catalog covers T1–T25 in [the threat model](docs/security/threat-model.md). It records mitigations and residual risk; it is not a claim that local autonomous execution is safe against every input.

<!-- Source: tests/lint/threat-id-anchor-parity.test.ts -->
<!-- Source: src/runner/prompt-builder.ts -->

## Automated security checks

| Control | Coverage and trigger | Enforcement |
|---|---|---|
| Dependabot | Root and `webview-ui` npm manifests; weekly Monday minor/patch updates; major updates ignored | Opens grouped dependency pull requests, up to 10 per manifest. <!-- Source: .github/dependabot.yml --> |
| CodeQL | JavaScript/TypeScript on pushes and pull requests targeting `develop`, plus Tuesday 04:00 UTC | Uploads `security-extended` findings; the workflow states findings do not fail the build by default. <!-- Source: .github/workflows/codeql.yml --> |
| Dependency review | Lockfile changes in pull requests targeting `develop` | Fails on newly introduced vulnerabilities of high severity or above. <!-- Source: .github/workflows/dependency-review.yml --> |
| npm audit | Root and `webview-ui` lockfiles, Monday 03:00 UTC or manual dispatch | Runs `npm audit --audit-level=low`; it does not auto-fix or commit. <!-- Source: .github/workflows/security-audit.yml --> |
| Secret scan | Git-tracked files except `tests/**` and `package-lock.json`, checked for four code-resident private-key/token signatures in `verify:all` | `scripts/scan-secrets.mjs` is run by `npm run security:secrets`; it is a narrow signature check, not a general secret scanner. <!-- Source: package.json --><!-- Source: scripts/scan-secrets.mjs --> |
| Workflow pin check | GitHub Actions references in `verify:all` | `scripts/check-workflow-pins.mjs` requires immutable action pins. <!-- Source: package.json --><!-- Source: scripts/check-workflow-pins.mjs --> |
| License check | Root manifest and license operations record in `verify:all` | `scripts/check-licenses.mjs` checks that `LICENSE.md` and `docs/operations/licenses.md` exist and that the manifest has a truthy `license` field; it does not inspect dependency licenses. <!-- Source: package.json --><!-- Source: scripts/check-licenses.mjs --> |
| Release provenance | Tagged or manually dispatched release builds | Builds the VSIX, emits a CycloneDX SBOM and checksums, attests the VSIX and SBOM, and publishes a GitHub Release only for tags. <!-- Source: .github/workflows/release.yml --> |

No Snyk or Semgrep configuration or invocation exists in the repository.

<!-- Source: package.json -->
<!-- Source: .github/workflows/codeql.yml -->
<!-- Source: .github/workflows/security-audit.yml -->
