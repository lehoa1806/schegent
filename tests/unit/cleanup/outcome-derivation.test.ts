// Feature 091 T012 — outcome derivation and terminality (data model,
// plan D-03).
//
// The rule that matters most is that `absent` is a SUCCESS, not a
// failure. A machine that never enabled Wake-up reports `absent` from
// every scheduler, and FR-014 requires that machine to see nothing at
// all. If `absent` degraded the outcome, every operator who never used
// the capability would get a warning about its removal.

import { describe, it, expect } from 'vitest';
import { deriveOutcome } from '../../../src/cleanup/wakeup-cleanup';
import { isTerminalOutcome, type CleanupOutcome } from '../../../src/cleanup/cleanup-record';
import type { SchedulerAttempt } from '../../../src/cleanup/schedulers/types';

const removed = (scheduler: SchedulerAttempt['scheduler']): SchedulerAttempt => ({
  scheduler,
  result: 'removed'
});
const absent = (scheduler: SchedulerAttempt['scheduler']): SchedulerAttempt => ({
  scheduler,
  result: 'absent'
});
const failed = (scheduler: SchedulerAttempt['scheduler']): SchedulerAttempt => ({
  scheduler,
  result: 'failed',
  reason: 'permission denied'
});

describe('cleanup outcome derivation', () => {
  describe('any failure yields failed', () => {
    it('a single failed attempt', () => {
      expect(deriveOutcome([failed('cron')], [])).toBe('failed');
    });

    it('a failure alongside a removal — the failure wins', () => {
      expect(deriveOutcome([removed('systemd-user'), failed('cron')], ['runner.js'])).toBe('failed');
    });

    it('a failure alongside an absence', () => {
      expect(deriveOutcome([absent('systemd-user'), failed('cron')], [])).toBe('failed');
    });

    it('an artefact deletion failure, even with every scheduler clean', () => {
      // The scheduled entry is gone but a file that made it invocable
      // is still on disk against FR-015, so the run must retry.
      expect(deriveOutcome([removed('launchd')], [], 1)).toBe('failed');
      expect(deriveOutcome([absent('launchd')], [], 1)).toBe('failed');
    });
  });

  describe('at least one removal with no failure yields succeeded', () => {
    it('one scheduler removed', () => {
      expect(deriveOutcome([removed('launchd')], [])).toBe('succeeded');
    });

    it('one removed and one absent — the Linux dual-scheduler shape', () => {
      expect(deriveOutcome([absent('systemd-user'), removed('cron')], [])).toBe('succeeded');
    });

    it('no scheduler entry but an artefact was deleted', () => {
      // Nothing was registered, yet the data directory still held an
      // invocable runner. Something was cleaned, so this is not the
      // silent never-enabled path.
      expect(deriveOutcome([absent('launchd')], ['runner.js'])).toBe('succeeded');
    });
  });

  describe('nothing found yields skipped', () => {
    it('every attempt absent and no artefact deleted', () => {
      expect(deriveOutcome([absent('systemd-user'), absent('cron')], [])).toBe('skipped');
    });

    it('no attempts at all — the unsupported-platform shape', () => {
      expect(deriveOutcome([], [])).toBe('skipped');
    });
  });

  describe('terminality', () => {
    const cases: ReadonlyArray<readonly [CleanupOutcome, boolean]> = [
      ['succeeded', true],
      ['skipped', true],
      ['failed', false]
    ];

    for (const [outcome, terminal] of cases) {
      it(`${outcome} is ${terminal ? '' : 'not '}terminal`, () => {
        expect(isTerminalOutcome(outcome)).toBe(terminal);
      });
    }

    it('failed is deliberately not terminal so the orphan entry gets another attempt', () => {
      // FR-010 makes the *successful* outcome terminal. Marking a
      // failure terminal too would strand a live entry with no
      // in-product path to removing it.
      expect(isTerminalOutcome(deriveOutcome([failed('cron')], []))).toBe(false);
    });
  });
});
