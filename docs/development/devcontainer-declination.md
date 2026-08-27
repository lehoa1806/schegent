# The devcontainer question: declined, 2026-08-28

**Decided**: 2026-08-28 (`FR-R3-132`, T1505) · **Gate**: `repo/tests/lint/verification-tiers.test.ts`
does not read this file; the review date below is read by
`repo/tests/lint/devcontainer-declination-review-date.test.ts`

<!-- devcontainer-review-date: 2027-02-28 -->

The repository audit of 2026-08-27 suggested an optional reference development environment — a
devcontainer — for contributor parity. **Declined.** This file exists so that "missing" becomes
"declined, dated" rather than remaining a gap with no record, which is the disposition
[`FR-R3-129`](../../../docs/features/round_3/DONE_129_FR-R3-129_qualification_residuals_with_dates.md)
established for anything owed.

## What was actually asked for

Contributor parity: everyone builds the same thing with the same toolchain, and a newcomer stops
losing an afternoon to a Node version. That is a real goal and the decline is not a disagreement with
it.

## Why it is declined

**1. The parity problem is already solved, by cheaper means.** `.nvmrc` pins Node to 24.19.0,
`package-lock.json` and `webview-ui/package-lock.json` pin both dependency trees, and
`CONTRIBUTING.md` names the two installs and the one Playwright browser download. The measured setup
cost is two `npm ci` runs and one `npx playwright install chromium`. A container would restate those
three commands in a different file format.

**2. It would not cover the part that actually diverges.** This product is a VS Code extension. Its
integration and E2E gates drive an **extension host**, and its visual and accessibility gates drive a
**real browser** at a real viewport. A contributor developing inside a container still runs the editor
outside it, so the environment the container standardises is the one that was never the problem, and
the one that is — the host editor, its version, its theme, its display — stays outside.

**3. A declared environment that nobody runs is worse than none.** This repository has closed the same
class seven times in round 3 alone: a config that documents behaviour nothing implements, a claim no
gate checks, a mechanism with no caller. A `.devcontainer/` that CI does not use and maintainers do not
develop in becomes exactly that — and it drifts silently, because nothing fails when it goes stale.
Adopting it honestly means running CI inside it, which is a substantially larger change than the audit
scoped and one that touches the release attestation path.

**4. The platform posture makes a single container misleading.** Windows and Linux are in the declared
`unverified` tier ([platform observation record](../operations/platform-observation-record.md),
`FR-R3-129`). A Linux devcontainer would hand contributors an environment the product is not qualified
on, and a green suite inside it would read as Linux support. That is the overclaim this round exists to
remove.

## What would reopen it

Any one of these, and the review below is the mechanism that makes somebody look:

1. **A second regular maintainer**, or CI on a runner image that diverges from the pinned toolchain.
   Parity stops being theoretical when two people disagree about a failure.
2. **A contributor report** of a setup failure that `.nvmrc` plus the two lockfiles did not prevent.
   One report is data; the decline was made on zero.
3. **Windows or Linux leaving the `unverified` tier.** A container then standardises something the
   product is actually qualified on, and point 4 above stops applying.
4. **CI moving into a container image anyway** for another reason — at which point the marginal cost of
   exposing it to contributors is near zero, and the argument in point 3 inverts.

**This decline is reviewed on or before 2027-02-28**, and
`repo/tests/lint/devcontainer-declination-review-date.test.ts` fails on that day until someone re-reads
it. Six months rather than the three-month horizon the platform decline carries: nothing here changes
on its own, and the reopening conditions are events rather than dates.

The gate watches the **date**. It cannot see a contributor report or a second maintainer arriving —
those are facts about the world, and no gate in a repository can observe them. Saying so is the point:
a gate that implied it watched all four conditions would be the overclaim this file's fourth reason
objects to.
