# Trust scopes

Restored under FR-R3-062. This page is cited by two `schegent.trust.*` settings in the extension
manifest and by three trust-banner bodies the webview shows an operator, so its absence was a dead
reference reachable from the product UI.

Sourced from `src/state/capability-trust-resolver.ts` and
`src/ui/sidebar/commands/trust-gate.ts`.
<!-- Source: src/state/capability-trust-resolver.ts -->
<!-- Source: src/ui/sidebar/commands/trust-gate.ts -->

## What a trust scope gates

Two capabilities, and only two:

| capability | setting | what it gates |
|---|---|---|
| `phases` | `schegent.trust.allowCustomPhases` | Saving non-default phase definitions. |
| `retryConditions` | `schegent.trust.allowCustomRetryConditions` | Saving a non-default `retryCondition` DSL expression on a phase row. |

Both gate document **content**, not layering. A row's own default retry-condition is unaffected by
`retryConditions` being denied.

## The resolution ladder

Four steps, in order, evaluated on every call:

1. **VS Code workspace trust.** If `workspace.isTrusted` is `false`, every capability is denied.
   This is a **ceiling**: no `schegent.trust.*` value widens it. Setting one to `true` on an
   untrusted workspace does not grant the capability.
2. **Workspace-scope override.** A literal `true` or `false` in workspace settings decides.
3. **User-scope override.** A literal `true` or `false` in user settings decides.
4. **Otherwise: allowed.** The default is trusted, so an operator who sets nothing gets today's
   behaviour.

Only the literal booleans short-circuit a layer. `null` — the shipped default — and an absent value
both mean "no override, fall through". That is why the default is `null` rather than `true`: `true`
would be an override that stops the ladder, and the two are not the same thing.

## When a capability is denied

The write is refused **at the IPC layer**, before it reaches storage, and a
`trust.capability-denied` audit event is recorded. The webview receives a typed denial naming which
of the three reasons applied — workspace trust, workspace scope, or user scope — which is what the
three banner bodies distinguish.

## Freshness

Nothing is cached. Every resolution re-reads `isTrusted` and `inspect()`, per the hard rule against
caching settings on long-lived objects. The configuration listener exists only to tell the webview
projector that a re-read is worth doing; it is not what makes the answer current.

## Related

- [Configuration reference](../reference/settings.md) — the settings themselves.
- [Audit events](../reference/audit-events.md) — `trust.capability-denied`.
