# Schegent security policy

The canonical vulnerability-disclosure policy is [the repository-root security policy](../SECURITY.md). This copy exists so GitHub's Security tab resolves the same policy; when the two appear to disagree, the root file is authoritative.

## Private reporting

Do not publish a suspected vulnerability in an issue, discussion, or pull request. Submit a [private GitHub Security Advisory](https://github.com/lehoa1806/schegent/security/advisories/new), or email [hoalee1806@gmail.com](mailto:hoalee1806@gmail.com) when GitHub private reporting is unavailable. Include reproduction steps and the affected version or commit. The response targets are acknowledgement within 7 calendar days and resolution within 90 calendar days, with an agreed extension for complex or coordinated cases.

<!-- Source: SECURITY.md -->
<!-- Source: .github/ISSUE_TEMPLATE/security.yml -->
<!-- Source: .github/ISSUE_TEMPLATE/config.yml -->

## Scope

Reports about the shipped extension host, webviews and IPC, ownership gates, local evidence and redaction, process-definition exchange, and the Claude, Codex, or Agy adapters are in scope. Upstream CLI behavior, VS Code itself, unrelated extensions, and an already compromised workstation are outside this repository's implementation scope.

<!-- Source: src/extension.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/lib/logger.ts -->

The detailed operator threat catalog currently covers T1–T25. Host code normally appends structured audit records, but the workspace audit file is not a tamper-proof ledger: Schegent has no hash chain or post-write tamper detector.

<!-- Source: docs/security/threat-model.md -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: tests/lint/threat-id-anchor-parity.test.ts -->
