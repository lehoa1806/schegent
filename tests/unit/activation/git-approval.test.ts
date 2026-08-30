import { describe, expect, it, vi } from 'vitest';

import {
  GIT_APPROVAL_APPROVE_LABEL,
  GIT_APPROVAL_PERSIST_LABEL,
  createGitApprovalRequester,
  createPersistentGitApproval
} from '../../../src/activation/git-approval';
import { buildMutationPlan } from '../../../src/services/mutation-plan';
import { UNRECORDED_PIPELINE_ID, type GitPlanGrant } from '../../../src/state/git-plan-grants';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowRunPipeline, MutationPlanSnapshot } from '../../../src/state/workflow-run';

const PLAN: MutationPlanSnapshot = Object.freeze({
  fingerprint: 'fp-abc123',
  gitCapablePhaseIds: Object.freeze(['speckit-implement', 'finalize']),
  capturedAt: 1_700_000_000_000
});

function harness(answer: string | undefined) {
  const confirm = vi.fn().mockResolvedValue(answer);
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { confirm, logger, request: createGitApprovalRequester({ confirm, logger }) };
}

describe('createGitApprovalRequester (SEC-02)', () => {
  it('approves this run only when the operator picks the per-run action', async () => {
    const { request } = harness(GIT_APPROVAL_APPROVE_LABEL);
    await expect(request(PLAN)).resolves.toBe('this-run');
  });

  it('denies when the operator cancels', async () => {
    const { request } = harness('Cancel');
    await expect(request(PLAN)).resolves.toBe('denied');
  });

  it('denies when the dialog is dismissed without a choice', async () => {
    const { request } = harness(undefined);
    await expect(request(PLAN)).resolves.toBe('denied');
  });

  it('awaits the decision before returning', async () => {
    let settle: (value: string | undefined) => void = () => {};
    const confirm = vi.fn(
      () => new Promise<string | undefined>((resolve) => { settle = resolve; })
    );
    const logger = { info: vi.fn(), warn: vi.fn() };
    const request = createGitApprovalRequester({ confirm, logger });

    let resolved = false;
    const pending = request(PLAN).then((value) => { resolved = true; return value; });

    await Promise.resolve();
    expect(resolved).toBe(false);

    settle(GIT_APPROVAL_APPROVE_LABEL);
    await expect(pending).resolves.toBe('this-run');
  });

  it('binds the prompt to the exact mutation fingerprint and phase list', async () => {
    const { request, confirm } = harness(GIT_APPROVAL_APPROVE_LABEL);
    await request(PLAN);

    const [message, detail] = confirm.mock.calls[0] as [string, string, readonly string[]];
    expect(message).toContain('2');
    expect(detail).toContain('fp-abc123');
    expect(detail).toContain('speckit-implement');
    expect(detail).toContain('finalize');
  });

  it('records the decision without claiming a bypass', async () => {
    const granted = harness(GIT_APPROVAL_APPROVE_LABEL);
    await granted.request(PLAN);
    const grantedLog = JSON.stringify(granted.logger.info.mock.calls);
    expect(grantedLog).toContain('fp-abc123');
    expect(grantedLog).toContain('granted');
    expect(JSON.stringify(granted.logger.warn.mock.calls)).not.toContain('bypassed');

    const denied = harness(undefined);
    await denied.request(PLAN);
    expect(JSON.stringify(denied.logger.info.mock.calls)).toContain('denied');
  });

  // FR-R3-146 (FR-002, US3-2) — the same property the containment surface holds:
  // an unanswerable prompt denies, and the warning names the reason, because an
  // operator whose run was refused by a broken dialog has to be able to tell that
  // apart from a refusal they caused.
  it('fails closed when the dialog itself throws, naming the reason', async () => {
    const confirm = vi.fn().mockRejectedValue(new Error('no UI host'));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const request = createGitApprovalRequester({ confirm, logger });

    await expect(request(PLAN)).resolves.toBe('denied');
    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toContain('fp-abc123');
    expect(warned).toContain('no UI host');
  });

  // A host that rejects with something that is not an `Error` must still produce a
  // legible reason rather than "undefined" in front of the operator.
  it.each([
    ['a string rejection', 'the host is shutting down'],
    ['a plain object rejection', { code: 'ENOENT' }]
  ])('denies and stays legible on %s', async (_case, thrown) => {
    const confirm = vi.fn().mockRejectedValue(thrown);
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(createGitApprovalRequester({ confirm, logger })(PLAN)).resolves.toBe('denied');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('reason=undefined');
  });
});

// FR-R3-146 (FR-007) — the durable action. The three tests that matter are: it is
// OFFERED, it is DISTINGUISHED from the per-run approval, and nothing else in the
// dialog's answer space reaches it.
describe('createGitApprovalRequester — the durable grant (FR-R3-146)', () => {
  it('offers two affirmative actions, not one', async () => {
    const { request, confirm } = harness(GIT_APPROVAL_APPROVE_LABEL);
    await request(PLAN);

    const actions = (confirm.mock.calls[0] as [string, string, readonly string[]])[2];
    expect(actions).toEqual([GIT_APPROVAL_APPROVE_LABEL, GIT_APPROVAL_PERSIST_LABEL]);
  });

  it('returns `persist` when the operator picks the durable action', async () => {
    const { request } = harness(GIT_APPROVAL_PERSIST_LABEL);
    await expect(request(PLAN)).resolves.toBe('persist');
  });

  // The two affirmative actions must not collapse into each other. A requester
  // that returned `'persist'` for both would write a durable grant for an operator
  // who asked for this run only, which is the silent widening the spec forbids.
  it('keeps the per-run action per-run', async () => {
    const perRun = harness(GIT_APPROVAL_APPROVE_LABEL);
    const durable = harness(GIT_APPROVAL_PERSIST_LABEL);

    await expect(perRun.request(PLAN)).resolves.toBe('this-run');
    await expect(durable.request(PLAN)).resolves.toBe('persist');
    expect(GIT_APPROVAL_APPROVE_LABEL).not.toBe(GIT_APPROVAL_PERSIST_LABEL);
  });

  // The per-run label is the one Feature 098's tests, docs and screenshots name.
  // Pinned byte-for-byte because adding a second action is not licence to reword
  // the first: an operator who learned "Approve This Run" must still see it.
  it('leaves the per-run label byte-identical', () => {
    expect(GIT_APPROVAL_APPROVE_LABEL).toBe('Approve This Run');
  });

  // FR-007 — the durable action changes what the operator is agreeing to, so the
  // detail has to say so where they read it. Both bounds are asserted: the plan,
  // and this workspace.
  it('states what the durable grant covers in the detail the operator reads', async () => {
    const { request, confirm } = harness(GIT_APPROVAL_PERSIST_LABEL);
    await request(PLAN);

    const detail = (confirm.mock.calls[0] as [string, string, readonly string[]])[1];
    expect(detail).toContain(GIT_APPROVAL_PERSIST_LABEL);
    expect(detail).toContain('this workspace only');
    expect(detail.toLowerCase()).toContain('asks again');
  });

  // Neither affirmative label may be reachable by accident. A host that echoes a
  // label it invented, or returns the message text, must deny.
  it.each([
    ['a label the dialog invented', 'Always Approve'],
    ['the message echoed back', 'Schegent can change Git state in 2 phase(s) of this run.'],
    ['an empty string', ''],
    ['the decision word itself', 'persist']
  ])('denies on %s', async (_case, answer) => {
    const { request } = harness(answer);
    await expect(request(PLAN)).resolves.toBe('denied');
  });

  it('records which scope was granted, so an audit can tell them apart', async () => {
    const durable = harness(GIT_APPROVAL_PERSIST_LABEL);
    await durable.request(PLAN);
    const log = JSON.stringify(durable.logger.info.mock.calls);
    expect(log).toContain('granted');
    expect(log).toContain('persist');
    expect(log).toContain('fp-abc123');

    const perRun = harness(GIT_APPROVAL_APPROVE_LABEL);
    await perRun.request(PLAN);
    expect(JSON.stringify(perRun.logger.info.mock.calls)).toContain('this-run');
  });
});

// FR-R3-146 (FR-006, SC-003) — the defect this half of the feature exists to fix.
// The fingerprint was always the plan's; the storage was the Run's. These tests
// drive the wrapper the wiring composes, with the store standing in as a Map.
function drainHarness(answers: readonly (string | undefined)[]) {
  const stored = new Map<string, GitPlanGrant>();
  const confirm = vi.fn(async () => answers[Math.min(confirm.mock.calls.length - 1, answers.length - 1)]);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const persist = vi.fn(async (plan: MutationPlanSnapshot) => {
    stored.set(plan.fingerprint, {
      fingerprint: plan.fingerprint,
      grantedAt: 1_700_000_000_000,
      phaseIds: plan.gitCapablePhaseIds,
      pipelineId: plan.pipelineId ?? '(unrecorded)'
    });
  });
  const approve = createPersistentGitApproval({
    request: createGitApprovalRequester({ confirm, logger }),
    // A thunk over the live Map, not a copy taken at construction — the
    // per-consultation read the contract requires.
    isGranted: (fingerprint) => stored.has(fingerprint),
    persist,
    logger
  });
  return { approve, confirm, logger, persist, stored };
}

const PIPELINE: WorkflowRunPipeline = Object.freeze({
  id: 'speckit',
  name: 'Spec Kit',
  phases: Object.freeze([
    Object.freeze({ id: 'speckit-specify', name: 'Specify', sideEffects: 'workspace' as const }),
    Object.freeze({ id: 'speckit-implement', name: 'Implement', sideEffects: 'git' as const })
  ])
});

describe('createPersistentGitApproval — the grant outlives the Run (FR-R3-146)', () => {
  it('asks once for a drain of five tasks on one unchanged plan', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);

    // Five tasks, five Runs, one pipeline. Every task rebuilds the plan from the
    // same pipeline, which is exactly what made the old code show five modals.
    const decisions: boolean[] = [];
    for (let task = 0; task < 5; task += 1) {
      decisions.push(await h.approve(buildMutationPlan(PIPELINE, 1_700_000_000_000 + task)));
    }

    expect(decisions).toEqual([true, true, true, true, true]);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledTimes(1);
    // The four skips are visible in the log, distinguishable from the one that asked.
    const stored = h.logger.info.mock.calls.filter((call) => String(call[0]).includes('scope=stored'));
    expect(stored).toHaveLength(4);
  });

  it('takes the skip path without constructing a modal at all', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);
    const plan = buildMutationPlan(PIPELINE);

    await h.approve(plan);
    h.confirm.mockClear();

    // Not "the modal was shown and auto-answered" — the dialog seam is never reached.
    await expect(h.approve(plan)).resolves.toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('records what was granted, legibly, for the operator who has to audit it', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);
    const plan = buildMutationPlan(PIPELINE);
    await h.approve(plan);

    expect(h.stored.get(plan.fingerprint)).toMatchObject({
      fingerprint: plan.fingerprint,
      phaseIds: ['speckit-implement'],
      pipelineId: 'speckit'
    });
  });
});

describe('createPersistentGitApproval — what does not carry over (FR-R3-146)', () => {
  // FR-008, SC-004 — the grant is keyed by the fingerprint, and `buildMutationPlan`
  // rehashes when a phase's declaration changes. An edited pipeline is a different
  // plan, and a different plan was never approved.
  it('asks once more when a phase changes its side-effect class', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);
    const before = buildMutationPlan(PIPELINE);
    await h.approve(before);
    await h.approve(before);
    expect(h.confirm).toHaveBeenCalledTimes(1);

    const edited: WorkflowRunPipeline = {
      ...PIPELINE,
      phases: [
        PIPELINE.phases[0]!,
        { ...PIPELINE.phases[1]!, sideEffects: 'unrestricted' as const }
      ]
    };
    const after = buildMutationPlan(edited);
    expect(after.fingerprint).not.toBe(before.fingerprint);

    await h.approve(after);
    await h.approve(after);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    // The first grant is still there. An edit does not withdraw what was granted
    // for the plan as it stood.
    expect(h.stored.has(before.fingerprint)).toBe(true);
    expect(h.stored.has(after.fingerprint)).toBe(true);
  });

  // D5 — `Approve This Run` means this run. The old behaviour is preserved exactly:
  // nothing is written, and the next task asks again.
  it('writes nothing for a per-run approval and asks again on the next task', async () => {
    const h = drainHarness([GIT_APPROVAL_APPROVE_LABEL]);
    const plan = buildMutationPlan(PIPELINE);

    await expect(h.approve(plan)).resolves.toBe(true);
    await expect(h.approve(plan)).resolves.toBe(true);

    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.stored.size).toBe(0);
  });

  it('writes nothing when the operator declines, and asks again', async () => {
    const h = drainHarness([undefined]);
    const plan = buildMutationPlan(PIPELINE);

    await expect(h.approve(plan)).resolves.toBe(false);
    await expect(h.approve(plan)).resolves.toBe(false);

    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.stored.size).toBe(0);
  });

  // The write contract's last clause. The operator answered; a store that could
  // not record it must not turn their approval into a refusal.
  it('does not deny an approved run whose grant could not be written', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);
    h.persist.mockRejectedValueOnce(new Error('memento update failed'));
    const plan = buildMutationPlan(PIPELINE);

    await expect(h.approve(plan)).resolves.toBe(true);
    expect(JSON.stringify(h.logger.warn.mock.calls)).toContain(plan.fingerprint);

    // Fail-closed for the grant, not for the run: the next task asks again.
    await h.approve(plan);
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('honours a grant cleared mid-session, because it reads per consultation', async () => {
    const h = drainHarness([GIT_APPROVAL_PERSIST_LABEL]);
    const plan = buildMutationPlan(PIPELINE);

    await h.approve(plan);
    await h.approve(plan);
    expect(h.confirm).toHaveBeenCalledTimes(1);

    h.stored.clear(); // the operator resets state without reloading the window
    await h.approve(plan);
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });
});

// FR-R3-146 — quickstart M2's mechanical half, over the real store rather than a Map.
//
// The GUI half (clicking the modal in a live host) stays an operator step. What can
// be proved here is everything that is not the click: that the grant survives a
// window reload, and that it does not travel to another workspace.
class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

async function overStore(memento: Memento) {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const confirm = vi.fn().mockResolvedValue(GIT_APPROVAL_PERSIST_LABEL);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const approve = createPersistentGitApproval({
    request: createGitApprovalRequester({ confirm, logger }),
    isGranted: (fingerprint) => store.hasGitPlanGrant(fingerprint),
    persist: (plan) =>
      store.recordGitPlanGrant({
        fingerprint: plan.fingerprint,
        grantedAt: 1_700_000_000_000,
        phaseIds: plan.gitCapablePhaseIds,
        pipelineId: plan.pipelineId ?? UNRECORDED_PIPELINE_ID
      }),
    logger
  });
  return { approve, confirm, store };
}

describe('the durable grant over the real workspace store (FR-R3-146, M2)', () => {
  it('survives a window reload', async () => {
    const memento = new FakeMemento();
    const plan = buildMutationPlan(PIPELINE);

    const first = await overStore(memento);
    await first.approve(plan);
    expect(first.confirm).toHaveBeenCalledTimes(1);

    // A reload is a new store over the same persisted memento. Nothing is carried
    // across in memory — if the grant were held in a field, this asks again.
    const reloaded = await overStore(memento);
    await expect(reloaded.approve(plan)).resolves.toBe(true);
    expect(reloaded.confirm).not.toHaveBeenCalled();
  });

  it('does not travel to another workspace (FR-009)', async () => {
    const here = new FakeMemento();
    const elsewhere = new FakeMemento();
    const plan = buildMutationPlan(PIPELINE);

    await (await overStore(here)).approve(plan);

    const other = await overStore(elsewhere);
    await other.approve(plan);
    expect(other.confirm).toHaveBeenCalledTimes(1);
  });

  it('writes one legible entry an operator can read and withdraw (FR-012, SC-005)', async () => {
    const memento = new FakeMemento();
    const plan = buildMutationPlan(PIPELINE);
    const session = await overStore(memento);
    await session.approve(plan);

    // What `.schegent/state.json` holds, read the way an operator would open it.
    const raw = memento.get<Record<string, unknown>>(KEYS.gitPlanGrants);
    expect(Object.keys(raw ?? {})).toEqual([plan.fingerprint]);
    expect(JSON.stringify(raw)).toContain('speckit');
    expect(JSON.stringify(raw)).toContain('speckit-implement');

    // Withdrawal restores the prompt.
    await memento.update(KEYS.gitPlanGrants, undefined);
    await session.approve(plan);
    expect(session.confirm).toHaveBeenCalledTimes(2);
  });
});
