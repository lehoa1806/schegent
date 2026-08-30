# Trust scopes

Restored under FR-R3-062. This page is cited by two `schegent.trust.*` settings in the extension
manifest and by three trust-banner bodies the webview shows an operator, so its absence was a dead
reference reachable from the product UI.

Sourced from `src/state/capability-trust-decision.ts`, which holds the ladder
itself, `src/state/capability-trust-resolver.ts`, which is the half that reads
`vscode`, and `src/ui/sidebar/commands/trust-gate.ts`. `FR-R3-143` split the two
so the ladder could be evaluated without the extension host; the four steps
below are unchanged by that move.
<!-- Source: src/state/capability-trust-decision.ts -->
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
2. **Any explicit `false` — deny wins.** A literal `false` at **either** scope denies, and it is
   checked before any `true` is consulted.
3. **Any explicit `true`.** A literal `true` at either scope allows.
4. **Otherwise: allowed.** Both scopes silent means the capability follows Workspace Trust, so an
   operator who sets nothing gets today's behaviour.

Only the literal booleans short-circuit a layer. `null` — the shipped default — and an absent value
both mean "no override, fall through". That is why the default is `null` rather than `true`: `true`
would be an override that stops the ladder, and the two are not the same thing.

### What changed on 2026-08-26, and why (FR-R3-108)

Steps 2 and 3 used to read **"workspace-scope override, then user-scope override"** — the first scope
with an opinion won, and workspace scope was asked first. That is inverted for the one scenario a
trust control exists for:

> An operator sets `schegent.trust.allowCustomPhases` to `false` in their **user** settings. They then
> open a repository whose checked-in `.vscode/settings.json` sets it to `true` — content that arrived
> **with the workspace**. Under the old ladder, the workspace won.

Every sibling hardening in this family went the other way: application-scoped settings exist precisely
so a repository cannot redirect `cliPath` or flip containment. This one handed the workspace the
override, and defaulted to allow when nobody spoke.

**Deny-precedence** replaces it. A repository may now **narrow or agree**, never widen past a user's
deny. A workspace `true` is still effective where user scope is silent or allowing, so a repository
that wants to opt itself in can still do so — it just cannot opt an operator out of their own refusal.

Two things deliberately did **not** change:

- **The ceiling.** An untrusted workspace still denies everything. This is why the finding was Medium
  rather than High: the attack needs a *trusted-but-hostile* workspace. It is also exactly the case an
  explicit user-scope `false` describes an operator defending against.
- **The silent default.** Silence at both scopes still resolves to **allow**. The flip to deny was
  considered and declined: workspace trust already gates the residual case, and flipping would stop
  custom phases loading for every existing operator on upgrade — a first-run behaviour change for
  everyone, to close a case an explicit `false` already closes. The decision is recorded at
  `SILENT_DEFAULT` in `src/state/capability-trust-decision.ts`, and the flip remains available; taking
  it would carry a migration story with it, because an operator whose phases stopped loading must be
  told why, by name, in the refusal.

**The reported scope follows the same order.** `getResolvedScope` names the scope that actually
decided, so in the case above it reports `user` — not `workspace`. Before the fix it reported
`workspace` while the answer came from the user's deny, which told an operator the wrong thing about
their own setting.

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
