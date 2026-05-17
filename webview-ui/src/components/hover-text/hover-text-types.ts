/**
 * Feature 018 — Settings UI Hover Text & Descriptions.
 *
 * Shared types for the reusable HoverText component, the `hoverTextAnchor`
 * Svelte 5 action, and per-tab description maps. See
 * specs/018-settings-ui-tooltips/data-model.md and
 * contracts/hover-text-component-api.md for the full contract.
 */

export interface ControlDescription {
  readonly title?: string;
  readonly body: string;
}

export type HoverTextAnchor = 'top' | 'bottom' | 'left' | 'right';
export type HoverTextPreferredPlacement = 'auto' | HoverTextAnchor;

/**
 * `<HoverText>` component props. Retained for advanced direct-wrap usage;
 * the primary call shape across the four Settings tabs is the
 * `hoverTextAnchor` action (see `HoverTextAnchorParams`).
 */
export interface HoverTextProps {
  readonly controlId: string;
  readonly description: ControlDescription;
  readonly anchor?: HoverTextAnchor;
  readonly preferredPlacement?: HoverTextPreferredPlacement;
  readonly disabled?: boolean;
}

/**
 * Params for the `hoverTextAnchor` Svelte 5 action. Identical in shape to
 * `HoverTextProps`; the action wires hover/focus listeners + popover
 * rendering directly to the focusable control it is applied to. See
 * contracts/hover-text-component-api.md for the full lifecycle contract.
 */
export interface HoverTextAnchorParams {
  readonly controlId: string;
  readonly description: ControlDescription;
  readonly anchor?: HoverTextAnchor;
  readonly preferredPlacement?: HoverTextPreferredPlacement;
  readonly disabled?: boolean;
}

export type HoverTextAnchorAction = (
  node: HTMLElement,
  params: HoverTextAnchorParams
) => {
  update(next: HoverTextAnchorParams): void;
  destroy(): void;
};

/**
 * The 80-char cutoff is applied at action-attach time (single source of
 * truth — never an authoring choice). Bodies ≤ 80 chars render as inline
 * subtext; > 80 chars open a popover anchored to the control on
 * hover/focus.
 */
export const INLINE_BODY_MAX_CHARS = 80;

export function isInlineDescription(description: ControlDescription): boolean {
  return description.body.length <= INLINE_BODY_MAX_CHARS;
}
