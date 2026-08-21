# Custom Retry Conditions

Operators can author custom phases that loop on numeric metrics emitted
by the model — not just the legacy Open Questions / Remaining Issues
contract. Declare `retryCondition: "<expression>"` on a phase definition
and the controller evaluates the boolean expression against the captured
metrics map after every well-formed CLI invocation.

The expression DSL is **sandboxed**: identifiers, signed numeric
literals, comparisons (`> >= < <= == !=`), logical combinators
(`and / or / && / ||`), unary `not / !`, and parentheses. No arithmetic,
function calls, member access, or chained comparisons. See
[docs/security/threat-model.md](../security/threat-model.md) T11.

## Length limit

A `retryCondition` may be at most **512 characters**. The limit is on the
character count of the expression as you wrote it, not on its byte length,
and it is checked before the expression is tokenized — an over-long
condition is refused without being parsed at all.

512 is generous for what the grammar admits. The longest condition
shipped with the product is 77 characters, and the longest identifier the
grammar accepts is 24, so an eight-clause condition still lands around
236. If you are near the limit, the condition is almost certainly doing
work that belongs in the prompt: have the phase emit one summary metric
and compare against that.

All three routes that can refuse the condition say the same sentence, so
you only have to learn it once:

> retryCondition is 613 characters; the maximum is 512

(with the real count in place of 613 — the message names how far over you
are, not just the limit). What differs between the routes is what happens
to the condition:

| Route | What happens |
|---|---|
| Importing a `.pipeline.yaml` / phase YAML | The import is refused, with `retryCondition` reported as `invalid-length`. Nothing is written. |
| Editing a phase in the catalog | The phase is saved, but resolves as **invalid** with the same `invalid-length` code and is excluded from the effective catalog until you shorten it. The body you typed is kept exactly as you typed it — nothing truncates it for you. |
| A condition already stored, reached at run time | The evaluation is refused, so the phase advances rather than looping. The `phase.retry_evaluated` event records `decision: false`, `evaluationError: true`, and the message in `errorMessage`. |

Note that the refusal is reported as a **length**, not as an invalid
expression. A 600-character condition with perfect syntax is still
refused, and the message says so rather than sending you looking for a
syntax error that is not there.

One surface deliberately does **not** report it: the inline editor's
live valid/invalid verdict as you type is a syntax check only, so a
600-character condition with good syntax still reads as valid there. The
length is enforced when the phase is resolved, which is the boundary that
decides whether the catalog accepts it. If the editor says valid and the
saved phase comes back `invalid-length`, that is this, not a
contradiction.

Two things the bound deliberately does not do. It does not rewrite
anything: an over-long condition already in your catalog stays byte for
byte as you wrote it, so you can read it, shorten it, and keep the part
you wanted. And it does not change the sandbox — the same grammar applies
at 1 character as at 512.

## Minimal worked example

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: review
  name: Review
  version: 1
spec:
  instruction: "Audit src/. End your audit log with: 'unresolved_findings: <count>'."
  loopable: true
  retryCondition: unresolved_findings > 0
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
| Phase loops forever then halts with `cause: "cap_exhausted"` | `schegent.loop.maxIterations` (default 10) is the hard ceiling. Lower the expected metric, raise the cap, or force past it (below). |
| One-shot warning about reserved key | A reserved field name (`status`, `model`, `effort`, `pipelineId`, …) collided with a metric. Rename your metric. |
| One-shot warning about non-finite / non-numeric value | Model emitted `NaN`, `Infinity`, or text like `many`. Update your prompt to emit a finite number. |
| Workspace activation logs a single retry-condition warning at load time | Syntactically invalid expression. The phase remains loadable with default loop semantics. Fix the expression and reload. |
| Import refused, or a catalog phase shows `invalid-length` on `retryCondition` | Over 512 characters. See [Length limit](#length-limit) — the condition is not parsed, so this is not a syntax error. |

## Forcing a run past an exhausted cap

A `retryCondition` that never goes falsy halts the run with
`cause: "cap_exhausted"`. That is the default and it is the safe answer:
whatever the condition gated has not happened. When the remaining work
genuinely cannot be done in-process — a phase whose completion depends on
a manual step the headless runner cannot perform — the halt can be
converted into an advance:

| Surface | Effect |
|---|---|
| `schegent.retry.forceContinueOnCap` (default `false`) | Workspace-wide default for every phase. |
| `forceContinueOnRetryCap: true` on a phase | Per-phase override; an explicit `false` wins over a workspace default of `true`. |

When it fires, the run advances to the successor phase and records a
warning under the `[notify] forced-continue` tag naming the phase, the
cap, and the successor, and stating that whatever the condition gated is
**unverified**. Search the runtime log for the tag to find every run that
took the hatch:

```bash
grep '\[notify\] forced-continue' .schegent/syslog
```

Two limits are deliberate. The hatch applies **only** to cap exhaustion —
a phase that ends `failed`, `timeout`, `skipped`, `rate_limited`, or
`transient_error` is terminal before the cap is consulted, so this never
converts a genuine failure into an advance. And it does not mark the
gated work as done; it records that the run continued without it.

## Canonical reference

For the full DSL grammar, supported / unsupported constructs, prompt
authoring guidance, and the cap-exhausted lifecycle, see
[specs/010-pipeline-resilience/quickstart.md](../../../specs/010-pipeline-resilience/quickstart.md)
§3.

## See also

- [docs/security/threat-model.md](../security/threat-model.md) T11 — DSL
  sandboxing and residual risk.
- [inspect-audit-logs.md](inspect-audit-logs.md) — entry shape and
  `metrics` / `warnings` field semantics.
