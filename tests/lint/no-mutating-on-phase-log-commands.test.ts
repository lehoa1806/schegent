// Feature 020 T009 — grep regression: the three new phase-log IPC
// commands MUST NOT appear inside the `MUTATING_COMMANDS` set in
// `src/ui/sidebar/message-router.ts`. Adding any of them there would
// break the multi-window primary-host invariant — a secondary VS Code
// host opening the dashboard would no longer be able to read phase
// logs.
//
// This complements the unit-test assertion in
// `tests/unit/ui/sidebar/message-router-phase-log.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
} from '../../src/contracts/sidebar-ipc';
import { MUTATING_COMMANDS } from '../../src/ui/sidebar/message-router';

const PHASE_LOG_COMMAND_NAMES = [
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
] as const;

describe('Feature 020 T009 — phase-log commands stay out of MUTATING_COMMANDS', () => {
  for (const name of PHASE_LOG_COMMAND_NAMES) {
    it(`${name} is not in the MUTATING_COMMANDS set`, () => {
      expect(MUTATING_COMMANDS.has(name)).toBe(false);
    });
  }
});
