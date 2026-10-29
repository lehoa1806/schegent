// FR-R4-F14 (feature 242), contract V1.2 — the closed failure-cause vocabulary.
//
// The vocabulary is the whole record: a member travels alone, with no message, so
// the tests pin its exact spelling, its membership check and its labels. The three
// members the sequencer already names as transition causes are compared by value
// against the exported constants, so a drift in either spelling fails here.
import { describe, expect, it } from 'vitest';
import { CAP_EXHAUSTED_CAUSE, PRE_SPAWN_REFUSAL_CAUSE } from '../../../src/audit/audit-payload';
import {
  INCOMPLETE_TURN_UNRESOLVED_CAUSE,
  LAST_PHASE_ISSUES_REMAIN_CAUSE
} from '../../../src/controller/phase';
import {
  FAILURE_CAUSE_LABELS,
  FAILURE_CAUSE_NOT_RECORDED,
  FAILURE_CAUSES,
  isFailureCause
} from '../../../src/contracts/failure-cause';

const EXPECTED_MEMBERS = [
  'cap_exhausted',
  'last_phase_issues_remain',
  'incomplete_turn_unresolved',
  'fatal_signature',
  'phase_failed',
  'phase_timeout',
  'runner_probe_failed',
  'audit_evidence_unavailable',
  'start_failed',
  'judged_metrics_unchanged'
] as const;

const EXPECTED_LABELS: Record<(typeof EXPECTED_MEMBERS)[number], string> = {
  cap_exhausted: 'Iteration cap reached',
  last_phase_issues_remain: 'Last phase ended with issues open',
  incomplete_turn_unresolved: 'Phase turn left unfinished',
  fatal_signature: 'Fatal error pattern matched',
  phase_failed: 'Phase failed',
  phase_timeout: 'Phase ran out of time',
  runner_probe_failed: 'Backend CLI unavailable',
  audit_evidence_unavailable: 'Audit evidence unavailable',
  start_failed: 'Host refusal or error',
  judged_metrics_unchanged: 'Judged metrics unchanged'
};

describe('the failure-cause vocabulary (FR-002, D1)', () => {
  it('has exactly the ten members, each once, in the documented order', () => {
    expect([...FAILURE_CAUSES]).toEqual([...EXPECTED_MEMBERS]);
    expect(new Set(FAILURE_CAUSES).size).toBe(FAILURE_CAUSES.length);
  });

  it('keeps the first nine members in their order and spelling; the tenth is appended (FR-R4-F17, D5.1)', () => {
    expect([...FAILURE_CAUSES].slice(0, 9)).toEqual([
      'cap_exhausted',
      'last_phase_issues_remain',
      'incomplete_turn_unresolved',
      'fatal_signature',
      'phase_failed',
      'phase_timeout',
      'runner_probe_failed',
      'audit_evidence_unavailable',
      'start_failed'
    ]);
    expect(FAILURE_CAUSES[9]).toBe('judged_metrics_unchanged');
  });

  it('includes the three transition causes the sequencer already names, by value', () => {
    expect(FAILURE_CAUSES).toContain(CAP_EXHAUSTED_CAUSE);
    expect(FAILURE_CAUSES).toContain(LAST_PHASE_ISSUES_REMAIN_CAUSE);
    expect(FAILURE_CAUSES).toContain(INCOMPLETE_TURN_UNRESOLVED_CAUSE);
  });

  it('admits every member and nothing near it', () => {
    for (const member of EXPECTED_MEMBERS) expect(isFailureCause(member)).toBe(true);

    expect(isFailureCause('cap_exhausted ')).toBe(false);
    expect(isFailureCause('CAP_EXHAUSTED')).toBe(false);
    expect(isFailureCause('phase_failed:x')).toBe(false);
    expect(isFailureCause(42)).toBe(false);
    expect(isFailureCause(null)).toBe(false);
    expect(isFailureCause(undefined)).toBe(false);
    expect(isFailureCause(PRE_SPAWN_REFUSAL_CAUSE)).toBe(false);
  });

  it('gives every member a fixed label that does not contain its own code', () => {
    for (const member of FAILURE_CAUSES) {
      const label = FAILURE_CAUSE_LABELS[member];
      expect(label.length, member).toBeGreaterThan(0);
      expect(label, member).toBe(EXPECTED_LABELS[member]);
      expect(label.includes(member), member).toBe(false);
    }
    expect(Object.keys(FAILURE_CAUSE_LABELS).sort()).toEqual([...EXPECTED_MEMBERS].sort());
  });

  it('names the absent state with fixed host text', () => {
    expect(FAILURE_CAUSE_NOT_RECORDED).toBe('Cause not recorded');
  });
});
