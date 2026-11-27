import { describe, expect, it } from 'vitest';
import {
  forgetAgentConfigGrant,
  latestGrantForBackend,
  MAX_AGENT_CONFIG_GRANT_FILES,
  readAgentConfigGrants,
  writeAgentConfigGrant,
  type AgentConfigGrant,
  type AgentConfigGrantFileSummary
} from '../../../src/state/agent-config-grants';
import { computeAgentConfigFingerprint } from '../../../src/contracts/agent-config-fingerprint';
import { KEYS, WorkspaceStateStore } from '../../../src/state/workspace-state';

// Fingerprints produced by the shipped scanner format for the fixture entries below.
const FP_1 = 'f8b4038227f42c44023009b29ecedb8dbf24c2194f09d1f395a3a1afcb278644';
const FP_2 = 'ae39b0e9fbaca25fab2e95e80eb431328e462a57d8ed7378bb5847fd8edf70bd';
const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);

function makeGrant(overrides: Partial<AgentConfigGrant> = {}): AgentConfigGrant {
  return {
    fingerprint: FP_1,
    backend: 'claude',
    grantedAt: 1_700_000_000_000,
    files: [{ name: '.claude/settings.json', size: 100, digest: DIGEST_1 }],
    ...overrides
  };
}

describe('agent-config-grants total reader & writers (FR-R7-04, FR-003)', () => {
  it('returns empty map with zero problems for undefined', () => {
    const result = readAgentConfigGrants(undefined);
    expect(result.grants).toEqual({});
    expect(result.problems).toEqual([]);
  });

  it('fails closed without throwing on non-object root values', () => {
    for (const malformed of [null, 'string', 42, true, []]) {
      const result = readAgentConfigGrants(malformed);
      expect(result.grants).toEqual({});
      expect(result.problems.length).toBe(1);
    }
  });

  it('drops malformed entries while preserving valid entries and bounding problem reports', () => {
    const valid = makeGrant();
    const raw: Record<string, unknown> = {
      [FP_1]: valid,
      'not-a-sha256': valid,
      [FP_2]: { ...valid, fingerprint: FP_1 }, // key mismatch
      ['3'.repeat(64)]: { ...makeGrant({ fingerprint: '3'.repeat(64) }), backend: 'unknown' },
      ['4'.repeat(64)]: { ...makeGrant({ fingerprint: '4'.repeat(64) }), grantedAt: Number.NaN },
      ['5'.repeat(64)]: { ...makeGrant({ fingerprint: '5'.repeat(64) }), files: [] },
      ['6'.repeat(64)]: {
        ...makeGrant({ fingerprint: '6'.repeat(64) }),
        files: [{ name: '../escape', size: 10, digest: DIGEST_1 }]
      }
    };
    const result = readAgentConfigGrants(raw);
    expect(Object.keys(result.grants)).toEqual([FP_1]);
    expect(result.grants[FP_1]).toEqual(valid);
    expect(result.problems.length).toBe(6);
  });

  it('requires a dense set of tracked names and matching file metadata', () => {
    const grant = makeGrant();
    const file = grant.files[0];
    for (const files of [
      new Array<unknown>(1),
      [file, file],
      [{ ...file, name: 'untracked.md' }],
      [{ ...file, digest: DIGEST_2 }]
    ]) {
      const result = readAgentConfigGrants({ [FP_1]: { ...grant, files } });
      expect(result.grants).toEqual({});
      expect(result.problems).toHaveLength(1);
    }
  });

  it('serializes grant writes and both revocation operations through the workspace store', async () => {
    const existing = makeGrant();
    const next = makeGrant({
      fingerprint: FP_2,
      files: [{ name: 'CLAUDE.md', size: 50, digest: DIGEST_2 }]
    });
    const data = new Map<string, unknown>([[KEYS.agentConfigGrants, { [FP_1]: existing }]]);
    const store = new WorkspaceStateStore({
      get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
      update: async (key, value) => {
        await Promise.resolve();
        data.set(key, value);
      }
    });

    const forget = store.forgetAgentConfigGrant(FP_1);
    await Promise.all([forget, store.recordAgentConfigGrant(next)]);
    expect(await forget).toBe(true);
    expect(store.getAgentConfigGrants()).toEqual({ [FP_2]: next });

    const record = store.recordAgentConfigGrant(existing);
    const forgetAll = store.forgetAllAgentConfigGrants();
    await record;
    expect(await forgetAll).toBe(2);
    expect(store.getAgentConfigGrants()).toEqual({});
  });

  it('writes, forgets one (distinguishing absent/prototype keys), and finds latest per backend', () => {
    const g1 = makeGrant({ fingerprint: FP_1, backend: 'claude', grantedAt: 100 });
    const g2 = makeGrant({
      fingerprint: FP_2,
      backend: 'claude',
      grantedAt: 200,
      files: [{ name: 'CLAUDE.md', size: 50, digest: DIGEST_2 }]
    });

    let map = writeAgentConfigGrant({}, g1);
    map = writeAgentConfigGrant(map, g2);
    expect(latestGrantForBackend(map, 'claude')).toEqual(g2);
    expect(latestGrantForBackend(map, 'codex')).toBeNull();

    // Prototype keys must not match.
    expect(forgetAgentConfigGrant(map, 'toString')).toBeNull();
    expect(forgetAgentConfigGrant(map, '0'.repeat(64))).toBeNull();

    const afterForget = forgetAgentConfigGrant(map, FP_2);
    expect(afterForget).not.toBeNull();
    expect(Object.keys(afterForget!)).toEqual([FP_1]);
    expect(latestGrantForBackend(afterForget!, 'claude')).toEqual(g1);
  });

  it('S3: accepts grants with declared directory-prefix entries, Claude hook-referenced scripts, codex/agy entries, and up to 256 files', () => {
    const buildValid = (
      backend: 'claude' | 'codex' | 'agy',
      files: readonly AgentConfigGrantFileSummary[]
    ): AgentConfigGrant => ({
      fingerprint: computeAgentConfigFingerprint(
        backend,
        files.map((f) => ({ name: f.name, size: f.size, digest: f.digest, status: 'present' })),
        false
      ),
      backend,
      grantedAt: 1_700_000_000_000,
      files
    });

    // 1. Claude directory prefix + hook-referenced script alongside .claude/settings.json
    const claudeGrant = buildValid('claude', [
      { name: '.claude/settings.json', size: 100, digest: DIGEST_1 },
      { name: '.claude/skills/my-skill/SKILL.md', size: 50, digest: DIGEST_2 },
      { name: 'scripts/pre-tool.sh', size: 40, digest: DIGEST_1, source: 'hook-script' }
    ]);
    const readClaude = readAgentConfigGrants({ [claudeGrant.fingerprint]: claudeGrant });
    expect(readClaude.problems).toEqual([]);
    expect(readClaude.grants[claudeGrant.fingerprint]).toEqual(claudeGrant);

    // 2. Hook-referenced script without .claude/settings*.json or on non-claude backend is rejected
    const orphanHook = buildValid('claude', [
      { name: 'scripts/pre-tool.sh', size: 40, digest: DIGEST_1, source: 'hook-script' }
    ]);
    expect(readAgentConfigGrants({ [orphanHook.fingerprint]: orphanHook }).grants).toEqual({});

    const codexHook = buildValid('codex', [
      { name: '.codex/config.toml', size: 40, digest: DIGEST_1 },
      { name: 'scripts/evil.sh', size: 20, digest: DIGEST_2, source: 'hook-script' }
    ]);
    expect(readAgentConfigGrants({ [codexHook.fingerprint]: codexHook }).grants).toEqual({});

    // 3. Agy directory prefix + Codex config accepted
    const agyGrant = buildValid('agy', [
      { name: 'AGENTS.md', size: 10, digest: DIGEST_1 },
      { name: '.agents/skills/s1/SKILL.md', size: 20, digest: DIGEST_2 }
    ]);
    expect(readAgentConfigGrants({ [agyGrant.fingerprint]: agyGrant }).problems).toEqual([]);

    const codexGrant = buildValid('codex', [{ name: '.codex/config.toml', size: 32, digest: DIGEST_1 }]);
    expect(readAgentConfigGrants({ [codexGrant.fingerprint]: codexGrant }).problems).toEqual([]);

    // 4. Rejects depth > 4 under directory prefix and path traversal
    const tooDeep = buildValid('claude', [
      { name: '.claude/skills/a/b/c/d/e/f.md', size: 10, digest: DIGEST_1 }
    ]);
    expect(readAgentConfigGrants({ [tooDeep.fingerprint]: tooDeep }).grants).toEqual({});

    // 5. Count cap matches walk cap (256 accepted, 257 rejected)
    expect(MAX_AGENT_CONFIG_GRANT_FILES).toBe(256);
    const maxFiles: AgentConfigGrantFileSummary[] = Array.from({ length: 256 }, (_, idx) => ({
      name: `.claude/skills/skill-${idx}.md`,
      size: 16,
      digest: DIGEST_1
    }));
    const atCap = buildValid('claude', maxFiles);
    expect(readAgentConfigGrants({ [atCap.fingerprint]: atCap }).problems).toEqual([]);

    const overCap = buildValid('claude', [
      ...maxFiles,
      { name: '.claude/skills/skill-256.md', size: 16, digest: DIGEST_1 }
    ]);
    expect(readAgentConfigGrants({ [overCap.fingerprint]: overCap }).grants).toEqual({});
  });
});
