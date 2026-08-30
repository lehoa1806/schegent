import { describe, expect, it, vi } from 'vitest';

import {
  createUncontainedConsentRequester,
  uncontainedConsentApproveLabel,
  uncontainedConsentHeadline,
  type UncontainedConsentConfig
} from '../../../src/activation/uncontained-consent';
import type { UncontainedRefusal } from '../../../src/controller/uncontained-consent-gate';
import {
  ALLOW_UNCONTAINED_SETTING,
  judgeBackendContainment
} from '../../../src/services/backend-containment-policy';
import { CONFIGURATION_TARGET_GLOBAL } from '../../../src/config/general-settings';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';

/** The refusal as the controller has it: the policy's own verdict, not a paraphrase. */
function refusalFor(kind: BackendRunnerKind): UncontainedRefusal {
  const verdict = judgeBackendContainment(kind, new Set());
  if (verdict.outcome !== 'refused') {
    throw new Error(`judgeBackendContainment allowed '${kind}'; this test needs a refusal`);
  }
  return { kind: verdict.kind, message: verdict.message };
}

const CLAUDE_REFUSAL = refusalFor('claude');

function harness(options: {
  readonly answer?: string | undefined;
  readonly confirmThrows?: Error;
  readonly stored?: unknown;
  readonly writeRejects?: Error;
}) {
  const confirm = options.confirmThrows
    ? vi.fn().mockRejectedValue(options.confirmThrows)
    : vi.fn().mockResolvedValue(options.answer);
  let stored = options.stored;
  const update = vi.fn(async (_key: string, value: unknown) => {
    if (options.writeRejects) throw options.writeRejects;
    stored = value;
  });
  const config: UncontainedConsentConfig = {
    get: <T>(): T | undefined => stored as T | undefined,
    update
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    confirm,
    update,
    logger,
    written: (): unknown => stored,
    request: createUncontainedConsentRequester({ confirm, config, logger })
  };
}

describe('createUncontainedConsentRequester (FR-R3-146, contract C1)', () => {
  describe('the five outcomes', () => {
    it('grants on the affirmative action, and only on that one', async () => {
      const h = harness({ answer: uncontainedConsentApproveLabel('claude') });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({ decision: 'granted' });
      expect(h.written()).toEqual(['claude']);
    });

    it('denies on Cancel, and writes nothing', async () => {
      const h = harness({ answer: 'Cancel' });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({ decision: 'denied' });
      expect(h.update).not.toHaveBeenCalled();
    });

    it('denies on dismissal, and writes nothing', async () => {
      const h = harness({ answer: undefined });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({ decision: 'denied' });
      expect(h.update).not.toHaveBeenCalled();
    });

    it('denies when the dialog itself fails, naming the reason in a warning', async () => {
      // An unanswerable prompt is a denial. The alternative is granting local user
      // authority because nobody could be asked, which is the defect, not the fix.
      const h = harness({ confirmThrows: new Error('no UI host') });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({ decision: 'denied' });
      expect(h.update).not.toHaveBeenCalled();
      expect(h.logger.warn.mock.calls.join('\n')).toContain('no UI host');
    });

    it('reports a rejected settings write as its own fault, not as a refusal', async () => {
      // The operator consented and the host could not record it. Calling that a
      // denial tells them they declined something they accepted.
      const h = harness({
        answer: uncontainedConsentApproveLabel('claude'),
        writeRejects: new Error('profile is read-only')
      });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({
        decision: 'write-failed',
        reason: 'profile is read-only'
      });
    });
  });

  describe('exactly one id is added (FR-003)', () => {
    it('grants the refused backend and nothing else', async () => {
      const h = harness({ answer: uncontainedConsentApproveLabel('agy') });
      await expect(h.request(refusalFor('agy'))).resolves.toEqual({ decision: 'granted' });
      expect(h.written()).toEqual(['agy']);
      expect(h.written()).not.toContain('claude');
    });

    it('appends to an existing list rather than replacing it', async () => {
      const h = harness({
        answer: uncontainedConsentApproveLabel('claude'),
        stored: ['codex']
      });
      await h.request(CLAUDE_REFUSAL);
      expect(h.written()).toEqual(['codex', 'claude']);
    });

    it('writes the one key at application scope', async () => {
      const h = harness({ answer: uncontainedConsentApproveLabel('claude') });
      await h.request(CLAUDE_REFUSAL);
      expect(h.update).toHaveBeenCalledWith(
        ALLOW_UNCONTAINED_SETTING,
        ['claude'],
        CONFIGURATION_TARGET_GLOBAL
      );
    });

    it('re-reads the list at write time, so a concurrent grant is not dropped', async () => {
      // Two windows refused at once. The other one wrote while this modal was open;
      // a list captured before prompting would overwrite it with one that never
      // contained `agy`.
      let stored: unknown = [];
      const update = vi.fn(async (_key: string, value: unknown) => {
        stored = value;
      });
      const confirm = vi.fn(async () => {
        stored = ['agy'];
        return uncontainedConsentApproveLabel('claude');
      });
      const request = createUncontainedConsentRequester({
        confirm,
        config: { get: <T>(): T | undefined => stored as T | undefined, update },
        logger: { info: vi.fn(), warn: vi.fn() }
      });

      await request(CLAUDE_REFUSAL);
      expect(stored).toEqual(['agy', 'claude']);
    });

    it('writes nothing when the id is already granted', async () => {
      const h = harness({
        answer: uncontainedConsentApproveLabel('claude'),
        stored: ['claude']
      });
      await expect(h.request(CLAUDE_REFUSAL)).resolves.toEqual({ decision: 'granted' });
      expect(h.update).not.toHaveBeenCalled();
    });

    it('replaces a malformed value, which grants nothing today, without inventing entries', async () => {
      const h = harness({ answer: uncontainedConsentApproveLabel('claude'), stored: true });
      await h.request(CLAUDE_REFUSAL);
      expect(h.written()).toEqual(['claude']);
    });

    it('keeps an unsupported entry rather than deleting the operator typo', async () => {
      // `resolveUncontainedGrant` reports it. Silently removing it is how an
      // operator never finds out they misspelled a backend id.
      const h = harness({
        answer: uncontainedConsentApproveLabel('claude'),
        stored: ['claud', 42]
      });
      await h.request(CLAUDE_REFUSAL);
      expect(h.written()).toEqual(['claud', 'claude']);
    });
  });

  describe('the text is the policy modules, not a restatement (plan A4)', () => {
    it('carries the verdict message verbatim as the detail', async () => {
      const h = harness({ answer: 'Cancel' });
      await h.request(CLAUDE_REFUSAL);
      const [message, detail, label] = h.confirm.mock.calls[0] as [string, string, string];
      expect(detail).toBe(CLAUDE_REFUSAL.message);
      expect(message).toBe(uncontainedConsentHeadline('claude'));
      expect(label).toBe(uncontainedConsentApproveLabel('claude'));
    });

    it('shows the whole message, including the half the 240-char cut removed', async () => {
      const h = harness({ answer: 'Cancel' });
      await h.request(CLAUDE_REFUSAL);
      const detail = (h.confirm.mock.calls[0] as [string, string, string])[1];
      // Non-vacuity: the message is longer than the bound that severed it, and the
      // operator's report ended at `or cho`.
      expect(detail.length).toBeGreaterThan(240);
      expect(detail).not.toMatch(/or cho$/);
      expect(detail).toContain('choose a backend that carries a sandbox');
      expect(detail).toContain(ALLOW_UNCONTAINED_SETTING);
    });

    it('names the backend in both the headline and the action', () => {
      expect(uncontainedConsentHeadline('agy')).toContain("'agy'");
      expect(uncontainedConsentApproveLabel('agy')).toContain("'agy'");
      // The label says what the write is scoped to, because that is what it does.
      expect(uncontainedConsentApproveLabel('agy')).toContain('Installation');
    });
  });
});
