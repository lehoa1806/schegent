import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CONFIG_APPROVE_ONCE_LABEL,
  AGENT_CONFIG_PERSIST_LABEL,
  buildAgentConfigAckPrompt,
  createAgentConfigAckRequester
} from '../../../src/activation/agent-config-acknowledgement';
import {
  computeAgentConfigFingerprint,
  type RepoAgentConfigScanResult,
  type ScannedAgentConfigEntry
} from '../../../src/services/repo-agent-config-scanner';
import type { AgentConfigGrant } from '../../../src/state/agent-config-grants';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_A_NEW = 'd'.repeat(64);

function makeScan(
  entries: readonly ScannedAgentConfigEntry[],
  opts: { scanError?: boolean; scanErrorReason?: 'timeout' | 'scan-failed' } = {}
): RepoAgentConfigScanResult {
  const scanError = opts.scanError ?? false;
  const persistable = !scanError && entries.length > 0 && entries.every((e) => e.status === 'present');
  return {
    backend: 'claude',
    entries,
    fingerprint: computeAgentConfigFingerprint('claude', entries, scanError, opts.scanErrorReason),
    persistable,
    scanError,
    ...(opts.scanErrorReason !== undefined ? { scanErrorReason: opts.scanErrorReason } : {})
  };
}

describe('agent-config-acknowledgement modal requester (FR-R7-04, SC-001, SC-002)', () => {
  it('SC-001: lists three discovered entries and Claude hook event names with zero secret values', async () => {
    const plantedSecret = 'SUPER_SECRET_HOOK_TOKEN_987654';
    const scan = makeScan([
      {
        name: '.claude/settings.json',
        status: 'present',
        size: 128,
        digest: DIGEST_A,
        hookEvents: ['PostToolUse', 'PreToolUse'],
        settingKeys: ['env', 'permissions']
      },
      {
        name: '.mcp.json',
        status: 'present',
        size: 64,
        digest: DIGEST_B
      },
      {
        name: 'CLAUDE.md',
        status: 'present',
        size: 256,
        digest: DIGEST_C
      }
    ]);

    let capturedMessage = '';
    let capturedDetail = '';
    let capturedActions: readonly string[] = [];
    const requester = createAgentConfigAckRequester({
      confirm: async (message, detail, actions) => {
        capturedMessage = message;
        capturedDetail = detail;
        capturedActions = actions;
        return AGENT_CONFIG_PERSIST_LABEL;
      },
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    const decision = await requester(scan);
    expect(decision).toBe('persist');
    expect(capturedMessage).toContain('claude');
    expect(capturedMessage).toContain('3 files');
    expect(capturedDetail).toContain('.claude/settings.json');
    expect(capturedDetail).toContain('.mcp.json');
    expect(capturedDetail).toContain('CLAUDE.md');
    expect(capturedDetail).toContain('PostToolUse, PreToolUse');
    expect(capturedDetail).toContain('env, permissions');
    expect(capturedDetail).toContain(DIGEST_A.slice(0, 12));
    expect(capturedDetail).not.toContain(plantedSecret);
    expect(capturedActions).toEqual([AGENT_CONFIG_APPROVE_ONCE_LABEL, AGENT_CONFIG_PERSIST_LABEL]);
  });

  it('SC-002: describes modified, added, and removed files by name and digest when a prior grant exists', () => {
    const prior: AgentConfigGrant = {
      fingerprint: '0'.repeat(64),
      backend: 'claude',
      grantedAt: 1_700_000_000_000,
      files: [
        { name: '.claude/settings.json', size: 128, digest: DIGEST_A },
        { name: 'CLAUDE.md', size: 200, digest: DIGEST_C }
      ]
    };
    const nextScan = makeScan([
      { name: '.claude/settings.json', status: 'present', size: 129, digest: DIGEST_A_NEW },
      { name: '.mcp.json', status: 'present', size: 64, digest: DIGEST_B }
    ]);

    const prompt = buildAgentConfigAckPrompt(nextScan, prior);
    expect(prompt.message).toContain('changed');
    expect(prompt.detail).toContain('Changes since last acknowledgement:');
    expect(prompt.detail).toContain(`modified: .claude/settings.json (sha256:${DIGEST_A.slice(0, 12)} → sha256:${DIGEST_A_NEW.slice(0, 12)})`);
    expect(prompt.detail).toContain(`added: .mcp.json (sha256:${DIGEST_B.slice(0, 12)})`);
    expect(prompt.detail).toContain(`removed: CLAUDE.md (was sha256:${DIGEST_C.slice(0, 12)})`);
  });

  it('offers only one-time approval and refuses persist when any entry is unreadable', async () => {
    const scan = makeScan([
      { name: '.claude/settings.json', status: 'unreadable', unreadableReason: 'symlink' }
    ]);
    expect(scan.persistable).toBe(false);

    let offeredActions: readonly string[] = [];
    const requester = createAgentConfigAckRequester({
      confirm: async (_msg, detail, actions) => {
        offeredActions = actions;
        expect(detail).toContain('UNREADABLE: symlink refused');
        expect(detail).toContain('cannot be remembered');
        // Even if a buggy host returned the persist label, it must not resolve to 'persist'.
        return AGENT_CONFIG_PERSIST_LABEL;
      },
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    const decision = await requester(scan);
    expect(offeredActions).toEqual([AGENT_CONFIG_APPROVE_ONCE_LABEL]);
    expect(decision).toBe('denied');
  });

  it('discloses a partial scan without treating unscanned files as removals', () => {
    const prior: AgentConfigGrant = {
      fingerprint: '0'.repeat(64),
      backend: 'claude',
      grantedAt: 1_700_000_000_000,
      files: [
        { name: '.claude/settings.json', size: 128, digest: DIGEST_A },
        { name: 'CLAUDE.md', size: 200, digest: DIGEST_C }
      ]
    };
    const scan = makeScan(
      [{ name: '.claude/settings.json', status: 'present', size: 129, digest: DIGEST_A_NEW }],
      { scanError: true, scanErrorReason: 'timeout' }
    );

    const prompt = buildAgentConfigAckPrompt(scan, prior);
    expect(prompt.message).toContain('could not finish scanning');
    expect(prompt.detail).toContain('modified: .claude/settings.json');
    expect(prompt.detail).not.toContain('removed: CLAUDE.md');
    expect(prompt.actions).toEqual([AGENT_CONFIG_APPROVE_ONCE_LABEL]);
  });

  it('returns this-run on Approve This Run, denied on dismissal, and denied on dialog throw', async () => {
    const scan = makeScan([{ name: 'CLAUDE.md', status: 'present', size: 10, digest: DIGEST_C }]);

    const approveOnce = createAgentConfigAckRequester({
      confirm: async () => AGENT_CONFIG_APPROVE_ONCE_LABEL,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    expect(await approveOnce(scan)).toBe('this-run');

    const dismissed = createAgentConfigAckRequester({
      confirm: async () => undefined,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    expect(await dismissed(scan)).toBe('denied');

    const warn = vi.fn();
    const throwing = createAgentConfigAckRequester({
      confirm: async () => {
        throw new Error('headless host');
      },
      logger: { info: vi.fn(), warn }
    });
    expect(await throwing(scan)).toBe('denied');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('S3: uses contained-backend modal wording for codex (never claims no OS-enforced sandbox) and formats overflow/hook-script markers', () => {
    const codexEntries: readonly ScannedAgentConfigEntry[] = [
      { name: '.codex/config.toml', status: 'present', size: 64, digest: DIGEST_A },
      { name: 'AGENTS.md', status: 'present', size: 128, digest: DIGEST_B }
    ];
    const codexScan: RepoAgentConfigScanResult = {
      backend: 'codex',
      entries: codexEntries,
      fingerprint: computeAgentConfigFingerprint('codex', codexEntries, false),
      persistable: true,
      scanError: false
    };
    const codexPrompt = buildAgentConfigAckPrompt(codexScan);
    expect(codexPrompt.message).not.toContain('uncontained');
    expect(codexPrompt.detail).not.toContain('without an OS-enforced sandbox');
    expect(codexPrompt.detail).toContain('sandbox or approval posture');

    const overflowScan = makeScan([
      { name: 'scripts/check.sh', status: 'present', size: 32, digest: DIGEST_A, hookScript: true },
      { name: '.claude/skills/d1/d2/d3/d4/d5/', status: 'unreadable', unreadableReason: 'depth-limit-exceeded' },
      { name: '.claude/skills/s257.md', status: 'unreadable', unreadableReason: 'file-count-limit-exceeded' },
      { name: '.claude/skills/big.md', status: 'unreadable', unreadableReason: 'total-bytes-limit-exceeded' }
    ]);
    const overflowPrompt = buildAgentConfigAckPrompt(overflowScan);
    expect(overflowPrompt.detail).toContain('hook script');
    expect(overflowPrompt.detail).toContain('max directory walk depth (4)');
    expect(overflowPrompt.detail).toContain('max scanned file count (256)');
    expect(overflowPrompt.detail).toContain('4 MiB total scan budget');
    expect(overflowPrompt.actions).toEqual([AGENT_CONFIG_APPROVE_ONCE_LABEL]);
  });
});
