// FR-R4-F05 (T2; contract C, C1 to C3; FR-001, FR-003) — the declaration is total
// and honest: every webview command has exactly one entry, every entry says why,
// the two derived sets partition the commands, and a type the table does not hold
// is treated as gated. The router's matching behaviour is
// `tests/integration/command-authority-routing.test.ts`'s.
import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  type CommandType
} from '../../../src/contracts/sidebar-ipc';
import {
  COMMAND_AUTHORITY,
  MUTATING_COMMAND_TYPES,
  READ_ONLY_COMMAND_TYPES,
  commandAuthorityOf
} from '../../../src/contracts/sidebar-command-metadata';
import { MUTATING_COMMANDS } from '../../../src/ui/sidebar/message-router';

describe('sidebar command metadata', () => {
  it('mutating command metadata only references declared command types', () => {
    const declared = new Set<CommandType>(COMMAND_TYPES);
    const unknown = MUTATING_COMMAND_TYPES.filter((type) => !declared.has(type));
    expect(unknown).toEqual([]);
  });

  it('message-router gate is derived from the centralized mutating metadata', () => {
    expect([...MUTATING_COMMANDS].sort()).toEqual([...MUTATING_COMMAND_TYPES].sort());
  });

  it('every mutating command carries a non-empty review reason', () => {
    const emptyReasons = MUTATING_COMMAND_TYPES.filter(
      (command) => COMMAND_AUTHORITY[command].reason.trim().length === 0
    );
    expect(emptyReasons).toEqual([]);
  });

  // The three phrases contract C (C2) fixes for a read-only reason: the reason says
  // what the command does AND why none of FR-003's effects applies.
  const READ_ONLY_PHRASES = [
    'starts no process',
    'writes no persisted state or file',
    'appends no audit row'
  ] as const;

  describe('the declaration (T2)', () => {
    it('holds exactly one entry per command and no other key', () => {
      const declared = new Set<string>(COMMAND_TYPES);
      const keys = Object.keys(COMMAND_AUTHORITY);
      const missing = COMMAND_TYPES.filter((type) => !keys.includes(type));
      const extra = keys.filter((key) => !declared.has(key));

      expect(COMMAND_TYPES.length, 'the 66 commands were parsed').toBe(66);
      expect(missing, `commands with no authority entry: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `keys that are not commands: ${extra.join(', ')}`).toEqual([]);
      expect(keys).toHaveLength(COMMAND_TYPES.length);
    });

    it('gives every entry a non-empty single-line reason', () => {
      const offenders = COMMAND_TYPES.filter((type) => {
        const { reason } = COMMAND_AUTHORITY[type];
        return reason.trim().length === 0 || /[\r\n]/.test(reason);
      });
      expect(offenders).toEqual([]);
    });

    it('has every read-only reason say the command has none of the four effects', () => {
      const offenders = READ_ONLY_COMMAND_TYPES.filter((type) => {
        const reason = COMMAND_AUTHORITY[type].reason.toLowerCase();
        return !READ_ONLY_PHRASES.every((phrase) => reason.includes(phrase));
      });
      expect(
        offenders,
        `read-only reasons that omit one of ${READ_ONLY_PHRASES.join(' / ')}: ${offenders.join(', ')}`
      ).toEqual([]);
    });

    it('splits the commands into the two derived sets with no overlap', () => {
      const gated = new Set<string>(MUTATING_COMMAND_TYPES);
      const readOnly = new Set<string>(READ_ONLY_COMMAND_TYPES);

      expect([...gated].filter((type) => readOnly.has(type))).toEqual([]);
      expect([...gated, ...readOnly].sort()).toEqual([...COMMAND_TYPES].sort());
      for (const type of MUTATING_COMMAND_TYPES) {
        expect(COMMAND_AUTHORITY[type].authority, type).toBe('gated');
      }
      for (const type of READ_ONLY_COMMAND_TYPES) {
        expect(COMMAND_AUTHORITY[type].authority, type).toBe('read-only');
      }
    });

    // FR-R6-F05 added the read-only CMD_READ_STORAGE_DETAILS (10 to 11 read-only, 63 to 64).
    // FR-R6-F06 added the read-only CMD_READ_USAGE_ACCOUNTING (11 to 12 read-only, 64 to 65).
    // FR-R6-F07 added the gated CMD_ACK_PHASE_LOG_TAIL (53 to 54 gated, 65 to 66).
    it('counts 54 gated and 12 read-only commands over 66', () => {
      expect(MUTATING_COMMAND_TYPES).toHaveLength(54);
      expect(READ_ONLY_COMMAND_TYPES).toHaveLength(12);
      expect(MUTATING_COMMAND_TYPES.length + READ_ONLY_COMMAND_TYPES.length).toBe(66);
    });

    it('treats a type outside the union as gated and serialized (fail-closed)', () => {
      expect(commandAuthorityOf('CMD_NOT_A_COMMAND')).toMatchObject({
        authority: 'gated',
        execution: 'serialized'
      });
      expect(commandAuthorityOf('')).toMatchObject({ authority: 'gated' });
      expect(commandAuthorityOf('__proto__')).toMatchObject({ authority: 'gated' });
      expect(commandAuthorityOf('CMD_PING_BACKEND')).toBe(COMMAND_AUTHORITY.CMD_PING_BACKEND);
    });
  });
});
