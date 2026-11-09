// FR-R4-F05 (T19; contract G, G1, G9; research R20, R23; FR-028 to FR-030; SC-007) — the reference's
// inbound table is `COMMAND_TYPES`, with the authority the declaration gives each command, and its
// registered-only list is the dispositions minus the manifest.
//
// WHY A GATE. `docs/reference/api-and-cli.md` is the one page an integrator reads for the webview
// boundary, and nothing compared it with the code: `documented-commands-exist` and
// `readme-command-parity` cover palette commands only, and `docs:check` reads none of the table.
// The table drifted until it listed five commands that no longer exist, omitted five that do, and
// guarded eight with a letter the router no longer applies (a read-only `R` or primary-only `P` where
// the router gates the command with `M`). That is the failure this gate makes a red test:
//
//   1. the table's id set equals `COMMAND_TYPES` (an id added, removed or renamed in code only, or a
//      row for a command that no longer exists);
//   2. a row's guard agrees with `COMMAND_AUTHORITY`: `M` (alone, or `M + C(...)`) for a gated
//      command, `R` for a read-only one;
//   3. no row names a host-to-webview message type, which is not an inbound command;
//   4. no row is duplicated, and every row has the table's four cells;
//   5. the registered-only table's id set equals the disposition ids minus `contributes.commands`.
//
// VACUITY. A parse that finds nothing would pass every check above. The real page must yield at
// least 65 inbound rows and at least one registered-only row, and each of five fixture mutations of an
// in-memory copy (a dropped row, an added row, a flipped authority, a host-to-webview row, a dropped
// registered-only row) must fail the same checks. Nothing is written to the page.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_AUTHORITY,
  MUTATING_COMMAND_TYPES,
  READ_ONLY_COMMAND_TYPES
} from '../../src/contracts/sidebar-command-metadata';
import { COMMAND_TYPES, HOST_MESSAGE_TYPES } from '../../src/contracts/sidebar-ipc';
import {
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_ID_LIST
} from '../../src/contracts/entry-point-dispositions';

const REPO = resolve(__dirname, '..', '..');
const REFERENCE = readFileSync(resolve(REPO, 'docs/reference/api-and-cli.md'), 'utf8');
const INBOUND_HEADING = '## Webview command boundary';
const REGISTERED_ONLY_HEADING = '## Registered-only VS Code commands';
/** `| Inbound command | Payload | Guard | Source |` is four cells, so a row splits into six pieces. */
const INBOUND_CELLS = 4;
// `M` alone, or `M + C(...)` followed by the catalog gate's own prose.
const GATED_GUARD = /^M(?: \+ C\(|$)/;
const READ_ONLY_GUARD = 'R';

interface InboundRow {
  readonly id: string;
  readonly guard: string;
  readonly cells: number;
}

/** The text of one `## ` section: from its heading to the next heading of the same level. */
function sectionOf(page: string, heading: string): string {
  const start = page.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const next = page.indexOf('\n## ', start + heading.length);
  return page.slice(start, next < 0 ? undefined : next);
}

function inboundRows(page: string): readonly InboundRow[] {
  return sectionOf(page, INBOUND_HEADING)
    .split('\n')
    .filter((line) => /^\| `CMD_[A-Z0-9_]+`/.test(line))
    .map((line) => {
      const pieces = line.split('|');
      return {
        id: (pieces[1] ?? '').trim().replace(/`/g, ''),
        guard: (pieces[3] ?? '').trim(),
        cells: pieces.length - 2
      };
    });
}

function registeredOnlyIds(page: string): readonly string[] {
  return sectionOf(page, REGISTERED_ONLY_HEADING)
    .split('\n')
    .map((line) => /^\| `(schegent\.[A-Za-z]+)`/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

function manifestCommandIds(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as {
    contributes?: { commands?: ReadonlyArray<{ command: string }> };
  };
  return new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
}

function expectedRegisteredOnly(): readonly string[] {
  const contributed = manifestCommandIds();
  return [...MUTATING_COMMAND_ID_LIST, ...READ_ONLY_COMMAND_ID_LIST]
    .filter((id) => !contributed.has(id))
    .sort();
}

/** Every way the inbound table can disagree with the code, as sentences. Empty when it agrees. */
function inboundViolations(page: string): readonly string[] {
  const rows = inboundRows(page);
  const violations: string[] = [];
  const ids = rows.map((row) => row.id);
  const declared = new Set<string>(COMMAND_TYPES);
  const hostMessages = new Set<string>(HOST_MESSAGE_TYPES);

  for (const id of declared) {
    if (!ids.includes(id)) violations.push(`${id} is a webview command with no row`);
  }
  for (const id of ids) {
    if (hostMessages.has(id)) violations.push(`${id} is a host-to-webview message, not an inbound command`);
    else if (!declared.has(id)) violations.push(`${id} has a row but is not in COMMAND_TYPES`);
  }
  for (const id of new Set(ids)) {
    if (ids.filter((other) => other === id).length > 1) violations.push(`${id} has more than one row`);
  }
  for (const row of rows) {
    if (row.cells !== INBOUND_CELLS) violations.push(`${row.id} has ${row.cells} cells, not ${INBOUND_CELLS}`);
    if (!declared.has(row.id)) continue;
    const authority = COMMAND_AUTHORITY[row.id as keyof typeof COMMAND_AUTHORITY].authority;
    const agrees = authority === 'gated' ? GATED_GUARD.test(row.guard) : row.guard === READ_ONLY_GUARD;
    if (!agrees) violations.push(`${row.id} is ${authority} but its guard cell reads "${row.guard}"`);
  }
  return violations;
}

function registeredOnlyViolations(page: string): readonly string[] {
  const documented = registeredOnlyIds(page);
  const expected = expectedRegisteredOnly();
  return [
    ...expected.filter((id) => !documented.includes(id)).map((id) => `${id} is registered-only with no row`),
    ...documented.filter((id) => !expected.includes(id)).map((id) => `${id} has a row but is not registered-only`)
  ];
}

describe('the webview command reference matches the code (T19; SC-007)', () => {
  it('parses the real page: at least 65 inbound rows and a registered-only list (vacuity guard)', () => {
    expect(COMMAND_TYPES).toHaveLength(65);
    expect(inboundRows(REFERENCE).length).toBeGreaterThanOrEqual(65);
    expect(registeredOnlyIds(REFERENCE).length).toBeGreaterThan(0);
  });

  it('derives its two sets from the declaration, so the checks are not comparing a list with itself', () => {
    expect(MUTATING_COMMAND_TYPES.length + READ_ONLY_COMMAND_TYPES.length).toBe(COMMAND_TYPES.length);
    expect(expectedRegisteredOnly().length).toBeGreaterThan(0);
  });

  it('lists every webview command once, with the guard its authority gives it', () => {
    expect(inboundViolations(REFERENCE)).toEqual([]);
  });

  it('lists exactly the registered-only commands: the dispositions minus the manifest', () => {
    expect(registeredOnlyViolations(REFERENCE)).toEqual([]);
  });
});

describe('five mutations of a copy of the page each fail a check (T19 controls)', () => {
  /** Replaces the first line starting with `prefix`, or throws: a mutation that did not apply proves nothing. */
  function mutate(prefix: string, transform: (line: string) => string | null): string {
    const lines = REFERENCE.split('\n');
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at < 0) throw new Error(`mutation anchor not found: ${prefix}`);
    const replacement = transform(lines[at]!);
    if (replacement === null) lines.splice(at, 1);
    else lines[at] = replacement;
    return lines.join('\n');
  }

  it('drops an inbound row', () => {
    const mutated = mutate('| `CMD_START` |', () => null);

    expect(inboundViolations(mutated)).toContain('CMD_START is a webview command with no row');
  });

  it('adds a row for a command that does not exist', () => {
    const mutated = mutate('| `CMD_START` |', (line) => `${line}\n| \`CMD_NOT_A_COMMAND\` | none | M | src |`);

    expect(inboundViolations(mutated)).toContain('CMD_NOT_A_COMMAND has a row but is not in COMMAND_TYPES');
  });

  it('flips an authority: a gated command guarded as read-only', () => {
    const mutated = mutate('| `CMD_START` |', (line) => line.replace(/\| M \|/, '| R |'));

    expect(inboundViolations(mutated).join('\n')).toContain('CMD_START is gated but its guard cell reads "R"');
  });

  it('adds a host-to-webview message as if it were a command', () => {
    const mutated = mutate('| `CMD_START` |', (line) => `${line}\n| \`CMD_ACK\` | none | R | src |`);

    expect(inboundViolations(mutated)).toContain(
      'CMD_ACK is a host-to-webview message, not an inbound command'
    );
  });

  it('drops a registered-only row', () => {
    const victim = expectedRegisteredOnly()[0]!;
    const mutated = mutate(`| \`${victim}\``, () => null);

    expect(registeredOnlyViolations(mutated)).toContain(`${victim} is registered-only with no row`);
  });
});
