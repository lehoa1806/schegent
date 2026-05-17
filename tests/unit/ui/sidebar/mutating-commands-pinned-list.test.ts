// Feature 012 T050 — MUTATING_COMMANDS pinned-list regression test.
// Feature 056 Track 1 (FR-001..FR-005) — Reclassified the four catalog /
// general-settings save commands as mutating. The prior assertion that
// they were NOT mutating encoded the F-001 documentation-vs-implementation
// drift and is now flipped.
//
// MUTATING_COMMANDS is the only gate preventing a secondary VS Code host
// from mutating workspace settings during a multi-window session
// (CLAUDE.md hard rule). This test pins the current set as a snapshot so
// any accidental drop during a refactor is caught immediately.

import { describe, it, expect } from 'vitest';
import {
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RERUN_FROM_HISTORY,
  CMD_RETRY_ACTIVE_RUN,
  CMD_START,
  CMD_CANCEL,
  CMD_RESUME,
  CMD_RESET,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_PHASES,
  CMD_SAVE_MODELS,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_RETRY_PHASE_NOW
} from '../../../../src/ui/sidebar/messages';
import { isMutatingCommand } from '../../../../src/ui/sidebar/message-router';

const PINNED_MUTATING_COMMANDS: ReadonlyArray<string> = [
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RERUN_FROM_HISTORY,
  CMD_RETRY_ACTIVE_RUN,
  CMD_START,
  CMD_CANCEL,
  CMD_RESUME,
  CMD_RESET,
  CMD_RETRY_PHASE_NOW,
  // Feature 056 Track 1 (FR-001..FR-005). Catalog and general-settings
  // saves write VS Code configuration / workspace state.
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES
];

describe('Feature 012 T050 — MUTATING_COMMANDS pinned-list regression', () => {
  it('contains every command in the pinned pre-refactor list', () => {
    const missing: string[] = [];
    for (const cmd of PINNED_MUTATING_COMMANDS) {
      if (!isMutatingCommand(cmd)) missing.push(cmd);
    }
    expect(missing).toEqual([]);
  });

  it('config save commands ARE mutating (Feature 056 Track 1, FR-001..FR-005)', () => {
    expect(isMutatingCommand(CMD_SAVE_PIPELINES)).toBe(true);
    expect(isMutatingCommand(CMD_SAVE_PHASES)).toBe(true);
    expect(isMutatingCommand(CMD_SAVE_MODELS)).toBe(true);
    expect(isMutatingCommand(CMD_SAVE_GENERAL_SETTINGS)).toBe(true);
  });

  it('still gates CMD_RETRY_PHASE_NOW as a mutating command', () => {
    expect(isMutatingCommand(CMD_RETRY_PHASE_NOW)).toBe(true);
  });

  it('reports a non-listed command as non-mutating', () => {
    expect(isMutatingCommand('CMD_NONEXISTENT_BOGUS')).toBe(false);
  });
});
