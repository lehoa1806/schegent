import { describe, expect, it, vi } from 'vitest';

import {
  GIT_APPROVAL_APPROVE_LABEL,
  createGitApprovalRequester
} from '../../../src/activation/git-approval';
import type { MutationPlanSnapshot } from '../../../src/state/workflow-run';

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
  it('returns true only when the operator picks the approve action', async () => {
    const { request } = harness(GIT_APPROVAL_APPROVE_LABEL);
    await expect(request(PLAN)).resolves.toBe(true);
  });

  it('denies when the operator cancels', async () => {
    const { request } = harness('Cancel');
    await expect(request(PLAN)).resolves.toBe(false);
  });

  it('denies when the dialog is dismissed without a choice', async () => {
    const { request } = harness(undefined);
    await expect(request(PLAN)).resolves.toBe(false);
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
    await expect(pending).resolves.toBe(true);
  });

  it('binds the prompt to the exact mutation fingerprint and phase list', async () => {
    const { request, confirm } = harness(GIT_APPROVAL_APPROVE_LABEL);
    await request(PLAN);

    const [message, detail, approveLabel] = confirm.mock.calls[0] as [string, string, string];
    expect(message).toContain('2');
    expect(detail).toContain('fp-abc123');
    expect(detail).toContain('speckit-implement');
    expect(detail).toContain('finalize');
    expect(approveLabel).toBe(GIT_APPROVAL_APPROVE_LABEL);
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

  it('fails closed when the dialog itself throws', async () => {
    const confirm = vi.fn().mockRejectedValue(new Error('no UI host'));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const request = createGitApprovalRequester({ confirm, logger });

    await expect(request(PLAN)).resolves.toBe(false);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('fp-abc123');
  });
});
