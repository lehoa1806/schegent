// FR-R4-F15 (feature 243, contract P3, P5.1 to P5.3; FR-021, FR-026; User Story 1 scenarios 3 to 5) —
// what the "Show last error" region says about a Run's retained failure record.
//
// The panel is presentational: it is given a state (`loading`, an answer, or `failed`) and renders
// it. Each answer has one sentence of its own, pinned here as a literal so a reworded line fails in
// front of a reviewer and not in front of an operator. The record view is pinned line by line in the
// order contract P3 lists, and every value is checked to arrive as text: a summary is text the agent
// wrote, so `<img onerror>`, markdown and a Svelte `{@html}` must read as themselves and add no
// element (hard rule 2).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import FailureRecordPanel from '../FailureRecordPanel.svelte';
import type { FailureRecordV1, RecordEntry } from '../../../../src/contracts/failure-record';
import { FAILURE_CAUSE_LABELS } from '../../../../src/contracts/failure-cause';
import { formatAbsoluteTime } from '../../lib/format';
import type { FailureRecordPanelState } from '../../lib/failure-record-ipc';

afterEach(() => cleanup());

const ITEM_ID = 'task-1';
const LABEL = 'Add the export button';
const ADDRESS = { queueId: 'default', taskId: ITEM_ID };
const FAILED_AT = '2026-10-28T14:30:05.123Z';
const TESTID = `failure-record-panel-${ITEM_ID}`;

function entry(summary: string, tag: RecordEntry['tag'], source: RecordEntry['source'] = 'agent'): RecordEntry {
  return { kind: 'issue', summary, tag, source };
}

function record(overrides: Partial<FailureRecordV1> = {}): FailureRecordV1 {
  return {
    recordVersion: 1,
    queueId: 'default',
    taskId: ITEM_ID,
    runId: 'run-1',
    failedAt: FAILED_AT,
    suffix: '0a1b2c3d',
    cause: 'last_phase_issues_remain',
    phase: 'implement',
    iteration: 2,
    iterationCap: 3,
    issueState: 'listed',
    entries: [entry('plain one', 'regression')],
    omittedIssueCount: 0,
    metrics: [],
    omittedMetricCount: 0,
    ...overrides
  };
}

function available(rec: FailureRecordV1, recordCount = 1): FailureRecordPanelState {
  return { kind: 'answer', answer: { outcome: 'available', ...ADDRESS, record: rec, recordCount } };
}

function mountPanel(state: FailureRecordPanelState) {
  const view = render(FailureRecordPanel, { props: { itemId: ITEM_ID, label: LABEL, state } });
  const panel = view.getByTestId(TESTID);
  return { ...view, panel };
}

const text = (element: Element): string => element.textContent.replace(/\s+/g, ' ').trim();

describe('every answer says one sentence of its own (P5.1)', () => {
  const SENTENCES: ReadonlyArray<readonly [string, FailureRecordPanelState, string]> = [
    ['loading', { kind: 'loading' }, 'Loading failure diagnostics…'],
    ['none', { kind: 'answer', answer: { outcome: 'none', ...ADDRESS } }, 'No failure diagnostics were recorded for this Run.'],
    [
      'expired',
      { kind: 'answer', answer: { outcome: 'expired', ...ADDRESS } },
      "This Run's failure diagnostics were removed by retention."
    ],
    [
      'unavailable',
      { kind: 'answer', answer: { outcome: 'unavailable', ...ADDRESS } },
      'Failure diagnostics for this Run are unavailable.'
    ],
    [
      'malformed',
      { kind: 'answer', answer: { outcome: 'malformed', ...ADDRESS, recordCount: 1 } },
      "This Run's failure record could not be read."
    ],
    ['failed', { kind: 'failed' }, 'Could not load failure diagnostics.']
  ];

  it.each(SENTENCES)('%s', (_label, state, sentence) => {
    const { panel } = mountPanel(state);
    expect(text(panel)).toBe(sentence);
  });

  it('gives the six sentences pairwise distinct text', () => {
    const sentences = SENTENCES.map(([, , sentence]) => sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('is a labelled region with a list only where there are issues, and no action button', () => {
    const { panel, container } = mountPanel(available(record()));
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-label')).toBe(`Failure diagnostics for ${LABEL}`);
    expect(panel.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    cleanup();
    const none = mountPanel({ kind: 'answer', answer: { outcome: 'none', ...ADDRESS } });
    expect(none.panel.querySelector('ul')).toBeNull();
  });
});

describe('the record view, line by line (P5.2)', () => {
  const FULL = record({
    cause: 'cap_exhausted',
    stalledCount: 3,
    entries: [
      entry('approve the bump', 'needs-approval'),
      entry('something else', 'unclassified'),
      entry('the export test fails', 'regression'),
      entry('no contract block detected', 'constitution', 'host')
    ],
    omittedIssueCount: 480,
    metrics: Array.from({ length: 16 }, (_, index) => ({ key: `metric_${String(index).padStart(2, '0')}`, value: index + 0.5 })),
    omittedMetricCount: 2
  });

  it('shows every line, in the order P3 lists them, for a record with everything', () => {
    const { panel } = mountPanel(available(FULL, 3));
    const shown = text(panel);
    const lines = [
      'Latest of 3 recorded failures of this Run',
      `Cause: ${FAILURE_CAUSE_LABELS.cap_exhausted} (cap_exhausted)`,
      'Phase: implement',
      'Iteration 2 of 3',
      'Unchanged comparisons: 3',
      `Failed at ${formatAbsoluteTime(FAILED_AT)}`,
      'approve the bump — reported as needs-approval',
      'something else — reported as unclassified',
      'the export test fails — reported as regression',
      'no contract block detected — added by Schegent',
      '480 more issues were not recorded.',
      'Last metrics',
      'metric_00: 0.5',
      'metric_15: 15.5',
      '2 more metrics were not recorded.',
      "Tags are the agent's own labels; Schegent does not check them."
    ];
    let from = 0;
    for (const line of lines) {
      const at = shown.indexOf(line, from);
      expect(at, line).toBeGreaterThanOrEqual(from);
      from = at + line.length;
    }
  });

  it('lists exactly the entries given, one list item each, and all sixteen metrics', () => {
    const { panel } = mountPanel(available(FULL, 3));
    expect(panel.querySelectorAll(`[data-testid^="failure-record-issue-${ITEM_ID}-"]`)).toHaveLength(4);
    expect(panel.querySelectorAll(`[data-testid^="failure-record-metric-${ITEM_ID}-"]`)).toHaveLength(16);
  });

  it('shows the count line only for more than one record', () => {
    expect(text(mountPanel(available(FULL, 1)).panel)).not.toContain('recorded failures of this Run');
    cleanup();
    expect(text(mountPanel(available(FULL, 3)).panel)).toContain('Latest of 3 recorded failures of this Run');
  });

  it('shows the stall line only when the count is greater than one', () => {
    for (const [stalledCount, shown] of [[1, false], [3, true], [0, false]] as const) {
      cleanup();
      const { panel } = mountPanel(available(record({ stalledCount }), 1));
      expect(text(panel).includes('Unchanged comparisons'), `stalledCount ${stalledCount}`).toBe(shown);
    }
    cleanup();
    expect(text(mountPanel(available(record(), 1)).panel)).not.toContain('Unchanged comparisons');
  });

  it('leaves out a line whose value is absent: no phase, no iteration, no metrics, no omitted counts', () => {
    const bare = record({ phase: undefined, iteration: undefined, iterationCap: undefined });
    const { panel } = mountPanel(available(bare));
    const shown = text(panel);
    for (const fragment of ['Phase:', 'Iteration ', 'Last metrics', 'more issues', 'more metrics']) {
      expect(shown.includes(fragment), fragment).toBe(false);
    }
  });

  it('shows the iteration line only when both numbers are present', () => {
    expect(text(mountPanel(available(record({ iterationCap: undefined }))).panel)).not.toContain('Iteration ');
  });

  it('shows the claims footnote only when an entry is the agent\'s', () => {
    const hostOnly = record({ entries: [entry('no contract block detected', 'constitution', 'host')] });
    expect(text(mountPanel(available(hostOnly)).panel)).not.toContain('Schegent does not check them');
    cleanup();
    expect(text(mountPanel(available(record())).panel)).toContain('Schegent does not check them');
  });

  it.each([
    ['none-reported', 'The phase reported no open issues.'],
    ['unparsed', "No issue list could be read from the phase's output."],
    ['not-applicable', 'The Run failed before a phase produced output.']
  ] as const)('says "%s" with its own sentence and no list', (issueState, sentence) => {
    const rec = record({ issueState, entries: [], phase: undefined, iteration: undefined, iterationCap: undefined });
    const { panel } = mountPanel(available(rec));
    expect(text(panel)).toContain(sentence);
    expect(panel.querySelector('ul')).toBeNull();
    expect(text(panel)).not.toContain('Schegent does not check them');
  });

  it('shows the cause by its fixed label and code, never by anything the record could carry', () => {
    for (const cause of Object.keys(FAILURE_CAUSE_LABELS) as Array<keyof typeof FAILURE_CAUSE_LABELS>) {
      cleanup();
      const { panel } = mountPanel(available(record({ cause })));
      expect(text(panel)).toContain(`Cause: ${FAILURE_CAUSE_LABELS[cause]} (${cause})`);
    }
  });
});

describe('hostile text renders as text (P5.3, FR-026)', () => {
  const HOSTILE = ['<img src=x onerror=alert(1)>', '**bold**', '[link](https://x)', '{@html x}'];
  const PLAIN = ['plain a', 'plain b', 'plain c', 'plain d'];
  const withSummaries = (summaries: readonly string[]) =>
    available(record({ entries: summaries.map((summary) => entry(summary, 'unclassified')) }));

  it('shows each hostile summary as its own literal characters', () => {
    const { panel } = mountPanel(withSummaries(HOSTILE));
    const shown = text(panel);
    for (const summary of HOSTILE) expect(shown).toContain(summary);
  });

  it('creates no element beyond the ones the same panel makes for plain summaries', () => {
    const hostile = mountPanel(withSummaries(HOSTILE));
    const hostileCount = hostile.panel.querySelectorAll('*').length;
    cleanup();
    const plain = mountPanel(withSummaries(PLAIN));
    expect(hostileCount).toBe(plain.panel.querySelectorAll('*').length);
    cleanup();
    const again = mountPanel(withSummaries(HOSTILE));
    for (const tag of ['img', 'a', 'strong', 'b', 'script', 'iframe', 'style']) {
      expect(again.panel.querySelector(tag), tag).toBeNull();
    }
  });

  it('renders a hostile metric key and a hostile label as text too', () => {
    const rec = record({ metrics: [{ key: 'a_b', value: 1 }] });
    const view = render(FailureRecordPanel, {
      props: { itemId: ITEM_ID, label: '<img src=x onerror=alert(1)>', state: available(rec) }
    });
    const panel = view.getByTestId(TESTID);
    expect(panel.getAttribute('aria-label')).toBe('Failure diagnostics for <img src=x onerror=alert(1)>');
    expect(panel.querySelector('img')).toBeNull();
  });
});
