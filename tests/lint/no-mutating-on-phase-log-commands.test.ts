// Feature 020 T009 — grep regression: the three new phase-log IPC
// commands MUST NOT appear inside the `MUTATING_COMMANDS` set in
// `src/ui/sidebar/message-router.ts`. Adding any of them there would
// break the multi-window primary-host invariant — a secondary VS Code
// host opening the dashboard would no longer be able to read phase
// logs.
//
// This complements the unit-test assertion in
// `tests/unit/ui/sidebar/message-router-phase-log.test.ts`; the lint
// regression provides a fast, dependency-free guard.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROUTER_FILE = resolve(REPO_ROOT, 'src', 'ui', 'sidebar', 'message-router.ts');

const PHASE_LOG_COMMAND_NAMES = [
  'CMD_READ_PHASE_LOG',
  'CMD_START_PHASE_LOG_TAIL',
  'CMD_STOP_PHASE_LOG_TAIL'
] as const;

function extractMutatingCommandsBlock(source: string): string {
  const open = source.indexOf('MUTATING_COMMANDS: ReadonlySet<string> = new Set([');
  if (open === -1) {
    throw new Error('MUTATING_COMMANDS literal not found in message-router.ts');
  }
  const closingBracket = source.indexOf(']);', open);
  if (closingBracket === -1) {
    throw new Error('MUTATING_COMMANDS closing bracket not found');
  }
  return source.slice(open, closingBracket + 3);
}

describe('Feature 020 T009 — phase-log commands stay out of MUTATING_COMMANDS', () => {
  const source = readFileSync(ROUTER_FILE, 'utf8');
  const block = extractMutatingCommandsBlock(source);

  for (const name of PHASE_LOG_COMMAND_NAMES) {
    it(`${name} is not in the MUTATING_COMMANDS set literal`, () => {
      expect(block).not.toContain(name);
    });
  }
});
