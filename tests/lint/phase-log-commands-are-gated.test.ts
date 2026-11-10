// FR-R4-F05 (FR-003, US2; contract T, T6) — the phase-log IPC commands are
// GATED: members of `MUTATING_COMMANDS`, declared `gatedConcurrent` in
// `COMMAND_AUTHORITY`.
//
// SUPERSEDES Feature 020 T009. This file was `no-mutating-on-phase-log-commands.test.ts`,
// and said the opposite: "the three new phase-log IPC commands MUST NOT appear inside
// the `MUTATING_COMMANDS` set in `src/ui/sidebar/message-router.ts`. Adding any of them
// there would break the multi-window primary-host invariant — a secondary VS Code host
// opening the dashboard would no longer be able to read phase logs."
//
// WHY THAT REASON NO LONGER HOLDS. Each of the three appends an audit row: a
// `phase-log-read` row on every read, a `phase-log-tail-started` row on a tail start,
// a `phase-log-tail-stopped` row on a stop. FR-R4-F05's FR-003 gates every command that
// starts a process, writes persisted state, writes a file or appends an audit row, and
// an audit append is one of the four. So after this feature a secondary window and an
// untrusted workspace can no longer read phase logs. The audit writer already refused
// those rows outside the owner window, so what changes is what an operator can read,
// not what reaches the log. Undoing it needs a change to FR-003 in the spec, plus one
// declaration entry per command and these cases.
//
// They are `concurrent`, not serialized: each is a short read with no state the
// executor's chain protects, and the chain would only queue a tail stop behind a held
// queue mutation. This complements `tests/unit/ui/sidebar/message-router-phase-log.test.ts`.

import { describe, expect, it } from 'vitest';
import { COMMAND_AUTHORITY } from '../../src/contracts/sidebar-command-metadata';
import {
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
} from '../../src/contracts/sidebar-ipc';
import { MUTATING_COMMANDS } from '../../src/ui/sidebar/message-router';

const PHASE_LOG_COMMAND_NAMES = [
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  // FR-R6-F07 — the ack advances delivery on a tail the gated start opened.
  CMD_ACK_PHASE_LOG_TAIL
] as const;

describe('FR-R4-F05 T031 — phase-log commands are gated in MUTATING_COMMANDS', () => {
  for (const name of PHASE_LOG_COMMAND_NAMES) {
    it(`${name} is in the MUTATING_COMMANDS set`, () => {
      expect(MUTATING_COMMANDS.has(name)).toBe(true);
    });

    it(`${name} is declared gated and concurrent, with its reason`, () => {
      const entry = COMMAND_AUTHORITY[name];

      expect(entry).toMatchObject({ authority: 'gated', execution: 'concurrent' });
      // The ack appends no row; it is gated because the start that opened its tail is.
      expect(entry.reason).toContain(name === CMD_ACK_PHASE_LOG_TAIL ? 'gated start' : 'row');
    });
  }
});
