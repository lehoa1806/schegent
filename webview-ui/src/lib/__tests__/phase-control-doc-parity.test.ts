// The operator guide's table of what Disable and Enable show, in
// `docs/operations/phase-task-management.md`, quotes one sentence per outcome. Nothing held the
// page to the sentences this module shows: when the webview gave Phase its capital in four of
// them, the page was brought along by hand. This reads the table and asks the module for the
// sentence of each outcome the table names.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lifecycleMessage, lifecycleRefusalText } from '../lifecycle-control-ipc';

const GUIDE = resolve(__dirname, '../../../../docs/operations/phase-task-management.md');
const HEADING = '### What Disable and Enable tell the operator';
/** The row for an accepted command, which shows no sentence. */
const ACCEPTED = 'Accepted';
/** The row for a wait that ran out; the module keys its sentence `timeout`. */
const NO_ANSWER = 'No answer within the wait';
/** The outcomes the table names, in its order. A row added or dropped is a change to read. */
const OUTCOMES = [
  'run-terminal',
  'phase-already-started',
  'no-disabled-override',
  'phase-not-future',
  'workspace-not-trusted',
  'untrusted-workspace',
  'secondary-window-readonly',
  'timeout'
];

interface Row {
  readonly outcome: string;
  readonly sentence: string;
}

/** The body rows of the first table under the heading, its header and rule left out. */
function tableRows(markdown: string): readonly Row[] {
  const start = markdown.indexOf(HEADING);
  if (start < 0) throw new Error(`"${HEADING}" is missing from the guide`);
  const lines = markdown.slice(start).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  if (first < 0) throw new Error(`no table follows "${HEADING}"`);
  const table = lines.slice(first);
  const past = table.findIndex((line) => !line.startsWith('|'));
  return table.slice(2, past < 0 ? undefined : past).map((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return { outcome: cells.at(1) ?? '', sentence: cells.at(2) ?? '' };
  });
}

/** The reason codes a row names: its backticked codes, or `timeout` for the wait. */
function codesOf(outcome: string): readonly string[] {
  if (outcome === NO_ANSWER) return ['timeout'];
  return [...outcome.matchAll(/`([a-z-]+)`/g)].map((match) => match.at(1) ?? '');
}

describe('the guide to Disable and Enable quotes the sentences the controls show', () => {
  const rows = tableRows(readFileSync(GUIDE, 'utf8'));

  it('names the outcomes it is held to', () => {
    expect(rows.flatMap((row) => codesOf(row.outcome))).toEqual(OUTCOMES);
  });

  it('says an accepted command shows nothing, as the module does', () => {
    expect(rows.map((row) => row.outcome)).toContain(ACCEPTED);
    expect(lifecycleMessage({ outcome: 'accepted' })).toBeNull();
  });

  it('quotes each refusal and the wait in the words the control shows', () => {
    const quoted = rows.flatMap((row) =>
      codesOf(row.outcome).map((code) => ({ code, sentence: row.sentence }))
    );
    const shown = quoted.map(({ code }) => ({ code, sentence: lifecycleRefusalText(code) }));
    expect(quoted).toEqual(shown);
  });
});
