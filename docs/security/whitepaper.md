# Schegent security white paper

## Executive summary

Schegent coordinates autonomous local CLI processes from a VS Code extension. Claude is the default runner; Claude and Agy disable CLI approval prompts and act without asking, while Codex uses the `workspace-write` sandbox and leaves `.git` read-only. The extension adds input validation, workspace-trust and ownership gates, bounded process lifecycle handling, centralized redaction, and local evidence, but it does not verify model intent or promise that a backend cannot reach beyond the workspace.

<!-- Source: package.json -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->

## Security boundary

The deployed product is local: one extension-host bundle, two local webviews, VS Code `workspaceState`, workspace files under `.schegent/`, and child CLI processes. There is no production HTTP, WebSocket, REST, GraphQL, or remote multi-user service. Both webview content-security policies set `connect-src 'none'`.

<!-- Source: package.json -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: src/extension.ts -->
<!-- Source: src/ui/sidebar/csp.ts -->

The host itself has no application network client in the request path described here. Backend CLIs can make their own network requests under their own implementation and environment; local-first is therefore not an offline-execution promise.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

## Authority controls

### Workspace trust

Mutating webview commands fail closed unless VS Code reports the workspace trusted. A missing callback, exception, or non-`true` result rejects the request. Restricted activation keeps the placeholder UI and reset surface separate from workspace-bound runtime construction.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/extension.ts -->

### Window primacy and mutation serialization

Every command classified in `MUTATING_COMMAND_REASONS` also requires the current window to hold authoritative filesystem-backed ownership. Accepted mutations execute serially, and correlation IDs support bounded acknowledgement replay. `CMD_READ_METRICS` is the sole primary-gated read because it scans shared archives.

<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/ui/sidebar/mutation-command-executor.ts -->
<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->

### Catalog capability gates

Phase authoring requires the `phases` capability, and a newly supplied Phase body declaring `retryCondition` additionally requires `retryConditions`. These checks supplement workspace trust and primacy; removal operations do not add a content capability.

<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->

### Run approval

Runs containing a Phase that declares `git` or `unrestricted` effects require the operator's modal approval for the exact mutation-plan fingerprint. The receipt is checked again at dispatch. The declaration controls consent and rollback planning; it does not restrict what Claude or Agy can attempt. Git-writing work is refused on Codex because its sandbox leaves `.git` read-only.

<!-- Source: src/activation/git-approval.ts -->
<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

## Input handling

Webview traffic passes through a closed 61-command runtime validator before routing. Invalid input is logged and dropped without a handler acknowledgement. Process YAML uses a size-bounded, closed scanner/parser rather than a general YAML loader; preflight writes nothing and publication rechecks revision and capability gates.

<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/services/process-yaml/yaml-scanner.ts -->
<!-- Source: src/services/process-yaml/yaml-parser.ts -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->

Local file requests use workspace-relative lexical checks. A Phase sidecar receives a stronger canonical-path containment check: the host derives the expected `phase-message.env` location from run identity and refuses an audit-reported fallback path that does not canonicalize to it.

<!-- Source: src/services/run-request/workspace-containment.ts -->
<!-- Source: src/services/run-request/local-input-validator.ts -->
<!-- Source: src/controller/phase-sidecar-reader.ts -->

CLI stdout remains untrusted model output. Phase outcome classification considers the trailing region at or after the last complete audit block, while Claude process-control termination arms only on the parsed stream-json result envelope rather than a content substring.

<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/runner/claude-cli.ts -->

## Process boundary

All adapters spawn with `shell: false`, prompts on stdin, an explicit `cwd`, bounded stdout/stderr buffers, idle timeout, abort-signal cancellation, and TERM-to-KILL escalation. Monitor hooks are observational and cannot throw into process control. Retry policy stays outside the adapters.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->
<!-- Source: src/runner/claude-cli.ts -->

Environment forwarding defaults to `allowlist`, which includes bootstrap variables plus explicitly named entries. `minimal` narrows further; `inherit` restores the ambient extension-host environment. The credit watchdog's internal status invocation currently supplies no policy and therefore inherits, an explicit exception recorded in the command reference.

<!-- Source: package.json -->
<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/watchdog/credit-watchdog.ts -->

## Evidence boundary

`SanitizedLogger` owns one `SECRET_PATTERNS` set for operator-visible logs. The structured audit writer emits schema-v3 JSONL, and host code appends through one writer and rotates by configured size/age. The write path is a convention; the tamper evidence is separate and real. Since FR-R3-112 each entry carries the previous entry's sha256 digest, so an alteration that does not recompute every later digest is named by `npm run audit:verify`. It is evident, not impossible: there is no signature and no anchor outside the workspace, the chain head sits on the same disk, and an operator or backend process that can alter the file can recompute the digests that follow — what it cannot do is change one entry and leave the rest consistent. The live append path is still not passed through the canonical-path oracle before `fs.appendFile`.

<!-- Source: src/lib/logger.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/services/phase-log/phase-log-sanitizer.ts -->

Raw transcripts and verbose diagnostics are different: they can contain unredacted prompts, source, model output, and environment-derived diagnostics. Raw-transcript mode defaults to `errors-only`; verbose diagnostics default off and apply only to Claude. Age/byte retention can remove inactive session artifacts, but neither control edits the structured audit log.

<!-- Source: package.json -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->

Recovery checkpoints are another sensitive surface outside session retention. They live under extension `globalStorage/checkpoints`; a checkpoint can contain `git diff --binary --no-ext-diff HEAD` plus Run metadata. Directories and files are requested as `0700` and `0600`. A separate fixed policy removes artifacts older than 14 days and enforces 256 MiB total while protecting the ten most recent Run directories from the size bound. Session retention settings do not govern these files.

<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->

Two workspace-local stores also deserve separate treatment. `.schegent/cli-transport.log` passes through the shared sanitizer but deliberately retains paths from backend output. `.schegent/history/<runId>.txt` stores a full sanitized Task description at mode `0600`; pattern redaction does not make arbitrary operator prose non-sensitive.

<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/lib/logger.ts -->

## Failure modes and residual risk

| Failure | Code behavior | Residual risk | Source |
|---|---|---|---|
| Backend hangs | Idle timeout terminates the child; cancellation is separately observable. | Output can keep resetting the idle timer, so a noisy process can run until another bound intervenes. | <!-- Source: src/runner/process-lifecycle-runner.ts --> |
| Secondary window mutates | Trust and primacy gates reject before handler work. | Direct VS Code commands have their own guard profiles; they are not all routed through webview mutation metadata. | <!-- Source: src/ui/sidebar/message-router.ts --><!-- Source: src/activation/ui-wiring.ts --> |
| Audit persistence is altered | Host code appends and rotates through one writer. | There is no tamper detector; other local processes can modify/delete the file, and a planted live-file symlink can redirect an ordinary append. | <!-- Source: src/audit/audit-log-writer.ts --> |
| Raw local evidence is shared | Generated ignore rules reduce accidental commits. | Ignore files do not encrypt or revoke already copied content. | <!-- Source: src/audit/schegent-gitignore.ts --><!-- Source: src/audit/raw-transcript-writer.ts --> |
| Model reports success falsely | The parser classifies the model's structured report. | The host checks report shape and declared-output existence, not correctness. | <!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/services/run-output/run-output-resolver.ts --> |
| Concurrent Runs edit one checkout | Queue/run attribution and separate execution leases preserve identity. | File edits may interleave; the operator resolves conflicts. | <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: src/state/execution-lease.ts --> |
| Persisted state is incompatible | Forward migrations handle known older schemas; a future schema is refused. | A faulty migrator is itself a one-time state mutation. | <!-- Source: src/state/workspace-state.ts --><!-- Source: src/state/queue-state-migrator.ts --> |

## Operator controls

- Leave a workspace untrusted to keep workspace-bound execution inactive. <!-- Source: src/extension.ts -->
- Choose Codex when its `workspace-write` filesystem bound fits the Phase; Git-writing Phases cannot use it. <!-- Source: src/runner/codex-cli.ts --><!-- Source: src/config/phase-runner-policy.ts -->
- Keep `schegent.cli.environmentMode` at `allowlist` or select `minimal`; add only required variable names. <!-- Source: package.json -->
- Keep raw transcript mode at `errors-only` or set `off`; leave verbose diagnostics disabled unless actively diagnosing. <!-- Source: package.json -->
- Set the global queue concurrency cap to `1` to avoid simultaneous Runs in one checkout. <!-- Source: package.json --><!-- Source: src/services/auto-drain-coordinator.ts -->
- Export metadata-only audit evidence with `schegent.exportAuditLog`; do not share raw sessions. <!-- Source: package.json --><!-- Source: src/commands/export-audit.ts -->

## References

- [Operator threat catalog](threat-model.md)
- [Permission-posture decision](../concepts/unprompted-agent-not-contained.md)
- [Backend operational contract](../operations/backends.md)
- [Security reporting policy](../../SECURITY.md)

<!-- Source: tests/lint/backend-permission-posture.test.ts -->
<!-- Source: tests/lint/threat-id-anchor-parity.test.ts -->
