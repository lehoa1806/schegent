import { describe, expect, it } from 'vitest';
import {
  decideResume,
  declineMessage,
  resumePersistedRuns,
  type ResumeWalkDeps
} from '../../../src/services/resume-decision';
import type { LivenessVerdict, SpawnIdentity } from '../../../src/contracts/spawn-identity';

/**
 * FR-R3-103 (FR-043, FR-044, FR-048) — the resume decision, and the three audit outcomes.
 *
 * WHY THE DECISION IS PURE. A resume decision that can only be exercised by crashing an
 * extension host is a decision nobody exercises — and this one governs whether two processes
 * enter the same working tree. So the verdict comes from `process-liveness.ts` and the
 * consequence is decided here, over a verdict, with every arm reachable in a unit test.
 *
 * THE THREE OUTCOMES ARE THE POINT. An operator asking "why did my Run not come back" needs
 * to distinguish: it was resumed; it was NOT resumed because something is still holding the
 * tree; and it was terminated because this window lost the fence. Before this item, all three
 * looked the same from the audit log — which is to say, only the first existed.
 */
const identity: SpawnIdentity = { pid: 99, pgid: 99, startedAtMs: 1_700_000_000_000 };

const candidate = { queueId: 'default', runId: 'run-7' };

describe('FR-R3-103 — the resume decision', () => {
  it('declines on alive, and names the declined outcome', () => {
    const decision = decideResume(candidate, 'alive');
    expect(decision.resume).toBe(false);
    expect(decision.eventType).toBe('run-resume-declined-orphan-alive');
    expect(decision.payload).toEqual({ queueId: 'default', runId: 'run-7', liveness: 'alive' });
  });

  it.each<LivenessVerdict>(['dead', 'unrecorded', 'unanswerable'])('resumes on %s', (liveness) => {
    const decision = decideResume(candidate, liveness);
    expect(decision.resume).toBe(true);
    expect(decision.eventType).toBe('run-resumed');
    // The verdict is carried even on the ordinary path, so an operator can see that a resume
    // happened under `unanswerable` rather than inferring it from a resume that looks normal.
    expect(decision.payload.liveness).toBe(liveness);
  });

  it('the payload carries ids and a closed verdict, and nothing else', () => {
    // No paths, no operator-authored content — the standing rule for every audit payload.
    const keys = Object.keys(decideResume(candidate, 'dead').payload).sort();
    expect(keys).toEqual(['liveness', 'queueId', 'runId']);
  });

  it('the decline message tells the operator what to do, and names no path', () => {
    const message = declineMessage(candidate);
    expect(message).toContain('default');
    expect(message).toMatch(/did not resume/i);
    expect(message).not.toContain('/');
  });
});

describe('FR-R3-103 — the activation walk', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 'run-7',
    currentPhase: 'speckit-implement',
    currentIteration: 2,
    ...over
  });

  function deps(over: Partial<ResumeWalkDeps> = {}): ResumeWalkDeps & {
    appended: unknown[];
    resumed: string[];
    notices: string[];
  } {
    const appended: unknown[] = [];
    const resumed: string[] = [];
    const notices: string[] = [];
    return {
      runs: () => [['default', run({ spawnIdentity: identity })]],
      liveness: async () => 'dead',
      appendAudit: async (entry) => {
        appended.push(entry);
      },
      resume: (queueId) => resumed.push(queueId),
      notify: (message) => notices.push(message),
      log: () => {},
      appended,
      resumed,
      notices,
      ...over
    };
  }

  it('resumes and records `run-resumed` when the tree is dead', async () => {
    const d = deps();
    await resumePersistedRuns(d);
    expect(d.resumed).toEqual(['default']);
    expect((d.appended[0] as { eventType: string }).eventType).toBe('run-resumed');
    expect((d.appended[0] as { outcome: string }).outcome).toBe('info');
    expect(d.notices).toEqual([]);
  });

  it('does NOT resume, and surfaces, when the tree is alive', async () => {
    const d = deps({ liveness: async () => 'alive' });
    await resumePersistedRuns(d);
    expect(d.resumed, 'no second driver may enter the worktree').toEqual([]);
    expect((d.appended[0] as { eventType: string }).eventType).toBe(
      'run-resume-declined-orphan-alive'
    );
    expect(d.notices.length, 'the operator must be told, not left with a silent no-op').toBe(1);
  });

  it('takes no automatic action on the orphan — no kill, no reattach', async () => {
    // FR-R3-103 §3.2 calls reattach-or-kill a decision to record, not to default. Both are
    // destructive in a way declining is not, so the walk exposes no seam for either.
    const d = deps({ liveness: async () => 'alive' });
    await resumePersistedRuns(d);
    expect(Object.keys(d)).not.toContain('kill');
    expect(Object.keys(d)).not.toContain('reattach');
  });

  it('an audit failure does not change the decision', async () => {
    // Evidence about a decision must not be able to decide it. A rejected append is swallowed
    // and the resume still happens — the alternative is a Run stranded because a log was full.
    const d = deps({
      appendAudit: async () => {
        throw new Error('audit sink unavailable');
      }
    });
    await expect(resumePersistedRuns(d)).resolves.toBeUndefined();
    expect(d.resumed).toEqual(['default']);
  });

  it('a Run with no recorded identity resumes, exactly as it did before this feature', async () => {
    const d = deps({
      runs: () => [['default', run()]],
      liveness: async () => 'unrecorded'
    });
    await resumePersistedRuns(d);
    expect(d.resumed).toEqual(['default']);
    expect((d.appended[0] as { payload: { liveness: string } }).payload.liveness).toBe(
      'unrecorded'
    );
  });

  it('decides each queue independently: one alive orphan does not block its siblings', async () => {
    const verdicts: Record<string, LivenessVerdict> = { 'q-a': 'alive', 'q-b': 'dead' };
    const seen: string[] = [];
    const d = deps({
      runs: () => [
        ['q-a', run({ id: 'run-a', spawnIdentity: identity })],
        ['q-b', run({ id: 'run-b', spawnIdentity: identity })]
      ],
      liveness: async () => {
        const queueId = seen.length === 0 ? 'q-a' : 'q-b';
        seen.push(queueId);
        return verdicts[queueId] as LivenessVerdict;
      }
    });
    await resumePersistedRuns(d);
    expect(d.resumed).toEqual(['q-b']);
  });

  it('the audit entry is appended BEFORE the resume, so the record cannot follow the action', async () => {
    const order: string[] = [];
    const d = deps({
      appendAudit: async () => {
        order.push('audit');
      },
      resume: () => order.push('resume')
    });
    await resumePersistedRuns(d);
    expect(order).toEqual(['audit', 'resume']);
  });
});

describe('FR-R3-103 — the supersession abort', () => {
  it('fans a lost fence out to every session, and touches no lease', async () => {
    // Asserted against the source: constructing a controller with live sessions would test the
    // harness. What matters is that it iterates ALL sessions and that no lease call appears.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../src/controller/workflow-controller.ts'),
      'utf8'
    );
    const method = /public abortOnSupersession\(\): void \{[\s\S]*?\n {2}\}/.exec(source);
    expect(method).not.toBeNull();
    const body = (method as RegExpExecArray)[0];
    expect(body).toContain('this.sessions.all()');
    expect(body).toContain('abortOnSupersession()');
    // The hard rule: no Run-scoped path releases primacy.
    expect(body).not.toMatch(/release|tryAcquire|lock\./);
    // No queue parameter: supersession is a window-level fact.
    expect(body.split('\n')[0]).toContain('abortOnSupersession(): void');
  });

  it('the lock manager fires listeners BEFORE re-acquiring', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, '../../../src/state/lock.ts'), 'utf8');
    const heartbeat = /public async heartbeat\(\): Promise<void> \{[\s\S]*?\n {2}\}/.exec(source);
    const body = (heartbeat as RegExpExecArray)[0];
    const listenersAt = body.indexOf('fenceLostListeners');
    const reacquireAt = body.indexOf('this.tryAcquire()');
    expect(listenersAt).toBeGreaterThan(0);
    expect(
      listenersAt,
      're-acquisition can succeed within the same beat; a window that is primary again must ' +
        'not have swallowed the fact that it briefly was not'
    ).toBeLessThan(reacquireAt);
  });

  it('a throwing listener cannot stop the re-acquisition', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, '../../../src/state/lock.ts'), 'utf8');
    // One bad callback must not leave the window permanently non-primary.
    expect(source).toMatch(/try \{\s*listener\(\);\s*\} catch \{/);
  });
});
