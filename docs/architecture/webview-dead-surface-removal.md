# The superseded webview surface, removed

**Decided 2026-08-29** · `FR-R3-140` (audit finding `QUAL-01`, recommendation `P2-5`)

## The decision

**Delete the ten unreachable components. Replace the standing excuse with a policy that expires.**

Ten `.svelte` files under `webview-ui/src/components/` — 1,685 lines — are deleted, along with the
five test files whose only subject was one of them. The reachability gate's allowlist, which excused
all ten, is emptied and given an owner-and-expiry rule so that an entry cannot outlive the feature
that added it.

This record is written before the deletion, not after. It is the safety boundary: the evidence that
each file was unreachable is what makes removing it a decision rather than a guess.

## Why the previous disposition was not a valuation

`tests/lint/svelte-surface-reachability.test.ts` walks the import graph from the two shipped bundle
entry points and fails on any component it cannot arrive at. It worked. It found these ten, and then
excused all ten, because `FR-040` of feature 091 forbade *that feature* from deleting them.

The gate's own comment said so: *"FR-040 forbids deleting these, so a recorded reason is the only
compliant disposition."* That sentence was true when it was written and stopped being true when
feature 091 completed. **`FR-040` was a scope boundary on one feature, not a finding that the code
has value.** Read as a standing prohibition it converts governance into preservation: the gate
proved the same ten files were dead on every run and reported success.

`tests/lint/destructive-actions.lint.test.ts` stated the intended resolution outright — *"The
follow-up cleanup spec will delete them; until then, the allowlist prevents noise"* — and named no
spec, so nothing ever became that follow-up. This is that follow-up, and the specs for feature 091
are left exactly as written. Rewriting a finished spec to authorize a later decision is how a record
stops being one.

## The evidence

Re-derived against the tree at `0dc9c63b`. Three distinct reachability shapes, distinguished here
because they are not equally safe and a single "unreachable" verdict over all ten would hide that.

| Component | Lines | Shape |
|---|---:|---|
| `AuditTail.svelte` | 158 | imported only from `__tests__/` |
| `ControlPanel.svelte` | 303 | no importer at all |
| `LiveActivityHeader.svelte` | 116 | no importer at all |
| `MonitorPill.svelte` | 99 | imported only from `__tests__/` |
| `StatusHeader.svelte` | 83 | no importer at all |
| `PhaseTracker.svelte` | 103 | no importer at all |
| `PhaseTile.svelte` | 223 | imported only by `PhaseTracker.svelte`, itself unreachable |
| `QueueList.svelte` | 109 | no importer at all |
| `QueueGlobalActions.svelte` | 239 | imported only by `QueueList.svelte`, itself unreachable, and from `__tests__/` |
| `hover-text/HoverText.svelte` | 252 | no importer at all, including tests |
| **Total** | **1,685** | |

**The two orphan-of-an-orphan cases are the reason the shapes are recorded separately.**
`PhaseTile.svelte` and `QueueGlobalActions.svelte` each have a real importer. Their deletion is safe
only because the importer is on this same list and goes in the same change. Reading the table as ten
files with zero importers would get that wrong.

`HoverText.svelte` is reached by nothing whatsoever. The file named
`hover-text/__tests__/HoverText.test.ts` renders `HoverTextHarness.svelte` and exercises the *live*
`hoverTextAnchor` action, not the component its filename suggests. That test stays.

**No dynamic route and no host-composed reference.** The gate already follows `import('…')`
specifiers — that is what its dynamic-import control pins — and none of the ten is such a target. No
host module composes any of their names into webview HTML; the only occurrences of these strings
under `src/` belong to unrelated host concepts sharing a word (`AuditTailEntry`, the sidebar
audit-tail projector, `QueueListView`).

**Name collisions.** Matching was on full filenames throughout, never on stems. `QueueList.svelte`
is dead and `QueueListView.svelte` is live; `StatusHeader.svelte` is dead and `StatusBar.svelte` is
live; `HoverText.svelte` is dead and `HoverTextPortal.svelte`, `hover-text-anchor-action.ts`,
`hover-text-positioning.ts` and `hover-text-types.ts` are all live.

## Test coverage removed, stated rather than lost

Five test files had no subject but a deleted component and are deleted with them:

- `components/__tests__/AuditTail.filter.test.ts`
- `components/__tests__/MonitorPill.test.ts`
- `components/__tests__/PhaseTile.optional-phase.test.ts`
- `components/__tests__/QueueGlobalActions.idle-pending.test.ts`
- `components/__tests__/QueueGlobalActions.test.ts`

One file had a **mixed** subject and was edited rather than deleted.
`components/__tests__/a11y-theme-audit.test.ts` rendered five components, of which two were deleted
and three — `QueueItemActions`, `HistorySection` and `QueueDetailRows` — ship. Two of its blocks
were dedicated to a deleted component and went with it. A third, asserting that rendered DOM embeds
no inline animation or transition CSS that could bypass `prefers-reduced-motion`, built its render
array from the two deleted components and nothing else: removing both would have left it iterating
an empty array, green forever and asserting nothing. It was repointed at live components. Deleting
that file, or emptying that block, would have removed shipped-behaviour a11y coverage under cover of
a dead-code cleanup.

## The re-verification gate is retired, and why that is not a loss

`tests/lint/gate-integrity/webview-dead-code-reverification.test.ts` is deleted. Its entire subject
was the six-component, 407-statement zero-coverage classification, and it additionally pinned the
string `407 of the 461 statements` in `webview-ui/vitest.config.ts`. Both cease to exist.

It was **not** repointed at the zero-coverage inventory that remains — the two bootstrap entry
points `webview-ui/src/main.ts` and `webview-ui/src/dashboard/main.ts`. Those have no importer *by
design*, because they are the entry points, and a gate asking whether they are imported outside
tests is the wrong question asked again. `FR-R3-139` refused the same shape for `src/headless/` one
item earlier. Inventing a claim so a gate can survive its subject is the defect this batch keeps
finding, not a fix for it.

**What replaces its protective value is strictly stronger, and the comparison is the point.** The
retired gate re-verified that a standing inventory of dead code was still accurately classified. The
new allowlist policy stops the inventory re-accumulating: every exception now carries a named owner,
a reason and a `reviewBy` date, and the gate fails on a missing owner, an empty reason, a malformed
or impossible date, an expired date, an entry naming a file that no longer exists, or an entry
naming a file that has become reachable. A gate that confirms dead code is still dead is worth less
than a policy under which it cannot sit there indefinitely. A later reader should not restore the
retired gate believing coverage was lost.

Because the shipped allowlist is empty, all six rules are demonstrated against synthetic in-memory
entries rather than against the tree. That is stated plainly in the gate itself: the two
allowlist-integrity assertions are empty against the shipping tree, and it is their *rules* that are
executed, not their real-tree half.

## What this does not claim

- **Not that these components ever executed at runtime.** Tree-shaking most likely kept them out of
  the shipped bundle already. No bundle measurement was taken to prove otherwise, and none is
  claimed.
- **Not that any user-facing defect is explained.** Nothing observable changes for an operator. The
  route list, the visual screenshot inventory and the a11y scan's combination count are identical
  before and after.
- **Not a performance result.** The established costs are maintenance, test execution time, coverage
  interpretation and contributor cognition — 1,685 lines a reader must classify before concluding
  they do not matter. Those are real and they are the whole justification.
- **Not a precedent for deleting a legacy surface because a newer one exists.** Every one of the ten
  was measured unreachable first.

## Related

- `docs/development/lint-gate-census.md` — the gate inventory, one row shorter
- `docs/development/gate-integrity-measurements.md` — §4 records the retirement
- `docs/development/coverage-measurements.md` — the post-deletion webview measurement
