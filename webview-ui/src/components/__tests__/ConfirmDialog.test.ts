// Feature 063 — T042. Unit-level coverage for the generic
// `ConfirmDialog.svelte` component. The dialog is mounted directly with
// hand-rolled request shapes so the test exercises the component's
// public contract (aria, focus, keyboard) without depending on
// `useConfirm`'s mounting path.
//
// Contract reference: specs/063-clean-all-confirmations/contracts/confirm-dialog.md

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ConfirmDialog from '../ConfirmDialog.svelte';
import { SUPPRESSION_CHECKBOX_LABEL, type Severity } from '../../lib/action-copy';

afterEach(() => cleanup());

type DialogRequest = {
  readonly actionKey: string;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly originatingElement: HTMLElement | null;
  readonly suppressible: boolean;
};

function makeRequest(overrides: Partial<DialogRequest> = {}): DialogRequest {
  return {
    actionKey: 'queue.clean-all',
    severity: 'destructive',
    title: 'Clean All — wipe the queue?',
    body: 'You are about to remove 1 pending, 0 completed, 0 failed tasks.',
    confirmLabel: 'Clean All',
    originatingElement: null,
    suppressible: true,
    ...overrides
  };
}

function renderDialog(
  request: DialogRequest,
  onConfirm: (suppressFuture: boolean) => void = vi.fn(),
  onCancel: () => void = vi.fn()
) {
  return render(ConfirmDialog, {
    props: { request, onConfirm, onCancel }
  });
}

describe('ConfirmDialog', () => {
  it('exposes role="dialog" + aria-modal="true" + aria-labelledby/describedby', () => {
    const { getByTestId } = renderDialog(makeRequest());
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).not.toBeNull();
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(labelledBy!)?.textContent).toContain('Clean All');
    expect(document.getElementById(describedBy!)?.textContent).toContain('pending');
  });

  it('renders title, body, and severity-tagged confirm button label', () => {
    const { getByTestId } = renderDialog(
      makeRequest({
        title: 'Reset Workspace — wipe all state?',
        body: 'Wipes all Schegent state for this workspace.',
        confirmLabel: 'Reset Workspace',
        severity: 'destructive'
      })
    );
    expect(getByTestId('confirm-dialog-title').textContent).toBe(
      'Reset Workspace — wipe all state?'
    );
    expect(getByTestId('confirm-dialog-body').textContent).toBe(
      'Wipes all Schegent state for this workspace.'
    );
    const confirmBtn = getByTestId('confirm-dialog-confirm');
    expect(confirmBtn.textContent).toBe('Reset Workspace');
    expect(confirmBtn.classList.contains('btn-destructive')).toBe(true);
  });

  it('applies severity-info class for info-tier actions', () => {
    const { getByTestId } = renderDialog(
      makeRequest({ severity: 'info', confirmLabel: 'Pause Queue' })
    );
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.classList.contains('severity-info')).toBe(true);
    expect(getByTestId('confirm-dialog-confirm').classList.contains('btn-info')).toBe(true);
  });

  it('applies severity-caution class for caution-tier actions', () => {
    const { getByTestId } = renderDialog(
      makeRequest({ severity: 'caution', confirmLabel: 'Clear Done' })
    );
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.classList.contains('severity-caution')).toBe(true);
    expect(getByTestId('confirm-dialog-confirm').classList.contains('btn-caution')).toBe(true);
  });

  it('applies severity-destructive class for destructive-tier actions', () => {
    const { getByTestId } = renderDialog(
      makeRequest({ severity: 'destructive', confirmLabel: 'Clean All' })
    );
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.classList.contains('severity-destructive')).toBe(true);
    expect(getByTestId('confirm-dialog-confirm').classList.contains('btn-destructive')).toBe(true);
  });

  it('exposes data-action-key and data-severity attributes for DevTools/CSS targeting', () => {
    const { getByTestId } = renderDialog(
      makeRequest({ actionKey: 'history.rerun', severity: 'caution' })
    );
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.getAttribute('data-action-key')).toBe('history.rerun');
    expect(dialog.getAttribute('data-severity')).toBe('caution');
  });

  it('moves initial focus to the Cancel button on mount', async () => {
    const { getByTestId } = renderDialog(makeRequest());
    await tick();
    expect(document.activeElement).toBe(getByTestId('confirm-dialog-cancel'));
  });

  it('renders the suppression checkbox when suppressible === true', () => {
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }));
    expect(getByTestId('confirm-dialog-suppression-row')).not.toBeNull();
    const checkbox = getByTestId('confirm-dialog-suppression-checkbox') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(false);
  });

  it('hides the suppression checkbox when suppressible === false (workspace.reset)', () => {
    const { queryByTestId } = renderDialog(
      makeRequest({ actionKey: 'workspace.reset', suppressible: false })
    );
    expect(queryByTestId('confirm-dialog-suppression-row')).toBeNull();
    expect(queryByTestId('confirm-dialog-suppression-checkbox')).toBeNull();
  });

  it('renders the suppression checkbox label from the SUPPRESSION_CHECKBOX_LABEL constant', () => {
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }));
    const row = getByTestId('confirm-dialog-suppression-row');
    expect(row.textContent).toContain(SUPPRESSION_CHECKBOX_LABEL);
  });

  it('invokes onCancel when the Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const { getByTestId } = renderDialog(makeRequest(), vi.fn(), onCancel);
    await fireEvent.click(getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('invokes onConfirm(false) when Confirm is clicked without suppression', async () => {
    const onConfirm = vi.fn();
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }), onConfirm);
    await fireEvent.click(getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('invokes onConfirm(true) when Confirm is clicked WITH suppression checked', async () => {
    const onConfirm = vi.fn();
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }), onConfirm);
    const checkbox = getByTestId('confirm-dialog-suppression-checkbox') as HTMLInputElement;
    await fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    await fireEvent.click(getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('always invokes onConfirm(false) when suppressible === false even if state ever ticked', async () => {
    const onConfirm = vi.fn();
    const { getByTestId } = renderDialog(
      makeRequest({ actionKey: 'workspace.reset', suppressible: false }),
      onConfirm
    );
    await fireEvent.click(getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('Escape key fires onCancel and not onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = renderDialog(makeRequest(), onConfirm, onCancel);
    const dialog = getByTestId('confirm-dialog');
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Tab forward from the last focusable wraps to the first (focus trap, suppressible variant)', async () => {
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }));
    await tick();
    const cancel = getByTestId('confirm-dialog-cancel');
    const confirm = getByTestId('confirm-dialog-confirm');
    const checkbox = getByTestId('confirm-dialog-suppression-checkbox');

    // Cancel is auto-focused on mount.
    expect(document.activeElement).toBe(cancel);

    // Simulate the user reaching the last focusable in the trap order.
    (checkbox as HTMLElement).focus();
    expect(document.activeElement).toBe(checkbox);

    // Tab forward from the last element wraps to the first.
    await fireEvent.keyDown(getByTestId('confirm-dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // Without suppression mid-trap the natural traversal goes Cancel -> Confirm.
    (cancel as HTMLElement).focus();
    expect(document.activeElement).toBe(cancel);
    await fireEvent.keyDown(getByTestId('confirm-dialog'), {
      key: 'Tab',
      shiftKey: true
    });
    // Shift+Tab from the first wraps to the last (checkbox).
    expect(document.activeElement).toBe(checkbox);

    // And Confirm is reachable in the middle.
    (confirm as HTMLElement).focus();
    expect(document.activeElement).toBe(confirm);
  });

  it('focus trap order has no suppression checkbox when suppressible === false', async () => {
    const { getByTestId } = renderDialog(
      makeRequest({ actionKey: 'workspace.reset', suppressible: false })
    );
    await tick();
    const cancel = getByTestId('confirm-dialog-cancel');
    const confirm = getByTestId('confirm-dialog-confirm');
    expect(document.activeElement).toBe(cancel);

    // Tab forward from Confirm (the last element in the no-suppression
    // order) wraps to Cancel.
    (confirm as HTMLElement).focus();
    await fireEvent.keyDown(getByTestId('confirm-dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab from Cancel wraps to Confirm.
    (cancel as HTMLElement).focus();
    await fireEvent.keyDown(getByTestId('confirm-dialog'), {
      key: 'Tab',
      shiftKey: true
    });
    expect(document.activeElement).toBe(confirm);
  });

  it('non-boundary Tab presses do not interfere with the browser default (no preventDefault)', async () => {
    const { getByTestId } = renderDialog(makeRequest({ suppressible: true }));
    await tick();
    const cancel = getByTestId('confirm-dialog-cancel');
    // Focus Cancel; a forward Tab from the FIRST element should not be
    // intercepted (browser will move to Confirm naturally), so the
    // synthetic event is NOT marked defaultPrevented.
    (cancel as HTMLElement).focus();
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    cancel.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('restores focus to originatingElement when the dialog unmounts', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open dialog';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = renderDialog(makeRequest({ originatingElement: opener }));
    await tick();
    // After mount, focus moves to Cancel.
    expect(document.activeElement).not.toBe(opener);

    unmount();
    await tick();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('safely no-ops the focus-restoration when originatingElement is null', async () => {
    const { unmount } = renderDialog(makeRequest({ originatingElement: null }));
    await tick();
    expect(() => unmount()).not.toThrow();
  });

  it('non-Tab and non-Escape keys are ignored', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = renderDialog(makeRequest(), onConfirm, onCancel);
    const dialog = getByTestId('confirm-dialog');
    await fireEvent.keyDown(dialog, { key: 'Enter' });
    await fireEvent.keyDown(dialog, { key: 'a' });
    await fireEvent.keyDown(dialog, { key: ' ' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Feature 065 BUG-009 T081 (FR-031) — long unbroken strings in the
  // prompt body (long task titles, URLs) must wrap inside the dialog
  // instead of stretching it past the 480px max width. jsdom does not
  // resolve Svelte's scoped CSS, so we inspect the source `.svelte`
  // file's `<style>` block — both wrap rules MUST be present on the
  // `p` selector that styles the dialog body. This coupled assertion
  // pins the wrap rules so a future style refactor cannot silently
  // drop them.
  it('body paragraph CSS includes word-break + overflow-wrap (BUG-009 T081)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const svelteSource = readFileSync(
      join(here, '..', 'ConfirmDialog.svelte'),
      'utf8'
    );
    // Extract just the <style> block.
    const styleMatch = svelteSource.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const styleBlock = styleMatch![1];
    // Find the `p { ... }` rule block.
    const pRuleMatch = styleBlock.match(/\n\s*p\s*\{([\s\S]*?)\}/);
    expect(pRuleMatch).not.toBeNull();
    const pRule = pRuleMatch![1];
    expect(pRule).toMatch(/word-break:\s*break-word/);
    expect(pRule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
