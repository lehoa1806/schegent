// Feature 102 (T018, US2 — FR-010, FR-011, FR-012) — the surface does not judge
// a submission, and the host's refusal is the only refusal there is.
//
// This is the rule most likely to be re-broken by someone being helpful. Greying
// out Run until every required port is filled *feels* like a courtesy; what it
// actually does is move the contract into the webview, where it becomes a second
// implementation of a rule the host already owns and enforces. The two then drift
// in the direction that costs most: the surface refuses runs the host would have
// accepted, and the operator has no way to see why, because nothing was ever
// sent. The host's refusal at least names the field.
//
// So the assertions come in two kinds, and both are needed:
//
//   * **Behavioural** — Run is live over an empty form, the empty form reaches the
//     host, and what comes back is rendered as the host worded it. A test that
//     only checked the enabled state would pass against a surface that silently
//     dropped the submission.
//
//   * **Structural** — no source under `Runs/` computes a predicate over the
//     composed submission at all. Behaviour alone cannot cover this: a
//     completeness check added for one field, on one form, in one arm, is a test
//     nobody wrote and a bug nobody sees until the field is left blank. The scan
//     strips comments first (this header would otherwise fail it) and then holds
//     every `disabled` expression to an allowlist of *host-state* identifiers —
//     in flight, or barred by the window (FR-015). Anything else is the surface
//     forming an opinion. The one exemption is the host's own wire vocabulary,
//     which the surface may name because naming it is how a refusal gets
//     rendered; it is held to exact quoted literals and to being in use.
//
// The scan asserts its own reach before asserting anything about what it found:
// a directory walk that silently matches nothing is a green test that checks
// nothing, which is worse than a red one.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshot } from './launch-fixture';

const launchPipeline = vi.fn();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: (...args: readonly unknown[]) => launchPipeline(...args)
}));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => {
  cleanup();
  launchPipeline.mockReset();
});

const RUNS_DIR = resolve(__dirname, '..');

/**
 * Only host state may bar a control. `pending` and `submitting` are "a request is
 * in flight"; `canLaunch` is the window's own answer (FR-015). None of them is a
 * judgement about what the operator typed.
 */
const ALLOWED_DISABLED_IDENTIFIERS = new Set(['pending', 'submitting', 'inFlight', 'canLaunch']);

/** Words that name a surface-side verdict on a submission. */
const FORBIDDEN_PREDICATE = /\b(?:valid|invalid|validate|validity|validation|complete|completeness|canSubmit|canRun|readyToRun|missingRequired)\w*/i;

/**
 * The host's own wire vocabulary, quoted exactly as the host spells it.
 *
 * These are values that arrive *from* the host, not words the surface may use
 * about a judgement of its own — and a surface that renders the refusal named
 * `rejected-validation` has to name it. Forbidding the name would forbid the
 * rendering, which is the opposite of what FR-012 asks for.
 *
 * The exemption is deliberately the literal including its quotes, so it lets
 * through the string and nothing else: a `validation` identifier, field, or
 * function still trips the scan wherever it appears. Growth of this list is the
 * thing to watch in review — every entry must be a value the host sends.
 */
const HOST_WIRE_VOCABULARY = ["'rejected-validation'", "'workflow-invalid'"] as const;

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Replaced by empty quotes, which carry no word characters to re-join across. */
function stripHostWireVocabulary(source: string): string {
  return HOST_WIRE_VOCABULARY.reduce(
    (code, literal) => code.split(literal).join("''"),
    source
  );
}

function runsSources(): readonly { readonly file: string; readonly code: string }[] {
  return readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.svelte') || name.endsWith('.ts'))
    .map((file) => ({
      file,
      code: stripHostWireVocabulary(stripComments(readFileSync(join(RUNS_DIR, file), 'utf8')))
    }));
}

async function openForm() {
  const view = render(RunsSurface, { snapshot: buildSnapshot() });
  await fireEvent.click(view.getByTestId('launchable-select-pipeline-analysis-pipeline'));
  await fireEvent.click(view.getByTestId('launchable-detail-trigger'));
  return view;
}

describe('the Run control is never withheld for want of a value (FR-011)', () => {
  it('is present and live over a form with nothing typed into it', async () => {
    const { getByTestId } = await openForm();
    const submit = getByTestId('run-launcher-submit') as HTMLButtonElement;

    expect(submit.disabled).toBe(false);
  });

  it('is withheld only while a launch is in flight', async () => {
    // The one reason a submission may bar its own control: a second press would
    // queue a second run. It is a fact about the request, not a verdict on the
    // values, and it lifts the moment the host answers.
    let answer: (result: unknown) => void = () => {};
    launchPipeline.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { getByTestId } = await openForm();
    const submit = getByTestId('run-launcher-submit') as HTMLButtonElement;

    await fireEvent.click(submit);
    expect(submit.disabled).toBe(true);

    answer({ outcome: 'enqueued', requestId: 'request-3' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submit.disabled).toBe(false);
  });

  it('sends the incomplete submission rather than dropping it', async () => {
    // Enabled but inert would satisfy the assertion above and defeat the point:
    // the operator would be told nothing by a control that did nothing.
    launchPipeline.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [{ field: 'inputs.topic', message: 'Topic is required.' }]
    });
    const { getByTestId } = await openForm();

    await fireEvent.click(getByTestId('run-launcher-submit'));

    expect(launchPipeline).toHaveBeenCalledTimes(1);
    expect(getByTestId('run-launcher-error-inputs.topic').textContent).toContain(
      'Topic is required.'
    );
  });
});

describe('the refusal an operator reads is the host (FR-012)', () => {
  it('renders the reason the host gave, worded as the host worded it', async () => {
    launchPipeline.mockResolvedValue({
      outcome: 'rejected-definition',
      reason: 'the active version was withdrawn mid-flight'
    });
    const { getByTestId } = await openForm();

    await fireEvent.click(getByTestId('run-launcher-submit'));

    expect(getByTestId('run-launcher-status').textContent).toContain(
      'the active version was withdrawn mid-flight'
    );
  });

  it('replaces the previous refusal rather than stacking a second one beside it', async () => {
    // Two refusals on screen is one refusal too many: the operator cannot tell
    // which one describes the attempt they just made.
    launchPipeline.mockResolvedValueOnce({
      outcome: 'rejected-definition',
      reason: 'the active version was withdrawn mid-flight'
    });
    launchPipeline.mockResolvedValueOnce({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'the queue is paused'
    });
    const { getByTestId } = await openForm();

    await fireEvent.click(getByTestId('run-launcher-submit'));
    await fireEvent.click(getByTestId('run-launcher-submit'));

    const status = getByTestId('run-launcher-status').textContent ?? '';
    expect(status).toContain('the queue is paused');
    expect(status).not.toContain('withdrawn mid-flight');
  });

  it('shows no stack trace or bare error identifier', async () => {
    launchPipeline.mockResolvedValue({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'no-host-response'
    });
    const { container, getByTestId } = await openForm();

    await fireEvent.click(getByTestId('run-launcher-submit'));
    const text = container.textContent ?? '';

    expect(text).not.toContain('Error:');
    expect(text).not.toMatch(/\bat\s+\w+\s+\(/);
    expect(text).not.toMatch(/\.[jt]s:\d+/);
  });
});

describe('no component under Runs judges a submission (FR-010)', () => {
  it('scans every source in the directory', () => {
    const sources = runsSources();
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.map((source) => source.file)).toContain('LaunchableDetail.svelte');
  });

  it('bars a control only on host state, never on what was typed', () => {
    const offenders: string[] = [];

    for (const { file, code } of runsSources()) {
      for (const [, expression] of code.matchAll(/\bdisabled=\{([^}]*)\}/g)) {
        const identifiers = expression.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
        for (const identifier of identifiers) {
          if (identifier === 'true' || identifier === 'false') continue;
          if (ALLOWED_DISABLED_IDENTIFIERS.has(identifier)) continue;
          offenders.push(`${file}: disabled={${expression.trim()}}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('declares no completeness or validity predicate of its own', () => {
    const offenders = runsSources()
      .map(({ file, code }) => ({ file, hit: FORBIDDEN_PREDICATE.exec(code)?.[0] }))
      .filter((entry) => entry.hit !== undefined)
      .map((entry) => `${entry.file}: ${entry.hit}`);

    expect(offenders).toEqual([]);
  });

  it('exempts only host wire values that some source actually renders', () => {
    // An exemption nothing uses is an escape hatch waiting to be widened. Each
    // entry has to earn its place by appearing in a source under scan, so the
    // list shrinks back when the refusal it covers stops being rendered.
    const raw = readdirSync(RUNS_DIR)
      .filter((name) => name.endsWith('.svelte') || name.endsWith('.ts'))
      .map((file) => readFileSync(join(RUNS_DIR, file), 'utf8'))
      .join('\n');

    for (const literal of HOST_WIRE_VOCABULARY) {
      expect(raw, `${literal} is exempted but rendered nowhere`).toContain(literal);
      // And the exemption is load-bearing: without it the scan would fire.
      expect(FORBIDDEN_PREDICATE.test(literal)).toBe(true);
    }
  });
});
