// FR-R5-F32 (F32-T04, F32-T05, F32-T06, F32-T07) — Component tests for CandidateBlockInspector.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinueWorkflowResult, ControlCommandEnvelope } from '../../../lib/messages';
import type { ControlProjection } from '../../../lib/snapshot-types';
import {
  buildCandidateBlockStateFixture,
  CANDIDATE_BLOCK_FRAME_STATES
} from '../../../../../src/services/workflow-execution/workflow-control-projector';
import {
  formatControlTimestamp,
  formatEffectCertaintyLabel,
  formatRecoveryCoverageLabel
} from '../candidate-block-inspector-format';

const sendControlSpy = vi.fn<
  (command: ControlCommandEnvelope) => Promise<ContinueWorkflowResult>
>();

vi.mock('../../../lib/workflow-run-ipc', () => ({
  sendWorkflowControlCommand: (command: ControlCommandEnvelope) => sendControlSpy(command)
}));

import CandidateBlockInspector from '../CandidateBlockInspector.svelte';

beforeEach(() => {
  sendControlSpy.mockReset();
  sendControlSpy.mockResolvedValue({
    outcome: 'control-acknowledged',
    acknowledgement: {
      version: 1,
      commandId: 'cmd-1',
      outcome: 'accepted',
      generation: 2
    }
  });
});

afterEach(() => {
  cleanup();
});

describe('CandidateBlockInspector — 10 frame states & candidate identity (F32-T04)', () => {
  it('renders all 10 candidate-block frame states from buildCandidateBlockStateFixture', () => {
    for (const state of CANDIDATE_BLOCK_FRAME_STATES) {
      const fixture = buildCandidateBlockStateFixture(state);
      const { getByTestId, unmount } = render(CandidateBlockInspector, {
        props: { projection: fixture }
      });

      expect(getByTestId('candidate-block-inspector').getAttribute('data-frame-state')).toBe(
        state
      );
      expect(getByTestId('candidate-block-inspector-state').textContent.trim()).toBe(state);
      unmount();
    }
  });

  it('distinguishes two candidates sharing the same backend by their Phase identity, quota identity, and attempts vs enclosing business iteration', () => {
    const projection = buildCandidateBlockStateFixture('waiting-availability', {
      attemptsUsed: 3,
      maxDispatches: 12,
      rootDispatchesUsed: 7,
      rootMaxDispatches: 100,
      enclosingIteration: 2,
      enclosingMaxIterations: 5,
      candidates: [
        {
          candidateId: 'cand-claude-fast',
          nodeId: 'node-claude-fast',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          attemptsUsed: 2,
          maxAttempts: 3,
          eligibility: 'eligible',
          policyExcluded: false,
          availabilityStatus: 'rate-limited',
          availabilitySource: 'settlement-evidence',
          fresh: true,
          quotaIdentity: 'claude:shared-team',
          permitWaitPosition: 1,
          phaseId: 'phase-fast-triage',
          phaseName: 'Fast Triage',
          instructionSummary: 'Run quick root-cause triage.',
          operatorKind: 'structured-result'
        },
        {
          candidateId: 'cand-claude-deep',
          nodeId: 'node-claude-deep',
          backend: 'claude',
          priority: 2,
          authoredOrder: 1,
          attemptsUsed: 1,
          maxAttempts: 4,
          eligibility: 'retired',
          retirementReason: 'attempts-exhausted',
          policyExcluded: true,
          availabilityStatus: 'quota-exhausted',
          availabilitySource: 'ping-probe',
          fresh: false,
          quotaIdentity: 'claude:shared-team',
          permitWaitPosition: 2,
          phaseId: 'phase-deep-audit',
          phaseName: 'Deep Audit',
          instructionSummary: 'Perform exhaustive architectural audit.',
          operatorKind: 'diagnostic-result'
        }
      ]
    });

    const { getByTestId } = render(CandidateBlockInspector, {
      props: { projection }
    });

    expect(getByTestId('candidate-block-inspector-block-dispatches').textContent).toContain(
      '3 / 12'
    );
    expect(getByTestId('candidate-block-inspector-root-dispatches').textContent).toContain(
      '7 / 100'
    );
    expect(getByTestId('candidate-block-inspector-enclosing-iteration').textContent).toContain(
      '2 / 5'
    );

    expect(
      getByTestId('candidate-inspector-phase-identity-cand-claude-fast').textContent
    ).toContain('Fast Triage');
    expect(
      getByTestId('candidate-inspector-phase-identity-cand-claude-fast').textContent
    ).toContain('structured-result');
    expect(
      getByTestId('candidate-inspector-phase-identity-cand-claude-deep').textContent
    ).toContain('Deep Audit');
    expect(
      getByTestId('candidate-inspector-phase-identity-cand-claude-deep').textContent
    ).toContain('diagnostic-result');

    expect(getByTestId('candidate-inspector-attempts-cand-claude-fast').textContent).toContain(
      '2 / 3 (1 remaining)'
    );
    expect(getByTestId('candidate-inspector-status-cand-claude-deep').textContent).toContain(
      'retired'
    );
    expect(getByTestId('candidate-inspector-status-cand-claude-deep').textContent).toContain(
      'Excluded by operator policy'
    );
    expect(getByTestId('candidate-inspector-quota-cand-claude-fast').textContent).toContain(
      'claude:shared-team'
    );
    expect(getByTestId('candidate-inspector-quota-cand-claude-fast').textContent).toContain(
      'wait position #1'
    );
  });

  it('formats reset/deadline timestamps in UTC and Asia/Ho_Chi_Minh with explicit day-rollover display', () => {
    // Reference: 2026-04-15T16:00:00Z (which is 2026-04-15 23:00:00 in Asia/Ho_Chi_Minh)
    const refMs = Date.parse('2026-04-15T16:00:00.000Z');
    // Target: 2026-04-15T18:30:00Z (same day in UTC, next day 2026-04-16 01:30:00 in Asia/Ho_Chi_Minh)
    const targetMs = Date.parse('2026-04-15T18:30:00.000Z');

    const utcFormatted = formatControlTimestamp(targetMs, {
      timeZone: 'UTC',
      referenceTimeMs: refMs
    });
    expect(utcFormatted).toContain('2026-04-15');
    expect(utcFormatted).toContain('18:30:00');
    expect(utcFormatted).not.toContain('day rollover');

    const hcmFormatted = formatControlTimestamp(targetMs, {
      timeZone: 'Asia/Ho_Chi_Minh',
      referenceTimeMs: refMs
    });
    expect(hcmFormatted).toContain('2026-04-16');
    expect(hcmFormatted).toContain('01:30:00');
    expect(hcmFormatted).toContain('day rollover');
  });
});

describe('CandidateBlockInspector — recovery coverage, effect certainty & spend honesty (F32-T05)', () => {
  it('never defaults missing recovery coverage to complete or missing effect certainty to safe', () => {
    expect(formatRecoveryCoverageLabel(undefined)).toBe('Not recorded (unavailable)');
    expect(formatEffectCertaintyLabel(undefined)).toBe('Not recorded (unknown)');

    const minimal = buildCandidateBlockStateFixture('executing');
    const { getByTestId } = render(CandidateBlockInspector, {
      props: { projection: minimal }
    });

    expect(getByTestId('candidate-block-inspector-recovery-coverage').textContent).toBe(
      'Not recorded (unavailable)'
    );
    expect(getByTestId('candidate-block-inspector-effect-certainty').textContent).toBe(
      'Not recorded (unknown)'
    );
  });

  it('renders partial recovery coverage with manifest truncation, uncertain effect, strict-usd spend quality, overshoot notes, durable notices, and evidence refs', () => {
    const rich: ControlProjection = buildCandidateBlockStateFixture('intervention-required', {
      recoveryCoverage: 'partial',
      manifestTruncated: true,
      preexistingDirtyCount: 4,
      effectCertainty: 'uncertain',
      spendMode: 'strict-usd',
      spendEnforcementQuality: 'estimated',
      verifiedMicrousd: 120000,
      estimatedMicrousd: 185000,
      unpricedAttemptCount: 1,
      maxMicrousd: 250000,
      activeAttemptOvershootNote:
        'Active attempt #2 exceeded soft estimate by $0.0150 before settlement.',
      durableNotices: [
        'Candidate cand-primary hit rate-limit HTTP 429; waiting for reset.',
        'Workspace snapshot restored with 4 preexisting dirty paths preserved.'
      ],
      evidenceRefs: ['ev-ledger-001', 'ev-handover-002']
    });

    const { getByTestId } = render(CandidateBlockInspector, {
      props: { projection: rich }
    });

    expect(getByTestId('candidate-block-inspector-recovery-coverage').textContent).toContain(
      'partial (manifest truncated, 4 preexisting dirty path(s) preserved)'
    );
    expect(getByTestId('candidate-block-inspector-effect-certainty').textContent).toBe(
      'uncertain'
    );
    expect(getByTestId('candidate-block-inspector-spend-mode').textContent).toBe('strict-usd');
    expect(getByTestId('candidate-block-inspector-spend-quality').textContent).toBe('estimated');
    expect(getByTestId('candidate-block-inspector-spend-summary').textContent).toContain(
      'Unpriced attempts: 1'
    );
    expect(getByTestId('candidate-block-inspector-overshoot-note').textContent).toContain(
      'exceeded soft estimate'
    );
    expect(getByTestId('candidate-block-inspector-durable-notices').textContent).toContain(
      'Workspace snapshot restored'
    );
    expect(getByTestId('candidate-block-inspector-evidence-refs').textContent).toContain(
      'ev-ledger-001'
    );
  });
});

describe('CandidateBlockInspector — legal operator controls & stale-generation protection (F32-T06)', () => {
  it('separates renew-monitoring from resume when monitoring-expired and displays refusal reason on disabled resume', async () => {
    const expired = buildCandidateBlockStateFixture('monitoring-expired', {
      generation: 5
    });
    const { getByTestId } = render(CandidateBlockInspector, {
      props: { projection: expired }
    });

    const renewBtn = getByTestId('candidate-control-action-renew-monitoring') as HTMLButtonElement;
    const resumeBtn = getByTestId('candidate-control-action-resume') as HTMLButtonElement;

    expect(renewBtn.disabled).toBe(false);
    expect(resumeBtn.disabled).toBe(true);
    expect(getByTestId('candidate-control-reason-resume').textContent).toBe('monitoring-expired');

    await fireEvent.click(renewBtn);
    await tick();
    await tick();

    expect(sendControlSpy).toHaveBeenCalledTimes(1);
    expect(sendControlSpy.mock.calls[0][0].commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(sendControlSpy.mock.calls[0][0]).toMatchObject({
      version: 1,
      expectedGeneration: 5,
      action: { kind: 'renew-monitoring' }
    });
    expect(getByTestId('candidate-control-feedback').textContent).toContain(
      'Accepted renew-monitoring'
    );
  });

  it('correlates stale-generation refusals to the initiating subject and rejects older generation updates', async () => {
    sendControlSpy.mockResolvedValueOnce({
      outcome: 'control-acknowledged',
      acknowledgement: {
        version: 1,
        commandId: 'cmd-stale',
        outcome: 'refused',
        generation: 9,
        reason: 'stale-generation'
      }
    });

    const waiting = buildCandidateBlockStateFixture('waiting-availability', {
      generation: 4
    });
    const { getByTestId } = render(CandidateBlockInspector, {
      props: { projection: waiting }
    });

    await fireEvent.click(getByTestId('candidate-control-action-check-now'));
    await tick();
    await tick();

    const feedback = getByTestId('candidate-control-feedback');
    expect(feedback.getAttribute('data-feedback-kind')).toBe('refused');
    expect(feedback.getAttribute('data-subject-invocation-id')).toBe(waiting.invocationId);
    expect(feedback.textContent).toContain('stale-generation');

    // Subsequent click on the still-stale generation 4 is blocked client-side before sending
    await fireEvent.click(getByTestId('candidate-control-action-check-now'));
    await tick();
    expect(sendControlSpy).toHaveBeenCalledTimes(1);
    expect(getByTestId('candidate-control-feedback').textContent).toContain(
      'generation 4 is older than current generation 9'
    );
  });
});
