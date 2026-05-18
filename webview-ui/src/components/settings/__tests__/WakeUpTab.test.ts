// Feature 014 T036 — webview unit tests for WakeUpTab.svelte.
//
// What's covered here:
//   - The tab renders with sensible defaults (disabled, Chronological, 04:00).
//   - Toggling the Enable checkbox un-disables the scheduler + time inputs.
//   - Clicking Save calls `saveWakeUpSettings` exactly once with the
//     four-key payload from the current draft.
//   - When `saveWakeUpSettings` resolves `{ status: 'accepted' }`, the
//     status badge renders "Saved".
//   - When it resolves `{ status: 'rejected', reason: '<sanitized>' }`,
//     the status badge renders "Rejected: <sanitized>" so the operator
//     sees the reason vocabulary from `wakeup-settings-ipc.md` verbatim.
//   - Inline validation: an HH:MM input that fails the regex blocks
//     Save AND renders the inline error label; valid input enables Save.
//   - The permanent FR-015 no-state-verification info note is always
//     mounted (regardless of scheduler type or enabled state).
//
// Module mocking: we stub `saveWakeUpSettings` at the module boundary
// — the Svelte component imports it via the relative path
// `../../lib/save-wakeup-settings`. The lint regression at
// `tests/lint/no-inline-save-wakeup-settings.test.ts` is what pins the
// single-call-site invariant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import WakeUpTab from '../WakeUpTab.svelte';
import type { WakeUpLogProjection, WakeUpSettings, WorkflowSnapshot } from '../../../lib/snapshot-types';

// ── Mock the shared save helper ────────────────────────────────────────────

const saveSpy = vi.fn<
  typeof import('../../../lib/save-wakeup-settings').saveWakeUpSettings
>();
const wakeNowSpy = vi.fn<
  typeof import('../../../lib/wake-up-now').wakeUpNow
>();

vi.mock('../../../lib/save-wakeup-settings', () => ({
  saveWakeUpSettings: (...args: unknown[]) => (saveSpy as unknown as Function)(...args)
}));

vi.mock('../../../lib/wake-up-now', () => ({
  wakeUpNow: (...args: unknown[]) => (wakeNowSpy as unknown as Function)(...args)
}));

beforeEach(() => {
  saveSpy.mockReset();
  wakeNowSpy.mockReset();
});
afterEach(() => cleanup());

// ── Snapshot fixture ───────────────────────────────────────────────────────

// Feature 014 (BUG-001 / BUG-002) — the tab now consumes
// `snapshot.wakeUpSettings` per FR-025. Tests that exercise the default
// surface omit the field (the component falls back to
// `IDLE_WAKEUP_SETTINGS`); tests below explicitly pass `wakeUpSettings`
// to verify hydration + resync (SC-010).
function buildSnapshot(overrides?: {
  wakeUpSettings?: WakeUpSettings;
  wakeUpLog?: WakeUpLogProjection;
}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    }),
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-12T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    ...(overrides?.wakeUpSettings ? { wakeUpSettings: overrides.wakeUpSettings } : {}),
    ...(overrides?.wakeUpLog ? { wakeUpLog: overrides.wakeUpLog } : {})
  }) as unknown as WorkflowSnapshot;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Feature 014 — WakeUpTab.svelte', () => {
  it('renders with sensible defaults (disabled / Chronological / 04:00)', () => {
    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    const enabled = getByTestId('wakeup-input-enabled') as HTMLInputElement;
    expect(enabled.checked).toBe(false);

    const select = getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement;
    expect(select.value).toBe('chronological');

    const time = getByTestId('wakeup-input-chronological-time') as HTMLInputElement;
    expect(time.value).toBe('04:00');
  });

  it('clicking Wake up now calls the shared helper and renders Recorded on accepted ack', async () => {
    wakeNowSpy.mockResolvedValue({
      status: 'accepted',
      result: { outcome: 'succeeded', message: 'Wake up completed', attempt: null }
    });

    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });
    await fireEvent.click(getByTestId('wakeup-now') as HTMLButtonElement);

    expect(wakeNowSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(getByTestId('wakeup-now-status').textContent).toContain('Recorded');
    });
  });

  it('renders the newest wake-up log rows from snapshot projection', () => {
    const { getAllByTestId, queryByTestId } = render(WakeUpTab, {
      props: {
        snapshot: buildSnapshot({
          wakeUpLog: {
            entries: [
              {
                id: 'newest',
                timestamp: '2026-05-14T10:00:00.000Z',
                triggerSource: 'manual',
                status: 'succeeded',
                durationMs: 120,
                rawResponse: 'pong',
                message: 'Wake up completed',
                truncated: false
              },
              {
                id: 'older',
                timestamp: '2026-05-14T09:00:00.000Z',
                triggerSource: 'scheduled',
                status: 'skipped',
                durationMs: null,
                rawResponse: '',
                message: 'Wake up skipped',
                truncated: false
              }
            ]
          }
        })
      }
    });

    expect(queryByTestId('wakeup-log-empty')).toBeNull();
    const rows = getAllByTestId('wakeup-log-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('manual');
    expect(rows[0].textContent).toContain('pong');
    expect(rows[1].textContent).toContain('scheduled');
    expect(rows[1].textContent).toContain('Wake up skipped');
  });

  it('keeps Chronological + Periodic inputs disabled while Enable is off', () => {
    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    const select = getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement;
    const time = getByTestId('wakeup-input-chronological-time') as HTMLInputElement;
    expect(select.disabled).toBe(true);
    expect(time.disabled).toBe(true);
  });

  it('always renders the permanent FR-015 no-state-verification note', () => {
    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });
    expect(getByTestId('wakeup-info-no-state-verification')).toBeTruthy();
  });

  it('toggling Enable un-disables the scheduler + time inputs', async () => {
    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    const enabled = getByTestId('wakeup-input-enabled') as HTMLInputElement;
    await fireEvent.click(enabled);

    expect((getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement).disabled).toBe(false);
    expect((getByTestId('wakeup-input-chronological-time') as HTMLInputElement).disabled).toBe(false);
  });

  it('Save calls saveWakeUpSettings exactly once with the 4-key chronological payload', async () => {
    saveSpy.mockResolvedValue({ status: 'accepted' });

    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    // Flip Enable on so the active-field validity gate cares.
    await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);

    // Adjust the time to confirm the draft flows through to the helper.
    const time = getByTestId('wakeup-input-chronological-time') as HTMLInputElement;
    await fireEvent.input(time, { target: { value: '06:30' } });

    await fireEvent.click(getByTestId('wakeup-save') as HTMLButtonElement);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '06:30',
      // Default projection from IDLE_WAKEUP_SETTINGS (host-aligned).
      periodicInterval: 'Every 4h'
    });
  });

  it('renders "Saved" badge after accepted resolution', async () => {
    saveSpy.mockResolvedValue({ status: 'accepted' });

    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });
    await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
    await fireEvent.click(getByTestId('wakeup-save') as HTMLButtonElement);

    await waitFor(() => {
      expect(getByTestId('wakeup-status').textContent).toContain('Saved');
    });
  });

  it('renders "Rejected: <reason>" badge after rejected resolution (verbatim)', async () => {
    saveSpy.mockResolvedValue({ status: 'rejected', reason: 'daemon-install-failed:<redacted>' });

    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });
    await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
    await fireEvent.click(getByTestId('wakeup-save') as HTMLButtonElement);

    await waitFor(() => {
      const status = getByTestId('wakeup-status').textContent ?? '';
      // The helper's reason vocabulary is rendered verbatim — the host
      // is responsible for sanitization.
      expect(status).toContain('Rejected:');
      expect(status).toContain('daemon-install-failed:<redacted>');
    });
  });

  it('invalid HH:MM blocks Save AND renders inline error, valid time enables Save', async () => {
    saveSpy.mockResolvedValue({ status: 'accepted' });

    const { getByTestId, queryByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    // Enable + introduce an invalid time.
    await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
    const time = getByTestId('wakeup-input-chronological-time') as HTMLInputElement;
    await fireEvent.input(time, { target: { value: '25:99' } });

    // Inline error visible.
    expect(queryByTestId('wakeup-error-chronological-time')).toBeTruthy();

    // Save button disabled.
    const save = getByTestId('wakeup-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Helper NOT called even if a click goes through (disabled gating).
    await fireEvent.click(save);
    expect(saveSpy).not.toHaveBeenCalled();

    // Recover with a valid value → save re-enabled, error gone.
    await fireEvent.input(time, { target: { value: '04:00' } });
    expect(queryByTestId('wakeup-error-chronological-time')).toBeNull();
    expect(save.disabled).toBe(false);
  });

  it('allows saving with Enable=off even when the active field is invalid', async () => {
    saveSpy.mockResolvedValue({ status: 'accepted' });

    const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

    // Deliberately mangle the input but keep Enable off — the disabled
    // payload is the canonical uninstall path and must always Save.
    const time = getByTestId('wakeup-input-chronological-time') as HTMLInputElement;
    await fireEvent.input(time, { target: { value: 'not-a-time' } });

    const save = getByTestId('wakeup-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await fireEvent.click(save);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  // ── T047 — periodic save path + R-07 `<5h` advisory warning ─────────────

  describe('T047 — periodic scheduler', () => {
    it('switching to Periodic enables the periodic input and emits the periodic payload on Save', async () => {
      saveSpy.mockResolvedValue({ status: 'accepted' });

      const { getByTestId, queryByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot() }
      });

      // Enable + switch type.
      await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
      const select = getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement;
      await fireEvent.change(select, { target: { value: 'periodic' } });

      // Periodic input is rendered, enabled, with the IDLE_WAKEUP_SETTINGS
      // default 'Every 4h' (host-aligned).
      const periodic = getByTestId('wakeup-input-periodic-interval') as HTMLInputElement;
      expect(periodic).toBeTruthy();
      expect(periodic.disabled).toBe(false);
      expect(periodic.value).toBe('Every 4h');

      // The chronological row is unmounted in the periodic branch.
      expect(queryByTestId('wakeup-field-chronological-time')).toBeNull();

      // Customize the interval and Save.
      await fireEvent.input(periodic, { target: { value: 'Every 30m' } });
      await fireEvent.click(getByTestId('wakeup-save') as HTMLButtonElement);

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith({
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 30m'
      });
    });

    it('shows the <5h advisory warning for intervals below 5 hours WITHOUT blocking Save (R-07)', async () => {
      saveSpy.mockResolvedValue({ status: 'accepted' });

      const { getByTestId, queryByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot() }
      });

      await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
      await fireEvent.change(getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement, {
        target: { value: 'periodic' }
      });

      // Every 1h (60 min) < 5h → warning visible.
      const periodic = getByTestId('wakeup-input-periodic-interval') as HTMLInputElement;
      await fireEvent.input(periodic, { target: { value: 'Every 1h' } });
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeTruthy();

      // Save still works — warning is advisory only.
      const save = getByTestId('wakeup-save') as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      await fireEvent.click(save);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT show the <5h warning at or above 5 hours', async () => {
      const { getByTestId, queryByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot() }
      });

      await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
      await fireEvent.change(getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement, {
        target: { value: 'periodic' }
      });

      const periodic = getByTestId('wakeup-input-periodic-interval') as HTMLInputElement;
      // Exactly 5 hours → not below threshold → no warning.
      await fireEvent.input(periodic, { target: { value: 'Every 5h' } });
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeNull();

      // 6 hours → also no warning.
      await fireEvent.input(periodic, { target: { value: 'Every 6h' } });
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeNull();

      // Exactly 300 minutes (5h expressed in minutes) → no warning.
      await fireEvent.input(periodic, { target: { value: 'Every 300m' } });
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeNull();
    });

    it('shows the inline error for malformed periodic input and blocks Save', async () => {
      saveSpy.mockResolvedValue({ status: 'accepted' });

      const { getByTestId, queryByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot() }
      });

      await fireEvent.click(getByTestId('wakeup-input-enabled') as HTMLInputElement);
      await fireEvent.change(getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement, {
        target: { value: 'periodic' }
      });

      const periodic = getByTestId('wakeup-input-periodic-interval') as HTMLInputElement;
      await fireEvent.input(periodic, { target: { value: 'soon' } });

      expect(queryByTestId('wakeup-error-periodic-interval')).toBeTruthy();
      // No <5h warning while the input is malformed.
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeNull();

      const save = getByTestId('wakeup-save') as HTMLButtonElement;
      expect(save.disabled).toBe(true);

      // Recover with a valid value below 5h → error clears, warning appears, Save enabled.
      await fireEvent.input(periodic, { target: { value: 'Every 15m' } });
      expect(queryByTestId('wakeup-error-periodic-interval')).toBeNull();
      expect(queryByTestId('wakeup-warning-periodic-below-5h')).toBeTruthy();
      expect(save.disabled).toBe(false);
    });
  });

  // ── BUG-001 / BUG-002 — FR-025 / SC-010 snapshot hydration ────────────────
  //
  // T065 verifies that the tab presents the currently-persisted Wake up
  // configuration when mounted (not hardcoded defaults), and that an
  // external projection change (e.g. operator saves from another window,
  // or a settings.json edit) is reflected within the tab without
  // requiring a remount. This is the observable contract that BUG-001
  // and BUG-002 both fail against under the pre-014 implementation.

  describe('BUG-001 / BUG-002 — snapshot hydration (FR-025 / SC-010)', () => {
    it('hydrates draft from snapshot.wakeUpSettings on mount (chronological)', () => {
      const wakeUpSettings: WakeUpSettings = {
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '08:30',
        periodicInterval: 'Every 6h'
      };

      const { getByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot({ wakeUpSettings }) }
      });

      expect((getByTestId('wakeup-input-enabled') as HTMLInputElement).checked).toBe(true);
      expect((getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement).value).toBe(
        'chronological'
      );
      expect((getByTestId('wakeup-input-chronological-time') as HTMLInputElement).value).toBe(
        '08:30'
      );
    });

    it('hydrates draft from snapshot.wakeUpSettings on mount (periodic)', () => {
      const wakeUpSettings: WakeUpSettings = {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 30m'
      };

      const { getByTestId, queryByTestId } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot({ wakeUpSettings }) }
      });

      expect((getByTestId('wakeup-input-enabled') as HTMLInputElement).checked).toBe(true);
      expect((getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement).value).toBe(
        'periodic'
      );
      // Chronological row unmounted in the periodic branch.
      expect(queryByTestId('wakeup-field-chronological-time')).toBeNull();
      expect((getByTestId('wakeup-input-periodic-interval') as HTMLInputElement).value).toBe(
        'Every 30m'
      );
    });

    it('resyncs draft when snapshot.wakeUpSettings changes after mount', async () => {
      const initial: WakeUpSettings = {
        enabled: false,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h'
      };

      const { getByTestId, rerender } = render(WakeUpTab, {
        props: { snapshot: buildSnapshot({ wakeUpSettings: initial }) }
      });

      // Initial render reflects the initial projection.
      expect((getByTestId('wakeup-input-enabled') as HTMLInputElement).checked).toBe(false);
      expect((getByTestId('wakeup-input-chronological-time') as HTMLInputElement).value).toBe(
        '04:00'
      );

      // Simulate an external save (e.g. another VS Code window writes to
      // Global config) by rerendering with an updated projection.
      const updated: WakeUpSettings = {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '07:45',
        periodicInterval: 'Every 90m'
      };
      await rerender({ snapshot: buildSnapshot({ wakeUpSettings: updated }) });

      await waitFor(() => {
        expect((getByTestId('wakeup-input-enabled') as HTMLInputElement).checked).toBe(true);
        expect((getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement).value).toBe(
          'periodic'
        );
        expect((getByTestId('wakeup-input-periodic-interval') as HTMLInputElement).value).toBe(
          'Every 90m'
        );
      });
    });

    it('falls back to IDLE_WAKEUP_SETTINGS when snapshot.wakeUpSettings is absent (legacy host)', () => {
      // A snapshot from an older host bundle that does not yet project
      // wakeUpSettings must not crash the tab. The webview falls back to
      // the IDLE constant so the operator still sees the surface.
      const { getByTestId } = render(WakeUpTab, { props: { snapshot: buildSnapshot() } });

      expect((getByTestId('wakeup-input-enabled') as HTMLInputElement).checked).toBe(false);
      expect((getByTestId('wakeup-input-scheduler-type') as HTMLSelectElement).value).toBe(
        'chronological'
      );
      expect((getByTestId('wakeup-input-chronological-time') as HTMLInputElement).value).toBe(
        '04:00'
      );
    });
  });
});
