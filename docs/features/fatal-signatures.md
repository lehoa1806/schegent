# Fatal Signatures

Fatal signatures are verbatim substrings that, when they appear in the CLI's stdout or stderr, cause the active phase to fail fast — no retry, no continuation, immediate `phase-end` with `outcome: failure` and `cause: 'fatal-signature'`.

There are two surfaces: a **code-resident** floor of signatures that ship with the extension, and an **operator-additive** layer that you control via `schegent.fatalSignatures`.

## When fatal signatures fire

The host scans every line emitted by the CLI subprocess against the registry. If any registered signature substring appears, the active phase fails fast.

The scan is **substring** matching — case-sensitive, no regular expressions. If your signature is `"Internal error: panicked at"`, it matches any line containing that literal text.

## The two layers

### Code-resident floor

A set of signatures defined in the extension's source code at `src/lib/fatal-signature-registry.ts`. These are immutable at runtime: an operator cannot remove or modify them via settings. They cover failure modes that have historically required a fail-fast response — for example, internal CLI panics, irrecoverable auth failures, and unrecognized invocation modes.

Widening the floor requires a code change + PR review. This is by design — the floor is a safety net the operator should not be able to weaken.

### Operator-additive layer

The `schegent.fatalSignatures` setting accepts an array of strings. Each element is a verbatim substring that extends the effective registry.

```jsonc
{
  "schegent.fatalSignatures": [
    "OOM killed",
    "fatal: refusing to proceed without a clean working tree"
  ]
}
```

These additions cannot remove, modify, or reorder the built-ins. They only add.

## Built-ins always win attribution

If a built-in signature and an operator-defined signature would both match the same text, the **built-in wins** the attribution. The audit event records `source: 'built-in'`.

The scan order is:

1. Iterate built-ins. If any match, fire with `source: 'built-in'`.
2. Otherwise, iterate operator-defined. If any match, fire with `source: 'operator-defined'`.

This guarantees the operator cannot accidentally redefine a built-in signature.

## The audit event

A matched signature emits a `fatal-signature-matched` audit event:

```jsonc
{
  "eventType": "fatal-signature-matched",
  "outcome": "failure",
  "schemaVersion": 2,
  "runId": "...",
  "pipelineId": "speckit-new-feature",
  "phaseId": "speckit-implement",
  "signature": "OOM killed",
  "source": "operator-defined",
  "where": "stderr"
}
```

The active phase is immediately marked failed (`phase-end` with `cause: 'fatal-signature'`).

## How a fatal signature interacts with retry

Fatal signatures **bypass the delayed-retry machinery**. A retryable transient failure may schedule a retry; a fatal signature does not.

A retry attempted via `schegent.retryActiveRun` after a fatal failure is allowed — the operator decides whether the failure was a one-shot anomaly or a real fatal issue. The host emits `retry-manual` if the operator triggers one.

## Adding an operator-defined signature

In your workspace `settings.json`:

```jsonc
{
  "schegent.fatalSignatures": [
    "panic: unrecoverable error",
    "out of credits"
  ]
}
```

Or via the sidebar's settings panel → Logging section → **Fatal signatures**.

The setting is `resource`-scoped (per workspace). The setting is re-read at the entry of every phase invocation, so mid-run additions take effect on the next phase.

A malformed value (non-array, non-string elements, empty strings) falls back to `[]` without blocking extension activation. The host logs a one-shot warning.

## Choosing good operator-defined signatures

A good signature is:

- **Specific enough** that it does not match well-formed output. `"Error"` is a bad choice (matches every error mention); `"FATAL: insufficient disk space"` is a good choice.
- **Stable across CLI versions.** Avoid signatures that depend on a specific stack trace format that may change.
- **Verbatim.** The match is substring, not regex. Special characters are literal.
- **Indicative of an unrecoverable state.** If a retry could fix it, do not make it fatal.

## What does *not* fire a fatal signature

- A non-zero exit code alone. The host distinguishes between non-zero exits with no matching signature (which is retried if transient) and non-zero exits with a matching signature (which fail fast).
- The CLI being killed by the host (e.g., on pause). The host kill is an internal signal, not a signature match.
- A timeout. The watchdog signals timeout independently with `cause: 'timeout'`.
- A rate-limit indicator. Rate limits are classified as `rate_limit` and trigger the delayed-retry path, not fatal failure.

## Mid-run accessor pattern

The host reads `schegent.fatalSignatures` via the `FatalSignaturesAccessor` at the top of every `PhaseRunner.run()`. This mirrors `VerboseDiagnosticsAccessor` and `AutoCompactOverrideAccessor`: setting changes apply to the *next* phase boundary, never the in-flight phase.

This pattern means you can:

1. Notice a phase failing in a way the existing signatures do not catch.
2. Add a new signature to `schegent.fatalSignatures`.
3. Resume / retry. The new signature is now active on the next phase.

## Why a floor exists at all

The built-in floor exists because some CLI failure modes are simply unrecoverable. If the CLI panics, retrying does not help — you want fast failure so the operator can intervene. The floor encodes the team's collective experience about which failure modes belong in that category.

The operator-additive layer lets you customize the policy for your workspace without depending on the team to ship code changes for your specific failure modes.

## Limits

- **Substring matching only.** No regex.
- **No structured matching.** You cannot fire on "exit code 137 with no stdout"; the host's classification path handles those.
- **No de-escalation.** Once matched, the phase fails. There is no "fail unless ..." surface.
- **Per-line matching.** A signature that spans multiple lines will not match.

## A realistic example

Suppose your CLI sometimes emits this on auth-token expiry:

```text
ERROR: auth token has expired. Please run `claude login` again.
```

You want this to fail fast every time, not be retried.

Add:

```jsonc
{
  "schegent.fatalSignatures": [
    "ERROR: auth token has expired"
  ]
}
```

The next time the CLI emits that line, the active phase fails immediately, the audit log records the match, and the run is marked failed. You see it in the sidebar and can run `claude login` to fix it.

The next feature is [Auto-compact Override](auto-compact-override.md).
