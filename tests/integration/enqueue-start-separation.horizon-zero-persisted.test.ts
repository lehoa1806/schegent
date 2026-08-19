// Feature 065 (T024b) — Integration test for SC-008's "0% persisted"
// invariant. Covers BOTH surfaces:
//
//   (1) Chooser surface — UI-level inline validation is covered by T022
//       step 8; here we additionally assert that any host-side enqueue
//       triggered after a `168:01` rejection leaves
//       `QueueState.scheduledStartAt === null`.
//   (2) Programmatic surface — `GuardedRunService.scheduleOrEnqueue` with
//       `scheduledStartAt > now + 7d` throws `ScheduledStartHorizonError`,
//       persisted `scheduledStartAt` remains null, the queue does NOT
//       land in `idle-pending`, and a warn-level
//       `scheduled-start-horizon-rejected` audit event is emitted.
//
// Per FR-009c / SC-008. The "N ≥ 5 over-horizon attempts" requirement
// is exercised in a loop so a regression that intermittently writes
// persisted state under load is still caught.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ScheduledStartHorizonError } from '../../src/services/guarded-run-service';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T024b) — SC-008 "0% persisted" invariant', () => {
  it('programmatic over-horizon throws ScheduledStartHorizonError; no idle-pending; no persisted scheduledStartAt', async () => {
    const horizonMs = SEVEN_DAYS_MS;
    let attempt = 0;
    let caughtCount = 0;

    while (attempt < 5) {
      const requested = h.clock.now() + horizonMs + 60_000 + attempt * 1000;
      try {
        await h.service.scheduleOrEnqueue({
          description: `over-horizon-${attempt}`,
          scheduledAt: h.clock.now(),
          via: 'webview',
          startIntent: {
            startMode: 'scheduled',
            scheduledStartAt: requested,
            source: 'programmatic-scheduled'
          },
          callerKind: 'automation',
          callerId: `automation-test-${attempt}`
        });
        // If we reach here, the contract is violated.
        throw new Error(`expected ScheduledStartHorizonError on attempt ${attempt}`);
      } catch (err) {
        if (err instanceof ScheduledStartHorizonError) {
          caughtCount++;
          expect(err.requestedScheduledStartAt).toBe(requested);
          expect(err.callerId).toBe(`automation-test-${attempt}`);
        } else {
          throw err;
        }
      }

      // Persisted state MUST remain null on this attempt.
      const persisted = h.store.getQueue('default');
      expect(persisted.scheduledStartAt).toBeNull();
      expect(persisted.queueLifecycle).not.toBe('idle-pending');

      attempt++;
    }
    expect(caughtCount).toBe(5);

    // One warn-level `scheduled-start-horizon-rejected` per attempt.
    const rejections = h.audit.byType('scheduled-start-horizon-rejected');
    expect(rejections.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(rejections[i].payload).toMatchObject({
        transitionReason: 'horizon-exceeded',
        scheduledStartSource: 'programmatic-scheduled'
      });
    }
  });

  it('chooser surface inline rejection: persisted scheduledStartAt stays null across N attempts', async () => {
    // The chooser is a UI concern (T022 covers component-level inline
    // validation), but the host MUST also be defensive: if the chooser
    // erroneously committed an over-horizon `startIntent`, the same
    // host path throws and persists nothing. We replicate the chooser
    // flow by passing the over-horizon intent with `source: 'operator-chooser'`.
    const horizonMs = SEVEN_DAYS_MS;
    for (let i = 0; i < 5; i++) {
      const requested = h.clock.now() + horizonMs + 1_000 + i;
      let threw = false;
      try {
        await h.service.scheduleOrEnqueue({
          description: `chooser-over-horizon-${i}`,
          scheduledAt: h.clock.now(),
          via: 'webview',
          startIntent: {
            startMode: 'scheduled',
            scheduledStartAt: requested,
            source: 'operator-chooser'
          },
          callerKind: 'human'
        });
      } catch (err) {
        threw = err instanceof ScheduledStartHorizonError;
      }
      expect(threw).toBe(true);
      const persisted = h.store.getQueue('default');
      expect(persisted.scheduledStartAt).toBeNull();
      expect(persisted.queueLifecycle).not.toBe('idle-pending');
    }
  });

  it('boundary: exactly now + 7d is accepted (NOT rejected)', async () => {
    const exactBoundary = h.clock.now() + SEVEN_DAYS_MS;
    const result = await h.service.scheduleOrEnqueue({
      description: 'boundary task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: exactBoundary,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('idle-pending');
    expect(h.store.getQueue('default').scheduledStartAt).toBe(exactBoundary);
  });
});
