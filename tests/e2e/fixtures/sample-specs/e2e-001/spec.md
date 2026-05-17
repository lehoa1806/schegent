# Sample feature for E2E pipeline test

This minimal spec exists for the deterministic Speckit pipeline E2E test
([tests/e2e/pipeline.test.ts](../../pipeline.test.ts)). The fake-claude
stub at [../fake-claude/index.js](../fake-claude/index.js) does not read
this file — the test runner inspects its existence only to validate that
the controller's "feature directory" resolution path is exercised.

## Business problem

Operators want a deterministic regression net that catches divergence
between the runner's argv shape, the `[SCHEGENT_STATUS: ...]` parser, the
audit-log fenced-block schema, and the controller's phase advancement.

## Success criteria

- Driven by the real `ClaudeCliRunner` (no test double).
- Driven by the fake-claude stub spawned at `schegent.cli.path`.
- Exercises all seven phases in order: specify → clarify → plan → tasks
  → analyze → implement → finalize.
- Exercises the clarify/analyze loop (mode=`loop-once`).
- Exercises rate-limit retry (mode=`rate-limit`).
- Exercises fatal-signature termination (mode=`fatal`).
- Asserts: terminal `WorkflowRun.status`, audit-log line count, no lock
  leak after dispose, telemetry projection cleared.
