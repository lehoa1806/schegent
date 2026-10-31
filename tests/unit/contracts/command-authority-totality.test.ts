// FR-R4-F05 (T3; contract C, C1; FR-001, SC-001) — the command-authority
// declaration is TOTAL at compile time, and this file is what notices if it stops
// being.
//
// WHAT IS PROVED WHERE. `COMMAND_AUTHORITY` is written `satisfies Record<CommandType,
// CommandAuthority>`, so `tsc` over `src/` names a missing or extra key at the line.
// `satisfies` does not change the inferred type of the table, though, so a later edit
// back to `Partial<Record<…>>` leaves every file that reads it compiling for as long
// as the literal still happens to hold all the keys, and the first omission after that
// compiles silently. Two things here close that:
//
//   1. Under `npm run typecheck:tests`, the table must be assignable to a TOTAL
//      `Record<CommandType, CommandAuthority>`. That fails to compile the moment an
//      entry is missing, whatever the `satisfies` clause says. Two negatives, each under
//      `@ts-expect-error`, show the check is not vacuous: a table with a key that is not
//      a command, and a literal missing a real one, are both refused. A negative that
//      stopped erroring would be an unused `@ts-expect-error`, which `tsc` reports.
//   2. A runtime case reads the declaration's source and requires the `satisfies Record`
//      clause, so reverting it to `Partial` fails here even while no key is missing.
//
// Vitest does not typecheck. The compile-time half runs in `typecheck:tests`, which the
// gate runs; the runtime cases below exist so the file is not empty to vitest, and to
// carry half 2.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_AUTHORITY,
  type CommandAuthority
} from '../../../src/contracts/sidebar-command-metadata';
import { COMMAND_TYPES, type CommandType } from '../../../src/contracts/sidebar-ipc';

const DECLARATION = resolve(__dirname, '../../../src/contracts/sidebar-command-metadata.ts');

describe('command authority totality (T3)', () => {
  it('is assignable to a total Record over every command type', () => {
    // Compile time: fails to type-check if any `CommandType` has no entry.
    const total: Record<CommandType, CommandAuthority> = COMMAND_AUTHORITY;

    expect(Object.keys(total)).toHaveLength(COMMAND_TYPES.length);
  });

  it('refuses a table that holds a key which is not a command', () => {
    // @ts-expect-error — 'CMD_SYNTHETIC' is not a key of the declaration
    const widened: Record<CommandType | 'CMD_SYNTHETIC', CommandAuthority> = COMMAND_AUTHORITY;

    expect(widened).toBe(COMMAND_AUTHORITY);
  });

  it('refuses a literal that omits one real command', () => {
    const checkTotal = (
      table: Omit<Record<CommandType, CommandAuthority>, 'CMD_START'>
      // @ts-expect-error — 'CMD_START' is missing, so the table is not total
    ): Record<CommandType, CommandAuthority> => table satisfies Record<CommandType, CommandAuthority>;

    expect(typeof checkTotal).toBe('function');
  });

  it('refuses a literal that adds a key which is not a command', () => {
    const withExtra = {
      ...COMMAND_AUTHORITY,
      // @ts-expect-error — 'CMD_SYNTHETIC' is not a command
      CMD_SYNTHETIC: COMMAND_AUTHORITY.CMD_START
    } satisfies Record<CommandType, CommandAuthority>;

    expect(Object.keys(withExtra)).toContain('CMD_SYNTHETIC');
  });

  it('keeps the declaration checked with `satisfies Record<CommandType, CommandAuthority>`', () => {
    const source = readFileSync(DECLARATION, 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    expect(code).toMatch(/\}\s*satisfies\s+Record<CommandType,\s*CommandAuthority>\s*\)/);
    expect(code).not.toMatch(/Partial\s*</);
  });
});
