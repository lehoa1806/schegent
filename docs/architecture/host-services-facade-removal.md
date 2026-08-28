# The HostServices facade, removed

**Decided 2026-08-29** · `FR-R3-139` (audit finding `DES-01`, recommendation `P2-5`)

## The decision

**Delete the broad facade. Keep the focused adapter. Do not rename the directory.**

`src/host-services/vscode-host-services.ts`, `types.ts` and `index.ts` are deleted — 226 lines of
production-shaped source — along with the 238-line unit test that was their only consumer.
`catalog-fs-adapter.ts` stays. The directory keeps its name and its entry in `ACTING_LAYERS`.

## What was measured

Nothing was broken. The extension shipped, activated and ran with these files in the tree, and
ships identically without them. That is the whole of the defect: a nine-member abstraction over
exactly the facilities a reader would care about, in a directory `ARCHITECTURE.md` described as the
wrapper around host-owned behaviour, that no installed extension could reach.

The facade had nine members. **None was the production owner of its facility, and two had no caller
at either end.**

| `HostServices` member | Who owns this in the shipped extension |
|---|---|
| `workspace.isTrusted` / `onDidGrantTrust` | `src/state/capability-trust-resolver.ts`, `state/entry-trust-decision.ts`, `state/capability-trust-decision.ts`, `activation/guarded-command-registration.ts`, `activation/trust-grant-wiring.ts`, `services/guarded-run-service.ts` — the boundary `FR-R3-136` defined and hardened |
| `workspace.getCanonicalWorkspaceRoot` | `src/state/workspace-folder-picker.ts`, called directly by eight production modules |
| `configuration` | `src/config/cli-path-accessor.ts`, `state/confirmations-config.ts`, `lib/auto-compact-override.ts`, three activation wirings |
| `state.workspace` | `src/extension.ts`, directly |
| `state.global` | **Nothing.** No production module reads `globalState` |
| `storage` | `src/services/run-checkpoint-retention.ts`, `activation/run-safety-wiring.ts`, `services/run-checkpoint-service.ts`, `lib/runtime-log/runtime-log-sink.ts`, `activation/backend-wiring.ts` — all off `context.globalStorageUri` directly |
| `notifications` | `src/ui/notifications.ts`, which is the real notification seam |
| `commands` | `src/activation/sidebar-router-wiring.ts`, `commands/show-active-run.ts`, `contracts/entry-point-dispositions.ts` |
| `files.revealFileInOS` | **Nothing.** The string `revealFileInOS` appeared in the facade and its type declaration, nowhere else in `src/` |
| `scheduler` | **Nothing of this shape.** The real scheduler is `ScheduledStartCoordinator` in `src/services/`, whose interface has no `apply`/`uninstall`/`inspect`/`reconcile`. The facade's default was a no-op returning `{ registered: false }` |
| `lifecycle` | `context.subscriptions`, pushed to directly in six places in `src/extension.ts` |

`state.global` and `files.revealFileInOS` are the strongest single piece of evidence in the table.
A facade derived from what the extension does would not have grown a member for a facility nothing
reads and a member for a command nothing calls. This one was designed against an idea of what a
host abstraction ought to cover, and then never met the code.

## Why deletion beat wiring

The wire-or-remove default was deletion where wiring would only replace direct calls with
pass-through ceremony. Every member falls on that side. Wiring the facade in would have meant
threading a nine-member object through a composition root that already resolves each facility at
its point of use — replacing eight direct `vscode` calls with eight indirections that add no seam
any test uses — and inventing production callers for the two members that had none.

`FR-R3-136` is why this could be decided rather than guessed at. Before it, "who owns trust" was
open, and the broad `isTrusted`/`onDidGrantTrust` pair had a claim to being the answer. `FR-R3-136`
gave the answer, and it was not this pair.

`catalog-fs-adapter.ts` is the opposite case and stays. It has a production consumer
(`src/activation/catalog-store-wiring.ts`), it is a real seam five test files substitute at, and
`FR-R3-069` migrated it onto the checked `safe-open` path with the record to prove it. Its role —
adapter for a facility the host owns — is what the directory is for.

The directory is **not renamed**. `host-services` is a declared entry in `ACTING_LAYERS` that two
dependency gates read, and it is named in two other gates, two source comments, four `docs/` source
markers and six test imports. Renaming touches all of that and corrects nothing a reader believed
falsely: the directory name was never the lie. The lie was the facade inside it, and the sentence
in `ARCHITECTURE.md` describing that facade as the wrapper. Both are gone.

## The cost that was actually being paid

Twice, and neither time as a bug.

**In the architecture.** Someone hardening a host seam read that `src/host-services/` wrapped
configuration, filesystem and notification seams, found a facade covering exactly those, and
concluded the seam existed. Two composition models were documented; one ran.

**In the test suite.** `tests/unit/host-services/vscode-host-services.test.ts` was green and would
have stayed green regardless of what the extension did, because every assertion it made was about
a mock reaching a mock. Its last test injected a scheduler nothing supplied, called four methods,
and asserted the injected mock recorded the calls. Six of its seven tests were shaped that way.
Coverage counted them, so any quality claim resting on that coverage was overstated by exactly that
much.

## The gate, and what it is honestly worth

`tests/lint/adapter-module-reachability.test.ts` fails when a module under a named adapter
directory exports symbols no non-test file consumes.

Two rules make it work.

**Tests are not consumers.** The facade's only consumer was its own unit test, so a reachability
check that counted `tests/` would have passed on the exact defect it exists to catch. `scripts/` is
excluded on the same principle one step out.

**Reachedness is a least fixed point.** Measured before the deletion, all three dead modules read
as reached under a plain outside-consumer rule, because each named the others' symbols — the barrel
re-exported the types and the implementation imported them. Three dead modules formed a cycle that
certified itself. The set is therefore seeded from modules a production file *outside* the
directory consumes, then grown inward.

**What the gate is worth today, stated plainly.** After the deletion `src/host-services/` holds one
module, and that module is also the gate's positive control. An empty offender set over a set of
size one is close to guaranteed by construction: the scan-proof floors constrain very little, and
the control is not independent of the scanned set. The liveness evidence is not the real-tree scan
but eight synthetic trees the gate builds and measures — a self-certifying cycle that must be
reported, a module consumed only from `tests/` that must be reported, a module two hops from
production that must not be, and both self-cleaning directions of the allowlist. The value of the
real-tree half is prospective: it fails the day someone lands the next facade, not today. Recorded
in these words because a one-module scan presented as a broad result would reproduce, one level up,
the overclaim this feature was filed against.

**`src/headless/` is deliberately outside the gate.** It was the other candidate. Three of its five
modules — `pipeline-run-api.ts`, `process-definition-api.ts`, `workflow-run-api.ts` — have no
consumer in this repository *by design*, because `ARCHITECTURE.md` makes them VS Code-independent
public adapters for callers outside it. Including that directory would have meant three standing
exemptions on the day the gate landed, a majority-exempted gate, and a fourth genuinely dead public
API module inheriting a fourth exemption by precedent. The gate asks the wrong question of that
directory, and the honest response to a wrong question is not to allowlist the answer.

## What this decision does not say

It does not call for a DI container or a repository-wide port/adaptor rewrite. Direct VS Code
composition is valid for an extension host and is what ships. The defect was maintaining and
documenting a second, unused composition model beside it.

It does not license hunting unreached modules elsewhere. The gate's directory list starts and stops
at `src/host-services/`; widening it is a deliberate edit with its own reasoning.
