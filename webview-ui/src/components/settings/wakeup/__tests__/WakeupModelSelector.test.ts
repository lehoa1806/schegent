// Feature 031 T019 — Svelte component tests for WakeupModelSelector.svelte.
//
// Coverage:
//   (a) Renders four options: 'Default (runner-chosen)' + the three
//       members of WAKEUP_SUPPORTED_MODELS.
//   (b) Reflects the persisted `model` value from props.
//   (c) On change + Save click, calls the helper at
//       `webview-ui/src/lib/save-wakeup-settings.ts` with the new
//       `model` field merged into the full WakeUp settings payload.
//   (d) Rejects non-supported values at the component boundary
//       (defensive — prop injection of a bogus id falls back to the
//       sentinel via internal coercion).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import WakeupModelSelector from '../WakeupModelSelector.svelte';
import {
  RUNNER_DEFAULT_MODEL,
  WAKEUP_SUPPORTED_MODELS,
  type WakeUpModelSelection
} from '../../../../../../src/wakeup/settings';

const saveSpy = vi.fn<
  Parameters<typeof import('../../../../lib/save-wakeup-settings').saveWakeUpSettings>,
  ReturnType<typeof import('../../../../lib/save-wakeup-settings').saveWakeUpSettings>
>();

vi.mock('../../../../lib/save-wakeup-settings', () => ({
  saveWakeUpSettings: (...args: unknown[]) =>
    (saveSpy as unknown as Function)(...args)
}));

beforeEach(() => {
  saveSpy.mockReset();
  saveSpy.mockResolvedValue({ status: 'accepted' });
});

afterEach(() => cleanup());

const baseSettings = {
  enabled: true,
  schedulerType: 'chronological' as const,
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h'
};

describe('Feature 031 T019 — WakeupModelSelector renders the closed registry', () => {
  it('renders one option per member of WAKEUP_SUPPORTED_MODELS plus the default', () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: RUNNER_DEFAULT_MODEL,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    // Total options = registry size + 1 (the runner-default sentinel).
    expect(select.options.length).toBe(WAKEUP_SUPPORTED_MODELS.length + 1);

    // Default sentinel rendered first.
    expect(select.options[0].value).toBe(RUNNER_DEFAULT_MODEL);
    expect(select.options[0].text).toContain('Default');

    // Every registry member is present.
    const optionValues = Array.from(select.options).map((o) => o.value);
    for (const id of WAKEUP_SUPPORTED_MODELS) {
      expect(optionValues).toContain(id);
    }
  });

  it('reflects the persisted `model` value as the selected option', () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: 'claude-sonnet-4-6',
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-4-6');
  });

  it('defaults to the runner-default sentinel when given the sentinel', () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: RUNNER_DEFAULT_MODEL,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    expect(select.value).toBe(RUNNER_DEFAULT_MODEL);
  });

  it('falls back to the runner-default sentinel for a non-supported prop value', () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        // Defensive prop injection — the component MUST coerce this to
        // the sentinel rather than display an unknown id.
        model: 'claude-bogus-9000' as unknown as WakeUpModelSelection,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    expect(select.value).toBe(RUNNER_DEFAULT_MODEL);
  });
});

describe('Feature 031 T019 — WakeupModelSelector save flow', () => {
  it('on Save calls saveWakeUpSettings with the new model merged into the full payload', async () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: RUNNER_DEFAULT_MODEL,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'claude-haiku-4-6' } });
    await fireEvent.click(getByTestId('wakeup-model-save') as HTMLButtonElement);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
    expect(saveSpy).toHaveBeenCalledWith({
      ...baseSettings,
      model: 'claude-haiku-4-6'
    });
  });

  it('renders a Saved status after the helper resolves accepted', async () => {
    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: RUNNER_DEFAULT_MODEL,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'claude-opus-4-7' } });
    await fireEvent.click(getByTestId('wakeup-model-save') as HTMLButtonElement);

    await waitFor(() => {
      expect(getByTestId('wakeup-model-status').textContent).toContain('Saved');
    });
  });

  it('renders a Rejected status after the helper resolves rejected', async () => {
    saveSpy.mockResolvedValue({ status: 'rejected', reason: 'invalid-model' });

    const { getByTestId } = render(WakeupModelSelector, {
      props: {
        model: RUNNER_DEFAULT_MODEL,
        settings: baseSettings
      }
    });

    const select = getByTestId('wakeup-input-model') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'claude-opus-4-7' } });
    await fireEvent.click(getByTestId('wakeup-model-save') as HTMLButtonElement);

    await waitFor(() => {
      const status = getByTestId('wakeup-model-status').textContent ?? '';
      expect(status).toContain('Rejected');
      expect(status).toContain('invalid-model');
    });
  });
});
