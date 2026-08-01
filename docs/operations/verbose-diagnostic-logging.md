# Verbose Diagnostic Logging

When `schegent.logging.verbose: true` is set in workspace or user
settings, the Claude CLI runner appends `--debug-to-file`,
`--output-format stream-json`, and `--verbose` to every CLI invocation
and tees the resulting streams into three sibling files per invocation
under your workspace:

```
<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
                                          ├── debug.json     # CLI request/response payloads
                                          ├── stream.jsonl   # teed stdout (stream-json events)
                                          └── verbose.log    # teed stderr (CLI internal trace)
```

Verbose mode is **opt-in, off by default, intentionally unredacted**.
Use it for hard-to-reproduce phase failures where the sanitized audit
log has redacted the relevant context. See
[docs/security/threat-model.md](../security/threat-model.md) T10 for the
trust boundary and residual risk.

## Enable / disable

VS Code Settings (JSON):

```json
{ "schegent.logging.verbose": true }
```

You do not need to reload the window — the setting is read at the start
of every phase invocation. Toggling off drops the flags on the next
invocation; previously written diagnostic files are not deleted.

## What stays the same

- **Audit log** — `.schegent/audit.log` is byte-identical between
  verbose-on and verbose-off runs of the same fixture (excluding
  wall-clock timestamps and run-scoped IDs). The structured record
  remains the canonical, sanitized source of truth.
- **Raw transcript** — `.schegent/sessions/raw-<runId>.log` (feature 008)
  is unchanged and continues to be written in both modes. Verbose
  diagnostics are a sibling sink, not a replacement.

## When a write fails

Verbose writes are best-effort. Directory or per-file failures fold into
a single one-shot warning per slot on the audit entry's `warnings`
field. The run never fails solely on diagnostic-write errors.

Inspect failures:

```bash
grep '"warnings"' .schegent/audit.log | jq '.payload.warnings'
```

## Cleaning up

Delete `.schegent/sessions/<runId>/` (or the entire `.schegent/`
directory) when a debug session is finished. The verbose diagnostic
files are intentionally unredacted — review before sharing and never commit.
Complete inactive-run groups are automatically pruned by the shared
session-artifact age and byte budgets; the Settings surface reports retained
usage and any contained sweep failures.

## Canonical reference

For the full operator-facing walkthrough, including the worked
debugging example, see
[specs/010-pipeline-resilience/quickstart.md](../../specs/010-pipeline-resilience/quickstart.md)
§4 and §5.

## See also

- [inspect-raw-transcripts.md](inspect-raw-transcripts.md) — the
  feature-008 raw transcript writer, which is independent of verbose
  mode.
- [docs/security/threat-model.md](../security/threat-model.md) T10 —
  trust boundary and operator responsibilities.
