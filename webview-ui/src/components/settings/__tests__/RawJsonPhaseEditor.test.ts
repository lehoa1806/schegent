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
import { AUTHORED_PHASE_FIELDS } from '../../../../../src/contracts/process-definitions.js';
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

  /**
   * The reported defect: opening the JSON view on a Phase that declares
   * `sideEffects` rendered `Invalid JSON: field \`sideEffects\` is not
   * author-controlled` before a single keystroke, and Save stayed disabled —
   * the editor refused the document it had just serialized.
   *
   * The cause was a forked closed set. `AUTHORED_PHASE_FIELDS` in
   * `src/config/process-definition-validator.ts` is the host's authority on what
   * an author may write, and this component carried a 13-name hand-kept copy of
   * it that predated the containment fields. The host's own comment beside
   * `sideEffects` names this exact failure — "the save path and the import path
   * must hold a definition to the same closed set, or a Phase would be accepted
   * by one route and refused by the other on the same field".
   *
   * Derived from the set rather than listed, so the next authored field is
   * covered with no edit here.
   */
  describe('holds the document to the host closed set, not a fork of it', () => {
    const DECLARED = {
      sideEffects: 'git',
      evidencePolicy: 'best-effort',
      hostVerification: 'exit-code',
      capabilities: ['workspace-write'],
      spendBoundUsd: 5,
      spendBoundTokens: 100_000,
      forceContinueOnRetryCap: true,
      description: 'A described phase.',
      timeoutSeconds: 45,
      retryCondition: 'attempts < 2',
      isRequired: false,
      runner: 'codex'
    } as const;

    /**
     * `skill` is exclusive-or with `instruction`, which `PHASE_FIXTURE` carries,
     * so it cannot join the matrix above — a row with both is refused, correctly.
     * "accepts exactly one bounded skill directive" above drives it on its own
     * fixture. `phaseId` is the deliberate exclusion; see the test below.
     */
    const DRIVEN_ELSEWHERE = ['skill', 'phaseId'];

    it.each(Object.entries(DECLARED))(
      'accepts a declared %s and leaves Save enabled',
      async (field, value) => {
        const onSave = vi.fn();
        const phase = { ...PHASE_FIXTURE, [field]: value };
        const { container } = render(RawJsonPhaseEditor, {
          props: { phase, onsave: onSave }
        });
        const save = container.querySelector(
          '[data-testid="raw-json-save"]'
        ) as HTMLButtonElement;
        expect(
          container.querySelector('[data-testid="raw-json-error"]')?.textContent ?? '',
          `${field} is in AUTHORED_PHASE_FIELDS and must not be refused`
        ).not.toContain('is not author-controlled');
        expect(save.disabled).toBe(false);
        await fireEvent.click(save);
        expect(onSave).toHaveBeenCalledWith(phase);
      }
    );

    it('covers every authored field the Builder row can carry', () => {
      // Derived from the host set, so the next authored field lands here with no
      // edit and fails until it is driven.
      const covered = new Set([
        ...Object.keys(PHASE_FIXTURE),
        ...Object.keys(DECLARED),
        ...DRIVEN_ELSEWHERE
      ]);
      const uncovered = [...AUTHORED_PHASE_FIELDS].filter((field) => !covered.has(field));
      expect(
        uncovered,
        `authored fields this test does not drive: ${uncovered.join(', ')}`
      ).toEqual([]);
    });

    it('still refuses a value outside a declared closed enum', async () => {
      const { container } = render(RawJsonPhaseEditor, {
        props: { phase: PHASE_FIXTURE }
      });
      const textarea = container.querySelector(
        '[data-testid="raw-json-input"]'
      ) as HTMLTextAreaElement;
      await fireEvent.input(textarea, {
        target: {
          value: JSON.stringify({ ...PHASE_FIXTURE, sideEffects: 'banana' }, null, 2)
        }
      });
      expect((container.querySelector('[data-testid="raw-json-save"]') as HTMLButtonElement).disabled)
        .toBe(true);
    });

    it('still refuses `phaseId`, which this row form does not carry', async () => {
      const { container } = render(RawJsonPhaseEditor, {
        props: { phase: { ...PHASE_FIXTURE, phaseId: 'speckit-plan' } }
      });
      expect((container.querySelector('[data-testid="raw-json-save"]') as HTMLButtonElement).disabled)
        .toBe(true);
    });
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
