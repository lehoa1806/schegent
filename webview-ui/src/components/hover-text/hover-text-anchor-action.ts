/**
 * Feature 018 — `hoverTextAnchor` Svelte 5 action.
 *
 * Wires hover/focus popover behavior directly onto a focusable control
 * (the "anchor"). Replaces the predecessor's `(?)`-icon trigger pattern
 * per the 2026-05-13 hover-text redirect.
 *
 * Behavior summary (full contract in
 * specs/018-settings-ui-tooltips/contracts/hover-text-component-api.md):
 *  - body.length ≤ 80 chars → injects an inline `<p id="desc-<id>">`
 *    sibling and sets `aria-describedby` permanently on the anchor.
 *  - body.length > 80 chars → sets `data-hover-text-anchored="true"` on
 *    the anchor, attaches mouseenter/mouseleave/focus/blur/keydown
 *    listeners, and lazily portals a HoverTextPortal component into
 *    `document.body` when the popover opens.
 *  - Hover open delay: 400ms; focus open delay: 0ms; hover-bridge
 *    grace: 100ms; blur close: microtask-delayed.
 *  - `aria-describedby` is toggled on open/off on close in popover
 *    mode (never dangling).
 */

import { mount, unmount } from 'svelte';
import {
  INLINE_BODY_MAX_CHARS,
  type ControlDescription,
  type HoverTextAnchorAction,
  type HoverTextAnchorParams
} from './hover-text-types';
import HoverTextPortal from './HoverTextPortal.svelte';

const HOVER_OPEN_DELAY_MS = 400;
const MOUSELEAVE_GRACE_MS = 100;

type Mode = 'inline' | 'popover';

interface InlineState {
  readonly mode: 'inline';
  readonly inlineEl: HTMLParagraphElement;
}

interface PopoverState {
  readonly mode: 'popover';
  open: boolean;
  popoverHost: HTMLElement | null;
  popoverComponent: ReturnType<typeof mount> | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  blurTicket: number;
  describedById: string | null;
  readonly listeners: {
    mouseenter: (ev: MouseEvent) => void;
    mouseleave: (ev: MouseEvent) => void;
    focus: (ev: FocusEvent) => void;
    blur: (ev: FocusEvent) => void;
    keydown: (ev: KeyboardEvent) => void;
  };
}

type AttachedState = InlineState | PopoverState | null;

function modeFor(description: ControlDescription): Mode {
  return description.body.length <= INLINE_BODY_MAX_CHARS ? 'inline' : 'popover';
}

function describedByTokens(node: HTMLElement): Set<string> {
  return new Set(
    (node.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
  );
}

function addDescribedBy(node: HTMLElement, id: string): void {
  const tokens = describedByTokens(node);
  tokens.add(id);
  node.setAttribute('aria-describedby', [...tokens].join(' '));
}

function removeDescribedBy(node: HTMLElement, id: string): void {
  const tokens = describedByTokens(node);
  tokens.delete(id);
  if (tokens.size === 0) {
    node.removeAttribute('aria-describedby');
    return;
  }
  node.setAttribute('aria-describedby', [...tokens].join(' '));
}

// BUG-001 (2026-05-13): Svelte 5 `use:action={{…}}` creates a fresh object
// literal on every parent re-render, so `update(next)` is invoked even when
// no underlying value changed. Without this guard, the open popover is torn
// down on the next reactive tick after `mouseenter` → `openPopover()`. The
// guard compares the six contract fields by value; mode-change and genuine
// content-change still flow through the existing teardown / remount paths.
function paramsEqual(a: HoverTextAnchorParams, b: HoverTextAnchorParams): boolean {
  return (
    a.controlId === b.controlId &&
    a.description.body === b.description.body &&
    a.description.title === b.description.title &&
    a.disabled === b.disabled &&
    a.anchor === b.anchor &&
    a.preferredPlacement === b.preferredPlacement
  );
}

function setupInline(node: HTMLElement, params: HoverTextAnchorParams): InlineState {
  const inlineEl = document.createElement('p');
  inlineEl.id = `desc-${params.controlId}`;
  inlineEl.className = 'hover-text-inline-help';
  inlineEl.textContent = params.description.body;

  addDescribedBy(node, inlineEl.id);

  if (node.parentNode) {
    node.parentNode.insertBefore(inlineEl, node.nextSibling);
  }

  return {
    mode: 'inline',
    inlineEl
  };
}

function teardownInline(node: HTMLElement, state: InlineState): void {
  removeDescribedBy(node, state.inlineEl.id);
  state.inlineEl.remove();
}

function setupPopover(node: HTMLElement, params: HoverTextAnchorParams): PopoverState {
  node.setAttribute('data-hover-text-anchored', 'true');
  node.setAttribute('data-hover-text-controlid', params.controlId);

  const state: PopoverState = {
    mode: 'popover',
    open: false,
    popoverHost: null,
    popoverComponent: null,
    openTimer: null,
    leaveTimer: null,
    blurTicket: 0,
    describedById: null,
    listeners: {
      mouseenter: () => {},
      mouseleave: () => {},
      focus: () => {},
      blur: () => {},
      keydown: () => {}
    }
  };

  // Current params reference (mutable across update()).
  let currentParams: HoverTextAnchorParams = params;

  function clearOpenTimer(): void {
    if (state.openTimer !== null) {
      clearTimeout(state.openTimer);
      state.openTimer = null;
    }
  }

  function clearLeaveTimer(): void {
    if (state.leaveTimer !== null) {
      clearTimeout(state.leaveTimer);
      state.leaveTimer = null;
    }
  }

  function openPopover(): void {
    if (state.open) return;
    state.open = true;
    state.describedById = `hover-text-${currentParams.controlId}`;
    addDescribedBy(node, state.describedById);

    const host = document.createElement('div');
    host.className = 'hover-text-portal-host';
    document.body.appendChild(host);
    state.popoverHost = host;

    state.popoverComponent = mount(HoverTextPortal, {
      target: host,
      props: {
        controlId: currentParams.controlId,
        description: currentParams.description,
        anchorEl: node,
        anchor: currentParams.anchor ?? 'bottom',
        preferredPlacement: currentParams.preferredPlacement ?? 'auto',
        onMouseEnter: () => {
          clearLeaveTimer();
        },
        onMouseLeave: () => {
          if (!state.open) return;
          clearLeaveTimer();
          state.leaveTimer = setTimeout(() => {
            state.leaveTimer = null;
            if (state.open) closePopover();
          }, MOUSELEAVE_GRACE_MS);
        }
      }
    });
  }

  function closePopover(): void {
    if (!state.open) return;
    state.open = false;
    clearOpenTimer();
    clearLeaveTimer();
    if (state.describedById) {
      removeDescribedBy(node, state.describedById);
      state.describedById = null;
    }
    if (state.popoverComponent) {
      void unmount(state.popoverComponent);
      state.popoverComponent = null;
    }
    if (state.popoverHost) {
      state.popoverHost.remove();
      state.popoverHost = null;
    }
  }

  state.listeners.mouseenter = () => {
    if (currentParams.disabled) return;
    clearLeaveTimer();
    if (state.open) return;
    clearOpenTimer();
    state.openTimer = setTimeout(() => {
      state.openTimer = null;
      if (!state.open) openPopover();
    }, HOVER_OPEN_DELAY_MS);
  };

  state.listeners.mouseleave = () => {
    if (currentParams.disabled) return;
    clearOpenTimer();
    if (!state.open) return;
    clearLeaveTimer();
    state.leaveTimer = setTimeout(() => {
      state.leaveTimer = null;
      if (state.open) closePopover();
    }, MOUSELEAVE_GRACE_MS);
  };

  state.listeners.focus = () => {
    if (currentParams.disabled) return;
    clearOpenTimer();
    if (state.open) return;
    openPopover();
  };

  state.listeners.blur = (event: FocusEvent) => {
    if (currentParams.disabled) return;
    if (!state.open) return;
    const next = event.relatedTarget as Node | null;
    if (next && state.popoverHost && state.popoverHost.contains(next)) return;
    state.blurTicket = (state.blurTicket + 1) % 1_000_000;
    const ticket = state.blurTicket;
    queueMicrotask(() => {
      if (ticket !== state.blurTicket) return;
      if (state.open) closePopover();
    });
  };

  state.listeners.keydown = (event: KeyboardEvent) => {
    if (currentParams.disabled) return;
    if (event.key === 'Escape' && state.open) {
      event.preventDefault();
      closePopover();
    }
  };

  node.addEventListener('mouseenter', state.listeners.mouseenter);
  node.addEventListener('mouseleave', state.listeners.mouseleave);
  node.addEventListener('focus', state.listeners.focus);
  node.addEventListener('blur', state.listeners.blur);
  node.addEventListener('keydown', state.listeners.keydown);

  // Expose hooks so update() can read / mutate currentParams without rebuilding listeners.
  (state as PopoverState & {
    __setParams: (p: HoverTextAnchorParams) => void;
    __getParams: () => HoverTextAnchorParams;
  }).__setParams = (p) => {
    currentParams = p;
  };
  (state as PopoverState & {
    __setParams: (p: HoverTextAnchorParams) => void;
    __getParams: () => HoverTextAnchorParams;
  }).__getParams = () => currentParams;

  // Expose close so update() and destroy() can drive it.
  (state as PopoverState & { __close: () => void }).__close = closePopover;

  return state;
}

function teardownPopover(node: HTMLElement, state: PopoverState): void {
  const extended = state as PopoverState & { __close?: () => void };
  extended.__close?.();
  node.removeEventListener('mouseenter', state.listeners.mouseenter);
  node.removeEventListener('mouseleave', state.listeners.mouseleave);
  node.removeEventListener('focus', state.listeners.focus);
  node.removeEventListener('blur', state.listeners.blur);
  node.removeEventListener('keydown', state.listeners.keydown);
  node.removeAttribute('data-hover-text-anchored');
  node.removeAttribute('data-hover-text-controlid');
  if (state.describedById) {
    removeDescribedBy(node, state.describedById);
    state.describedById = null;
  }
}

export const hoverTextAnchor: HoverTextAnchorAction = (node, params) => {
  let state: AttachedState = null;

  function attach(p: HoverTextAnchorParams): void {
    if (p.disabled) {
      state = null;
      return;
    }
    state = modeFor(p.description) === 'inline' ? setupInline(node, p) : setupPopover(node, p);
  }

  function detach(): void {
    if (!state) return;
    if (state.mode === 'inline') teardownInline(node, state);
    else teardownPopover(node, state);
    state = null;
  }

  attach(params);

  return {
    update(next: HoverTextAnchorParams) {
      const nextMode = next.disabled ? null : modeFor(next.description);
      const currentMode = state?.mode ?? null;

      if (currentMode !== nextMode) {
        detach();
        attach(next);
        return;
      }

      if (state?.mode === 'inline') {
        const previousId = state.inlineEl.id;
        state.inlineEl.textContent = next.description.body;
        state.inlineEl.id = `desc-${next.controlId}`;
        removeDescribedBy(node, previousId);
        addDescribedBy(node, state.inlineEl.id);
      } else if (state?.mode === 'popover') {
        const extended = state as PopoverState & {
          __setParams: (p: HoverTextAnchorParams) => void;
          __getParams: () => HoverTextAnchorParams;
          __close: () => void;
        };
        const prev = extended.__getParams();
        if (paramsEqual(prev, next)) {
          // BUG-001: identical-value re-render — preserve the open popover.
          return;
        }
        extended.__setParams(next);
        node.setAttribute('data-hover-text-controlid', next.controlId);
        if (state.popoverComponent) {
          // Genuine content change (e.g., derived list swaps controls) —
          // tear down and let the next hover/focus open the new content.
          extended.__close();
        }
      }
    },
    destroy() {
      detach();
    }
  };
};

export const __test__ = {
  HOVER_OPEN_DELAY_MS,
  MOUSELEAVE_GRACE_MS
};
