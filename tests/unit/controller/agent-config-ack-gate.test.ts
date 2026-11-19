import { describe, expect, it, vi } from 'vitest';
import { AgentConfigAckGate } from '../../../src/controller/agent-config-ack-gate';
import { projectAuditPayload } from '../../../src/audit/audit-payload';
import {
  AgentConfigAcknowledgementRefusedError,
  isAgentConfigAcknowledgementRefusal
} from '../../../src/services/agent-config-ack-refusal';
import {
  computeAgentConfigFingerprint,
  type RepoAgentConfigScanResult,
  type ScannedAgentConfigEntry
} from '../../../src/services/repo-agent-config-scanner';
import {
  forgetAgentConfigGrant,
  latestGrantForBackend,
  writeAgentConfigGrant,
  type AgentConfigGrant,
  type AgentConfigGrantMap
} from '../../../src/state/agent-config-grants';

const DIGEST_1 = '1'.repeat(64);
const DIGEST_2 = '2'.repeat(64);

function makeScan(
  backend: 'claude' | 'codex' | 'agy',
  entries: readonly ScannedAgentConfigEntry[],
  scanError = false
): RepoAgentConfigScanResult {
  const persistable = !scanError && entries.length > 0 && entries.every((e) => e.status === 'present');
  return {
    backend,
    entries,
    fingerprint: computeAgentConfigFingerprint(backend, entries, scanError),
    persistable,
    scanError
  };
}

describe('AgentConfigAckGate (FR-R7-04, SC-002, SC-005, SC-006)', () => {
  const ctx = (runId = 'run-1') => ({ runId, phase: 'specify', iteration: 1, cwd: '/ws' });

  it('skips contained backends (codex) completely without scanning or prompting', async () => {
    const scan = vi.fn();
    const request = vi.fn();
    const appendAudit = vi.fn();
    const gate = new AgentConfigAckGate({
      scan,
      hasGrant: () => false,
      latestGrantForBackend: () => null,
      persistGrant: vi.fn(),
      request,
      appendAudit,
      logger: { warn: vi.fn() }
    });

    await gate.ensureAcknowledged(ctx(), 'codex');
    expect(scan).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it('does not prompt when an uncontained repository has zero discovered config files', async () => {
    const request = vi.fn();
    const appendAudit = vi.fn();
    const gate = new AgentConfigAckGate({
      scan: async () => makeScan('claude', []),
      hasGrant: () => false,
      latestGrantForBackend: () => null,
      persistGrant: vi.fn(),
      request,
      appendAudit,
      logger: { warn: vi.fn() }
    });

    await gate.ensureAcknowledged(ctx(), 'claude');
    expect(request).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it('SC-002 & SC-006: persists grant, skips prompt on identical second Run, re-prompts on 1-byte change and after revoke', async () => {
    let grants: AgentConfigGrantMap = {};
    const auditEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    let currentScan = makeScan('claude', [
      {
        name: '.claude/settings.json',
        status: 'present',
        size: 120,
        digest: DIGEST_1,
        hookEvents: ['PreToolUse']
      }
    ]);

    const request = vi.fn<
      (scan: RepoAgentConfigScanResult, previousGrant: AgentConfigGrant | null) => Promise<'persist'>
    >(async () => 'persist');
    const gate = new AgentConfigAckGate({
      scan: async () => currentScan,
      hasGrant: (fp, b) =>
        Object.prototype.hasOwnProperty.call(grants, fp) && grants[fp].backend === b,
      latestGrantForBackend: (b) => latestGrantForBackend(grants, b),
      persistGrant: async (g) => {
        grants = writeAgentConfigGrant(grants, g);
      },
      request,
      appendAudit: async (entry) => {
        // Put every emitted audit payload through the real closed projector (SC-005).
        const projected = projectAuditPayload(entry.eventType, entry.payload);
        auditEvents.push({ eventType: entry.eventType, payload: projected });
      },
      logger: { warn: vi.fn() },
      now: () => 1_700_000_000_000
    });

    // Run 1: prompts once and persists.
    await gate.ensureAcknowledged(ctx('run-1'), 'claude');
    expect(request).toHaveBeenCalledTimes(1);
    expect(auditEvents[0]).toEqual({
      eventType: 'agent-config-acknowledged',
      payload: { backend: 'claude', fileCount: 1, decision: 'acknowledged' }
    });

    // Same Run, phase 2: in-memory ledger skips without re-scanning or re-emitting.
    await gate.ensureAcknowledged({ ...ctx('run-1'), phase: 'plan' }, 'claude');
    expect(request).toHaveBeenCalledTimes(1);
    expect(auditEvents).toHaveLength(1);

    // Run 2 with identical files: stored grant matches, zero modal.
    await gate.ensureAcknowledged(ctx('run-2'), 'claude');
    expect(request).toHaveBeenCalledTimes(1);
    expect(auditEvents[1]).toEqual({
      eventType: 'agent-config-acknowledged',
      payload: { backend: 'claude', fileCount: 1, decision: 'stored' }
    });

    // Run 3 after 1-byte change: digest changes, prompts again with previousGrant.
    currentScan = makeScan('claude', [
      {
        name: '.claude/settings.json',
        status: 'present',
        size: 121,
        digest: DIGEST_2,
        hookEvents: ['PreToolUse']
      }
    ]);
    await gate.ensureAcknowledged(ctx('run-3'), 'claude');
    expect(request).toHaveBeenCalledTimes(2);
    const secondCall = request.mock.calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall![1]).toMatchObject({
      backend: 'claude',
      files: [{ name: '.claude/settings.json', digest: DIGEST_1 }]
    });

    // Revoke grant -> Run 4 prompts again.
    grants = forgetAgentConfigGrant(grants, currentScan.fingerprint) ?? grants;
    await gate.ensureAcknowledged(ctx('run-4'), 'claude');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('throws typed AgentConfigAcknowledgementRefusedError on denied and emits sanitized audit', async () => {
    const auditEvents: Array<Record<string, unknown>> = [];
    const gate = new AgentConfigAckGate({
      scan: async () =>
        makeScan('claude', [
          {
            name: '.claude/settings.json',
            status: 'present',
            size: 64,
            digest: DIGEST_1,
            hookEvents: ['PreToolUse']
          }
        ]),
      hasGrant: () => false,
      latestGrantForBackend: () => null,
      persistGrant: vi.fn(),
      request: async () => 'denied',
      appendAudit: async (entry) => {
        auditEvents.push(projectAuditPayload(entry.eventType, entry.payload));
      },
      logger: { warn: vi.fn() }
    });

    let caught: unknown;
    try {
      await gate.ensureAcknowledged(ctx(), 'claude');
    } catch (err) {
      caught = err;
    }

    expect(isAgentConfigAcknowledgementRefusal(caught)).toBe(true);
    expect(caught).toBeInstanceOf(AgentConfigAcknowledgementRefusedError);
    expect(auditEvents).toEqual([{ backend: 'claude', fileCount: 1, decision: 'denied' }]);

    // SC-005: serialized audit contains no paths, hook names, or values.
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain('.claude');
    expect(serialized).not.toContain('settings.json');
    expect(serialized).not.toContain('PreToolUse');
    expect(serialized).not.toContain(DIGEST_1);
  });

  it('rejects any extra key (path, hookEvents, value) in audit payload projector (SC-005)', () => {
    expect(() =>
      projectAuditPayload('agent-config-acknowledged', {
        backend: 'claude',
        fileCount: 2,
        decision: 'acknowledged',
        path: '.claude/settings.json'
      })
    ).toThrow();
    expect(() =>
      projectAuditPayload('agent-config-acknowledged', {
        backend: 'claude',
        fileCount: 2,
        decision: 'acknowledged',
        hookEvents: ['PreToolUse']
      })
    ).toThrow();
  });

  it('treats a throwing scan as unreadable configuration and prompts rather than skipping (FR-007)', async () => {
    const request = vi.fn<
      (scan: RepoAgentConfigScanResult, previousGrant: AgentConfigGrant | null) => Promise<'this-run'>
    >(async () => 'this-run');
    const gate = new AgentConfigAckGate({
      scan: async () => {
        throw new Error('EACCES');
      },
      hasGrant: () => true, // even if store had something, unreadable scan cannot use stored grant
      latestGrantForBackend: () => null,
      persistGrant: vi.fn(),
      request,
      appendAudit: vi.fn(async () => undefined),
      logger: { warn: vi.fn() }
    });

    await gate.ensureAcknowledged(ctx(), 'claude');
    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0].scanError).toBe(true);
    expect(firstCall![0].persistable).toBe(false);
  });

  it('rejects a cross-backend grant mismatch even when fingerprint lookup is invoked', async () => {
    const request = vi.fn<
      (scan: RepoAgentConfigScanResult, previousGrant: AgentConfigGrant | null) => Promise<'this-run'>
    >(async () => 'this-run');
    const scanResult = makeScan('claude', [
      { name: 'CLAUDE.md', status: 'present', size: 12, digest: DIGEST_1 }
    ]);
    const mismatchedGrant: AgentConfigGrant = {
      fingerprint: scanResult.fingerprint,
      backend: 'agy',
      grantedAt: 1_700_000_000_000,
      files: [{ name: 'CLAUDE.md', size: 12, digest: DIGEST_1 }]
    };
    const grants: AgentConfigGrantMap = { [scanResult.fingerprint]: mismatchedGrant };

    const gate = new AgentConfigAckGate({
      scan: async () => scanResult,
      hasGrant: (fp, b) =>
        Object.prototype.hasOwnProperty.call(grants, fp) && grants[fp].backend === b,
      latestGrantForBackend: (b) => latestGrantForBackend(grants, b),
      persistGrant: vi.fn(),
      request,
      appendAudit: vi.fn(async () => undefined),
      logger: { warn: vi.fn() }
    });

    await gate.ensureAcknowledged(ctx(), 'claude');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('permits an explicitly approved run even if persisting the grant fails', async () => {
    const warn = vi.fn();
    const gate = new AgentConfigAckGate({
      scan: async () =>
        makeScan('claude', [{ name: 'CLAUDE.md', status: 'present', size: 12, digest: DIGEST_1 }]),
      hasGrant: () => false,
      latestGrantForBackend: () => null,
      persistGrant: async () => {
        throw new Error('memento write failed');
      },
      request: async () => 'persist',
      appendAudit: vi.fn(async () => undefined),
      logger: { warn }
    });

    await expect(gate.ensureAcknowledged(ctx(), 'claude')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
