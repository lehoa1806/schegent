import { describe, expect, it } from 'vitest';
import {
  forgetAgentConfigGrant,
  latestGrantForBackend,
  readAgentConfigGrants,
  writeAgentConfigGrant,
  type AgentConfigGrant
} from '../../../src/state/agent-config-grants';

const FP_1 = '1'.repeat(64);
const FP_2 = '2'.repeat(64);
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
});
