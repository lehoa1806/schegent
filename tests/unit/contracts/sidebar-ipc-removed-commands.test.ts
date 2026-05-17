import { describe, expect, it } from 'vitest';
import * as Ipc from '../../../src/contracts/sidebar-ipc';
import { MUTATING_COMMANDS } from '../../../src/ui/sidebar/message-router';

// Feature 030 — single-queue mode dropped the multi-queue mutation surface.
// The IPC contract module MUST NOT export the seven legacy command literals
// or carry them in `MUTATING_COMMANDS`. This guard fails if a future
// contributor reintroduces them (whether by accident or as a manual
// re-export) so the contract surface stays in sync with the spec.

const REMOVED_COMMAND_NAMES = [
  'CMD_CREATE_QUEUE',
  'CMD_RENAME_QUEUE',
  'CMD_DELETE_QUEUE',
  'CMD_SET_QUEUE_SCHEDULE',
  'CMD_CLEAR_QUEUE_SCHEDULE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_MOVE_TASK'
] as const;

// The LEGACY_LITERALS array mirrors the wire values the constants once
// resolved to. Even if a future contributor swaps the export name they
// MUST NOT reintroduce the legacy wire literal — host/webview parity is
// guaranteed by the wire string, not the export symbol.
const LEGACY_LITERALS = [
  'CMD_CREATE_QUEUE',
  'CMD_RENAME_QUEUE',
  'CMD_DELETE_QUEUE',
  'CMD_SET_QUEUE_SCHEDULE',
  'CMD_CLEAR_QUEUE_SCHEDULE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_MOVE_TASK'
] as const;

describe('sidebar-ipc — removed commands (Feature 030)', () => {
  it('does not export the seven removed command constants', () => {
    for (const name of REMOVED_COMMAND_NAMES) {
      expect(
        Object.prototype.hasOwnProperty.call(Ipc, name),
        `sidebar-ipc.ts must not export ${name} in single-queue mode`
      ).toBe(false);
    }
  });

  it('does not list the legacy wire literals in COMMAND_TYPES', () => {
    const commandTypes = Ipc.COMMAND_TYPES as readonly string[];
    for (const literal of LEGACY_LITERALS) {
      expect(
        commandTypes.includes(literal),
        `COMMAND_TYPES must not include ${literal} in single-queue mode`
      ).toBe(false);
    }
  });

  it('does not list the legacy wire literals as COMMAND_GUARDS keys', () => {
    const guardKeys = Object.keys(Ipc.COMMAND_GUARDS);
    for (const literal of LEGACY_LITERALS) {
      expect(
        guardKeys.includes(literal),
        `COMMAND_GUARDS must not key on ${literal} in single-queue mode`
      ).toBe(false);
    }
  });

  it('does not list the legacy wire literals in MUTATING_COMMANDS', () => {
    for (const literal of LEGACY_LITERALS) {
      expect(
        MUTATING_COMMANDS.has(literal),
        `MUTATING_COMMANDS must not include ${literal} in single-queue mode`
      ).toBe(false);
    }
  });
});
