// Feature 103 (T040, US3 — FR-023) — filtering is a projection over records the
// webview already holds, and nothing more.
//
// FR-023 is the requirement that is easiest to satisfy on day one and easiest
// to lose on day two. Every filter in this story is a predicate over an array
// the snapshot already carries, so the correct implementation asks the host
// nothing; the tempting one adds `CMD_QUERY_HISTORY` the first time someone
// wants server-side paging, and with it an index, a store and a primary-host
// gate for a read.
//
// The claim is therefore structural rather than behavioural: a behavioural test
// can only show that filtering *did not* call the host in the cases it
// exercises. These assertions show it *cannot* — the filter module imports no
// transport, the filter bar posts nothing, and the command registry gained no
// member.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { MUTATING_COMMANDS } from '../../src/ui/sidebar/message-router';
import { MUTATING_COMMAND_TYPES } from '../../src/contracts/sidebar-command-metadata';
import { CMD_RERUN_FROM_HISTORY } from '../../src/contracts/sidebar-ipc';

const WEBVIEW_SRC = path.join(__dirname, '../../webview-ui/src');

function read(relative: string): string {
  return readFileSync(path.join(WEBVIEW_SRC, relative), 'utf8');
}

function importLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+'/.test(line))
    .join('\n');
}

/**
 * Every way this webview reaches the host. `postCommand` is the transport
 * itself; the `*-ipc` helpers are the per-family call sites `tests/lint/` pins
 * one of each; `messages` is where the command constants live, and importing it
 * is the step before posting one.
 */
const TRANSPORT_MARKERS: readonly RegExp[] = [
  /vscode-api/,
  /postCommand/,
  /host-transport/,
  /-ipc(\.js)?['"]/,
  /lib\/messages/
];

describe('filtering reaches nothing (T040, FR-023)', () => {
  it('the filter module imports no transport of any kind', () => {
    const source = read('lib/history-filters.ts');

    for (const marker of TRANSPORT_MARKERS) {
      expect(source, `history-filters.ts must not reference ${marker}`).not.toMatch(marker);
    }
    // A positive control: the module does import, so the absence above is a
    // property of what it imports rather than of a file the reader missed.
    expect(importLines(source)).toMatch(/history-rows/);
  });

  it('the filter bar posts no command', () => {
    const source = read('components/HistoryFilterBar.svelte');

    for (const marker of TRANSPORT_MARKERS) {
      expect(source, `HistoryFilterBar.svelte must not reference ${marker}`).not.toMatch(marker);
    }
  });

  it('introduces no store, index or query engine on the host side', () => {
    // The three nouns FR-023 names. Searched in the module that would have to
    // hold them: a host-side filter needs somewhere to filter from.
    const source = read('lib/history-filters.ts');

    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest/);
  });
});

describe('the command registry is unchanged by this feature (T040, FR-023)', () => {
  it('registers no new mutating command', () => {
    // Pinned by count as well as by name. A new entry added for a "just one
    // read" command would pass a name-shaped assertion and fail this one.
    expect(MUTATING_COMMAND_TYPES).toHaveLength(46);
    expect(MUTATING_COMMANDS.size).toBe(MUTATING_COMMAND_TYPES.length);
  });

  it('leaves re-run as the only history command that mutates', () => {
    const historyCommands = [...MUTATING_COMMANDS].filter((type) => /history/i.test(type));

    expect(historyCommands).toEqual([CMD_RERUN_FROM_HISTORY]);
  });

  it('registers no filter, query or search command at all', () => {
    for (const type of MUTATING_COMMANDS) {
      expect(type, `${type} looks like a query command`).not.toMatch(/filter|query|search/i);
    }
  });
});
