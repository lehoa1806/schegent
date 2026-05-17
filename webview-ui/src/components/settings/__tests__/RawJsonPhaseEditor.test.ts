/**
 * Feature 011 T054 — RawJsonPhaseEditor.svelte unit tests.
 *
 * Covers:
 *   SC-008  — round-trip without loss: a JSON edit that adds an
 *             unrelated field preserves every original field.
 *   FR-028  — JSON serialized with two-space indent.
 *   FR-029  — Save is disabled while validation fails.
 *   FR-031  — unknown top-level fields preserved on round-trip
 *             (we render permissively; the host validator is final).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import RawJsonPhaseEditor from '../RawJsonPhaseEditor.svelte';

afterEach(() => {
  cleanup();
});

const PHASE_FIXTURE = {
  id: 'speckit-plan',
  name: 'Plan',
  instruction: 'Produce a phased implementation plan.',
  loopable: false,
  model: 'claude-opus-4-7',
  effort: 'high'
};

describe('Feature 011 T054 — RawJsonPhaseEditor (SC-008, FR-028, FR-029, FR-031)', () => {
  it('serializes the phase as two-space indented JSON', () => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // The pretty-printed form must contain a 2-space indent for the
    // first inner field. JSON.stringify(..., null, 2) always emits
    // "\n  \"id\"" for the first key.
    expect(textarea.value).toMatch(/\n {2}"id":/);
    // Sanity: parses back to the same payload.
    expect(JSON.parse(textarea.value)).toEqual(PHASE_FIXTURE);
  });

  it('disables Save while JSON is malformed (FR-029)', async () => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;
    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Type something that breaks the JSON
    await fireEvent.input(textarea, {
      target: { value: textarea.value + '\nzzz' }
    });
    expect(save.disabled).toBe(true);
    const error = container.querySelector('[data-testid="raw-json-error"]');
    expect(error).not.toBeNull();
  });

  it('re-enables Save once JSON parses cleanly again', async () => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;
    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    await fireEvent.input(textarea, { target: { value: 'NOT JSON' } });
    expect(save.disabled).toBe(true);
    await fireEvent.input(textarea, {
      target: { value: JSON.stringify(PHASE_FIXTURE, null, 2) }
    });
    expect(save.disabled).toBe(false);
  });

  it('round-trips unknown top-level fields without loss (FR-031, SC-008)', async () => {
    const withUnknownField = {
      ...PHASE_FIXTURE,
      operatorCustomField: 'experimental-flag-value'
    };
    const onSave = vi.fn();
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: withUnknownField, onsave: onSave }
    });
    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual(withUnknownField);
    expect(onSave.mock.calls[0][0]).toHaveProperty('operatorCustomField', 'experimental-flag-value');
  });

  it('emits the edited phase via onsave callback when Save is clicked', async () => {
    const onSave = vi.fn();
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE, onsave: onSave }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;
    const edited = { ...PHASE_FIXTURE, name: 'Plan (renamed)' };
    await fireEvent.input(textarea, {
      target: { value: JSON.stringify(edited, null, 2) }
    });
    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual(edited);
  });
});
