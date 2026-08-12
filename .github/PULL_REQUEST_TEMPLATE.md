<!--
Thanks for opening a pull request against schegent.

This template is informational. None of the boxes below block merge automatically;
they exist so the reviewer can triage quickly. Please fill in what you can — and
do NOT paste secrets, raw logs, or environment variables anywhere in this body.
-->

## Summary

<!-- 1-3 bullets describing what changed and why. Skip the *how*; the diff speaks for itself. -->

-
-

## Test plan

<!--
Recommended pre-merge verifications. Tick each one you ran locally; leave the rest
unchecked so the reviewer knows which gates are still to come.
-->

- [ ] `npm run typecheck`
- [ ] `npm run typecheck:webview`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run ci` (the full pre-merge gate)
- [ ] Manual UI smoke (if the diff touches `webview-ui/` or `src/ui/`)
- [ ] Re-read [ARCHITECTURE.md](../ARCHITECTURE.md) if the diff touches host structure or IPC contracts

## Hard-rule self-check

<!--
Did this PR touch any of the high-stakes invariants below? Tick the box if you
intentionally touched the surface AND paste a one-line justification on the
following line. Leave it unticked if you did not. An unchecked box is NOT an
auto-rejection — it is a signal that the reviewer can move on.

Full hard-rule index: see [CLAUDE.md](../CLAUDE.md).
-->

- [ ] **Single sanitization SoT** — Touched `SECRET_PATTERNS` or the redaction set in [`src/lib/logger.ts`](../src/lib/logger.ts)? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code).
- [ ] **Primary-host gate (mutating IPC)** — Added or modified an entry in `MUTATING_COMMANDS` in [`src/ui/sidebar/message-router.ts`](../src/ui/sidebar/message-router.ts)? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code).
- [ ] **`vscode`-import bans** — Added an import (direct or transitive) of `vscode` from anywhere under [`src/headless/`](../src/headless/) or [`src/telemetry/`](../src/telemetry/)? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code).
- [ ] **Lock-release pattern** — Modified [`WorkflowController.driveRun()`](../src/controller/workflow-controller.ts) or any `WorkspaceLockManager` consumer? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code).
- [ ] **Append-only audit log** — Added a code path that deletes from `<workspaceRoot>/.schegent/audit.log` or bypasses `appendAudit`? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code) and [docs/security/threat-model.md](../docs/security/threat-model.md).
- [ ] **`-c` continuation single-append-site** — Added a code path that appends `-c` to the Claude CLI argv outside [`src/runner/claude-cli.ts`](../src/runner/claude-cli.ts)'s strict `request.isContinue === true` gate? See [CLAUDE.md](../CLAUDE.md#hard-rules-when-changing-host-code).

If you ticked any box above, please add a one-line justification per item below.

<!--
Justifications go here (one line each):
-->

## Related issues / specs

<!--
- Closes #<issue-number>
- Spec: `specs/<NNN-feature>/spec.md`
- Plan: `specs/<NNN-feature>/plan.md`
- Roadmap entry (if from the architecture refactoring & hardening plan): `docs/features/round_1/034-architecture-refactoring-and-hardening-plan.md` Item NNN
-->

## Reviewer notes

<!--
Optional. Anything you want the reviewer to look at first, any known caveats,
any follow-ups you'd file as separate PRs.

Do NOT paste:
  - raw log output (use `docs/operations/inspect-raw-transcripts.md` for redacted-by-design exporters)
  - environment variables
  - tokens, credentials, or PII
-->
