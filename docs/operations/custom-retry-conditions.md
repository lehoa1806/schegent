# Custom Retry Conditions

Operators can author custom phases that loop on numeric metrics emitted
by the model — not just the legacy Open Questions / Remaining Issues
contract. Declare `retryCondition: "<expression>"` on a
`schegent.phases[]` entry and the controller evaluates the boolean
expression against the captured metrics map after every well-formed
CLI invocation.

The expression DSL is **sandboxed**: identifiers, signed numeric
literals, comparisons (`> >= < <= == !=`), logical combinators
(`and / or / && / ||`), unary `not / !`, and parentheses. No arithmetic,
function calls, member access, or chained comparisons. See
[docs/security/threat-model.md](../security/threat-model.md) T11.

## Minimal worked example

```json
{
  "schegent.phases": [
    {
      "id": "review",
      "name": "Review",
      "instruction": "Audit src/. End your audit log with: 'unresolved_findings: <count>'.",
      "loopable": true,
      "retryCondition": "unresolved_findings > 0"
    }
  ]
}
```

Iteration 1 emits `unresolved_findings: 3` → loops. Iteration 2 emits
`unresolved_findings: 0` → advances.

## Tracing decisions

Every consulted `retryCondition` emits a `phase.retry_evaluated` audit
event:

```bash
grep '"eventType":"phase.retry_evaluated"' .schegent/audit.log | jq .
```

The `payload.expression`, `payload.metrics`, and `payload.decision`
fields together let you replay any loop / advance decision by running
the recorded expression against the recorded metrics.

## Common failure modes

| Symptom | Likely cause |
|---|---|
| Phase advances when you expected it to loop | Metric key not emitted at the top level of the audit log block (nested under Open Questions / Remaining Issues). Move it to the top level. |
| Phase loops forever then halts with `cause: "cap_exhausted"` | `schegent.loop.maxIterations` (default 10) is the hard ceiling. Lower the expected metric or raise the cap. |
| One-shot warning about reserved key | A reserved field name (`status`, `model`, `effort`, `pipelineId`, …) collided with a metric. Rename your metric. |
| One-shot warning about non-finite / non-numeric value | Model emitted `NaN`, `Infinity`, or text like `many`. Update your prompt to emit a finite number. |
| Workspace activation logs a single retry-condition warning at load time | Syntactically invalid expression. The phase remains loadable with default loop semantics. Fix the expression and reload. |

## Canonical reference

For the full DSL grammar, supported / unsupported constructs, prompt
authoring guidance, and the cap-exhausted lifecycle, see
[specs/010-pipeline-resilience/quickstart.md](../../specs/010-pipeline-resilience/quickstart.md)
§3.

## See also

- [docs/security/threat-model.md](../security/threat-model.md) T11 — DSL
  sandboxing and residual risk.
- [inspect-audit-logs.md](inspect-audit-logs.md) — entry shape and
  `metrics` / `warnings` field semantics.
