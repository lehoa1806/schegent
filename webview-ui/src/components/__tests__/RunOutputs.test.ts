// Feature 087 (T064, T066 — FR-042, FR-043, FR-048) — recorded named outputs in
// Run details.
//
// Three things are pinned here, and the third is the one worth stating: an
// output's name and reference are operator-authored, and an Agent decides
// whether a target got written. Neither may be interpreted as markup. Svelte's
// `{}` interpolation escapes, so what this asserts is that no one replaced it
// with `{@html}` — the assertion reads the rendered DOM for the literal text and
// for the absence of the element the markup would have produced.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import RunOutputs from '../RunOutputs.svelte';
import type { RunOutputRecord } from '../../lib/snapshot-types';

afterEach(() => cleanup());

const RESOLVED: RunOutputRecord = {
  name: 'report',
  status: 'resolved',
  reference: 'out/report.md'
};
const UNRESOLVED: RunOutputRecord = { name: 'summary', status: 'unresolved' };

describe('recorded outputs in Run details (FR-043)', () => {
  it('renders each recorded output with its name and location', () => {
    const { getByTestId } = render(RunOutputs, { outputs: [RESOLVED] });
    expect(getByTestId('run-outputs')).toBeTruthy();
    expect(getByTestId('run-output-record-report').textContent).toContain('report');
    expect(getByTestId('run-output-reference-report').textContent).toContain('out/report.md');
  });

  it('renders nothing at all when the Run recorded no outputs', () => {
    const { queryByTestId } = render(RunOutputs, { outputs: [] });
    expect(queryByTestId('run-outputs')).toBeNull();
  });

  it('keeps the recorded order', () => {
    const { getByTestId } = render(RunOutputs, {
      outputs: [RESOLVED, UNRESOLVED, { name: 'ticket', status: 'resolved', reference: 'out/t.json' }]
    });
    const names = Array.from(
      getByTestId('run-outputs').querySelectorAll('[data-output-name]')
    ).map((element) => element.textContent?.trim());
    expect(names).toEqual(['report', 'summary', 'ticket']);
  });
});

describe('an output that did not resolve (FR-042)', () => {
  it('is shown beside the resolved ones rather than hidden', () => {
    const { getByTestId } = render(RunOutputs, { outputs: [RESOLVED, UNRESOLVED] });
    expect(getByTestId('run-output-record-report')).toBeTruthy();
    expect(getByTestId('run-output-record-summary')).toBeTruthy();
  });

  it('shows its status and no location', () => {
    const { getByTestId, queryByTestId } = render(RunOutputs, { outputs: [UNRESOLVED] });
    expect(getByTestId('run-output-status-summary').textContent).toContain('unresolved');
    expect(queryByTestId('run-output-reference-summary')).toBeNull();
  });
});

describe('text is rendered, never interpreted (FR-048)', () => {
  it('renders markup in a reference as the characters the operator typed', () => {
    const { getByTestId } = render(RunOutputs, {
      outputs: [
        {
          name: 'report',
          status: 'resolved',
          reference: 'out/<img src=x onerror="alert(1)">.md'
        }
      ]
    });
    const cell = getByTestId('run-output-reference-report');
    expect(cell.textContent).toBe('out/<img src=x onerror="alert(1)">.md');
    expect(cell.querySelector('img')).toBeNull();
  });

  it('renders markup in a name as the characters the operator typed', () => {
    const { getByTestId } = render(RunOutputs, {
      outputs: [{ name: '<b>bold</b>', status: 'unresolved' }]
    });
    const row = getByTestId('run-output-record-<b>bold</b>');
    expect(row.textContent).toContain('<b>bold</b>');
    expect(row.querySelector('b')).toBeNull();
  });
});
