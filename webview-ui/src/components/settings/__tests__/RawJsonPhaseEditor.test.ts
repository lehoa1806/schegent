/**
 * Feature 011 T054 — RawJsonPhaseEditor.svelte unit tests.
 *
 * Covers:
 *   SC-008  — round-trip without loss: a JSON edit that adds an
 *             unrelated field preserves every original field.
 *   FR-028  — JSON serialized with two-space indent.
 *   FR-029  — Save is disabled while validation fails.
 *   FR-031  — host-owned and unknown top-level fields are rejected.
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
  version: 1,
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
    expect(textarea.getAttribute('aria-labelledby')).toBe('raw-json-label');
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
    expect(error?.getAttribute('role')).toBe('alert');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('raw-json-error');
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

  it.each(['gemini', 42])('rejects unsupported runner value %j', async (runner) => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;
    await fireEvent.input(textarea, {
      target: { value: JSON.stringify({ ...PHASE_FIXTURE, runner }, null, 2) }
    });

    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.querySelector('[data-testid="raw-json-error"]')?.textContent)
      .toContain('must be one of claude, codex, agy');
  });

  it.each(['claude', 'codex', 'agy'])('accepts supported runner %s', async (runner) => {
    const onSave = vi.fn();
    const phase = { ...PHASE_FIXTURE, runner };
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase, onsave: onSave }
    });

    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(phase);
  });

  it('round-trips isRequired: false without coercion', async () => {
    const onSave = vi.fn();
    const phase = { ...PHASE_FIXTURE, isRequired: false };
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase, onsave: onSave }
    });

    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    await fireEvent.click(save);

    expect(onSave).toHaveBeenCalledWith(phase);
  });

  it('rejects a non-boolean isRequired value', async () => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector(
      '[data-testid="raw-json-input"]'
    ) as HTMLTextAreaElement;

    await fireEvent.input(textarea, {
      target: {
        value: JSON.stringify({ ...PHASE_FIXTURE, isRequired: 'false' }, null, 2)
      }
    });

    const save = container.querySelector(
      '[data-testid="raw-json-save"]'
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.querySelector('[data-testid="raw-json-error"]')?.textContent)
      .toContain('must be a boolean');
  });

  it('rejects unknown top-level fields owned by the host', async () => {
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
    expect(save.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="raw-json-error"]')?.textContent)
      .toContain('is not author-controlled');
  });

  it('accepts exactly one bounded skill directive', async () => {
    const skillPhase = { ...PHASE_FIXTURE, skill: 'security-review' } as Record<string, unknown>;
    delete skillPhase.instruction;
    const onSave = vi.fn();
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: skillPhase, onsave: onSave }
    });
    const save = container.querySelector('[data-testid="raw-json-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(skillPhase);
  });

  it('rejects an empty configured model', async () => {
    const { container } = render(RawJsonPhaseEditor, {
      props: { phase: PHASE_FIXTURE }
    });
    const textarea = container.querySelector('[data-testid="raw-json-input"]') as HTMLTextAreaElement;
    await fireEvent.input(textarea, {
      target: { value: JSON.stringify({ ...PHASE_FIXTURE, model: '   ' }, null, 2) }
    });
    expect((container.querySelector('[data-testid="raw-json-save"]') as HTMLButtonElement).disabled)
      .toBe(true);
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
