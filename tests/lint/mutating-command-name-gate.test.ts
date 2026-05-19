// Defense-in-depth lint for the MUTATING_COMMANDS primary-host gate.
//
// Every command literal exported from `src/contracts/sidebar-ipc.ts`
// whose NAME matches a mutating verb pattern MUST either:
//   (a) appear in MUTATING_COMMANDS, OR
//   (b) appear in INTENTIONAL_READ_ONLY_ALLOWLIST below with an
//       inline justification.
//
// This catches the silent-multi-window-write bug class where a
// future contributor adds a CMD_SAVE_* / CMD_SET_* / CMD_CLEAR_* /
// CMD_RETRY_* / CMD_RESET_* command but forgets to register it in
// MUTATING_COMMANDS. The repository convention treats those verb
// prefixes as the visible signal of write intent.

import { describe, it, expect } from 'vitest';
import * as Ipc from '../../src/contracts/sidebar-ipc';
import { MUTATING_COMMANDS } from '../../src/ui/sidebar/message-router';

// Verb prefixes that strongly imply state mutation. A new command
// matching one of these MUST be gated unless explicitly allowlisted.
const MUTATING_VERB_PATTERNS: ReadonlyArray<RegExp> = [
  /^CMD_SAVE_/,
  /^CMD_SET_(?!.*BREAKPOINT$)/,   // SET_*: mutating except BREAKPOINT handled below as exact-match
  /^CMD_CLEAR_(?!.*BREAKPOINT$)/, // CLEAR_*: mutating except BREAKPOINT handled below as exact-match
  /^CMD_RETRY_/,
  /^CMD_RESET$/,
  /^CMD_PAUSE_/,
  /^CMD_RESUME_/,
  /^CMD_REMOVE_/,
  /^CMD_MODIFY_/,
  /^CMD_REORDER_/,
  /^CMD_MOVE_/,
  /^CMD_RESTART_/,
  /^CMD_SKIP_/,
  /^CMD_DISABLE_/,
  /^CMD_ENABLE_/,
  /^CMD_RERUN_/,
  /^CMD_WAKE_UP_NOW$/
];

// Explicitly read-only commands whose names happen to start with
// what looks like a mutating verb. Each entry MUST carry a one-line
// justification.
const INTENTIONAL_READ_ONLY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // None at the moment. Verb-matching commands today are all mutating.
]);

function commandConstants(): string[] {
  return Object.entries(Ipc)
    .filter(([name, value]) => name.startsWith('CMD_') && typeof value === 'string')
    .map(([name]) => name)
    .sort();
}

describe('MUTATING_COMMANDS naming-convention gate', () => {
  it('every CMD_* with a mutating verb name is gated (or explicitly allowlisted)', () => {
    const allCmds = commandConstants();

    const violations: { cmd: string; reason: string }[] = [];
    for (const cmd of allCmds) {
      const looksMutating = MUTATING_VERB_PATTERNS.some((re) => re.test(cmd));
      if (!looksMutating) continue;
      if (MUTATING_COMMANDS.has(cmd)) continue;
      if (INTENTIONAL_READ_ONLY_ALLOWLIST.has(cmd)) continue;
      violations.push({
        cmd,
        reason:
          'name matches a mutating verb pattern but is not in MUTATING_COMMANDS ' +
          '(in src/ui/sidebar/message-router.ts) and is not allowlisted in ' +
          'tests/lint/mutating-command-name-gate.test.ts'
      });
    }

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('every CMD_SET_PHASE_BREAKPOINT / CMD_CLEAR_PHASE_BREAKPOINT IS gated', () => {
    // Explicit positive assertion — these were exempted from the
    // verb regex via negative lookahead so we re-check by name.
    expect(MUTATING_COMMANDS.has('CMD_SET_PHASE_BREAKPOINT')).toBe(true);
    expect(MUTATING_COMMANDS.has('CMD_CLEAR_PHASE_BREAKPOINT')).toBe(true);
  });

  it('every gated command is a known CMD_ export', () => {
    const declared = new Set(commandConstants());
    const stragglers: string[] = [];
    for (const cmd of MUTATING_COMMANDS) {
      if (!declared.has(cmd)) stragglers.push(cmd);
    }
    expect(stragglers, 'gated commands not declared in sidebar-ipc.ts').toEqual([]);
  });
});
