# Auto-compact Override

The Claude CLI has an internal **auto-compaction** behavior: when the conversation context approaches a configured percentage of the model's context window, the CLI compacts older turns to make room for new ones. By default the CLI picks its own threshold; the auto-compact override lets you set it explicitly.

## What it does

Set `schegent.claude.autoCompactPctOverride` to an integer in `[1, 100]` and the host will export `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<n>` to the CLI subprocess environment on every phase invocation.

```jsonc
{ "schegent.claude.autoCompactPctOverride": 80 }
```

This tells the CLI to begin auto-compaction at 80% of the context window. Lower values compact more aggressively (more room for new tokens, more history elided); higher values compact later (more history preserved, more risk of overflow).

If unset (`null`) or out of range, the env var is **omitted**. The CLI uses its built-in default.

## When to use it

Most operators do not need to touch this. The CLI's default is sensible. Override when:

- You routinely hit the model's context window mid-phase and want earlier compaction.
- You are running a long `speckit-implement` phase and want to compact later so the model retains more of the early task history.
- You are debugging a context-related regression and want to test the impact of a different threshold.

If you are not sure whether you need to override, you almost certainly do not.

## How it shows up in the audit log

When the override is active and the phase invocation begins, the host emits an `auto-compact-override-applied` audit event:

```jsonc
{
  "eventType": "auto-compact-override-applied",
  "outcome": "info",
  "runId": "...",
  "phaseId": "speckit-implement",
  "value": 80
}
```

If the setting is null or out of range, no event is emitted (the env var is not exported).

## Mid-run accessor pattern

Like `schegent.fatalSignatures` and `schegent.logging.verbose`, this setting is **not cached** on the runner. The host reads it via the `AutoCompactOverrideAccessor` at the top of every `PhaseRunner.run()`. Mid-run changes apply on the next phase boundary.

This lets you toggle the override between phases — for example, run `speckit-implement` at 90 and `finalize` at the CLI default.

## Validation

The setting accepts:

- An integer in `[1, 100]` → exported as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<n>`.
- `null` → env var omitted; CLI default applies.
- An out-of-range integer (e.g., `0`, `101`) → env var omitted; CLI default applies. The host logs a one-shot warning.
- A non-integer (e.g., `"80"`, `80.5`) → rejected at settings-validation time; the setting falls back to `null`.

The setting is `resource`-scoped — you can configure it per workspace.

## Interaction with the CLI's built-in compaction logic

The CLI is the authoritative agent — it implements the compaction itself. The host only sets the env var; the CLI reads it and applies the threshold. If a future CLI version changes the compaction algorithm or the env var name, the host has nothing to migrate; the override either continues to apply (if the CLI still honors the var) or becomes a no-op (if it does not).

The host does not attempt to monitor or trigger compaction on the CLI's behalf. The setting is a hint, not a contract.

## Limits

- **Per phase, not per tool call.** The threshold applies to the whole CLI session for the phase.
- **No retry effect.** A retry after a fatal failure runs with the same threshold as the original attempt.
- **No telemetry from the host.** The host does not record what percentage was actually reached at compaction time; only that the override was applied.

## A realistic example

You are running a long `speckit-implement` phase on a 200K-context model. The phase consistently runs out of context near the end. You want compaction earlier so the late-phase tool calls have room:

```jsonc
{ "schegent.claude.autoCompactPctOverride": 70 }
```

This forces the CLI to compact at 70% rather than its default. Older tool calls are summarized; the late-phase work has more headroom.

If you instead want the model to retain more early history (at the cost of a higher overflow risk):

```jsonc
{ "schegent.claude.autoCompactPctOverride": 95 }
```

This delays compaction until 95%. Useful when the early task setup is essential and you cannot afford for the model to forget it.

## Where to find the setting in the sidebar

The sidebar settings panel exposes this row under **Retries** → **Auto-compact override**. It accepts a number or empty (the empty case maps to `null`).

The next feature is [Rate-Limit Handling](rate-limit-handling.md).
