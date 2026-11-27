/**
 * FR-R3-112 — the operator-facing label for a run's pause cause.
 *
 * WHY IT IS A FUNCTION IN A LIB AND NOT A TERNARY IN THE MARKUP. The badge is the surface an
 * operator returning to a paused run actually reads, so what it says is worth testing on its
 * own; and `PhaseProgression.svelte` sits at the repository-wide 500-line component budget,
 * which exists to push exactly this kind of logic out of the markup rather than to be raised.
 *
 * THE DEFAULT IS DELIBERATE. An unrecognized cause reads as "Phase paused" — the historical
 * label — because a host that grows a new cause must not blank the badge in a webview that has
 * not shipped yet. A wrong-but-plausible label beats an empty one on the surface an operator
 * uses to decide what to do next.
 */
export type PauseBadgeCause =
  | 'operator-paused'
  | 'queue-paused-mid-run'
  | 'breakpoint-paused'
  | 'verify-paused'
  | 'spend-bound-reached'
  | null
  | undefined;

export function pauseBadgeLabel(cause: PauseBadgeCause): string {
  switch (cause) {
    case 'queue-paused-mid-run':
      return 'Queue paused';
    case 'spend-bound-reached':
      return 'Spend bound reached';
    default:
      return 'Phase paused';
  }
}
