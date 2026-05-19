import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  type CommandType
} from '../../../src/contracts/sidebar-ipc';
import {
  MUTATING_COMMAND_REASONS,
  MUTATING_COMMAND_TYPES
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
    const emptyReasons = Object.entries(MUTATING_COMMAND_REASONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([command]) => command);
    expect(emptyReasons).toEqual([]);
  });
});
