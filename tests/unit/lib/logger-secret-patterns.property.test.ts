// Property-based fuzz coverage for SanitizedLogger.
//
// The 11 SECRET_PATTERNS regexes in `src/lib/logger.ts` are the
// single source of truth for redaction across the host. Unit tests
// elsewhere cover the happy path; this file pins several structural
// properties that any future evolution of the pattern set must
// preserve. To avoid adding a `fast-check` dev dep, we use a
// deterministic seeded PRNG so failures are reproducible.

import { describe, it, expect } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';

// ---- Deterministic seeded PRNG (mulberry32) ---------------------------------
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, maxExclusive: number): number {
  return min + Math.floor(rng() * (maxExclusive - min));
}

function randAlnum(rng: () => number, len: number): string {
  const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPH[randInt(rng, 0, ALPH.length)];
  }
  return out;
}

// Each generator emits a string that SHOULD trigger SECRET_PATTERNS redaction.
const SECRET_GENERATORS: ReadonlyArray<(rng: () => number) => string> = [
  (rng) => `sk-ant-${randAlnum(rng, randInt(rng, 25, 60))}`,
  (rng) => `sk-${randAlnum(rng, randInt(rng, 25, 60))}`,
  (rng) => `ghp_${randAlnum(rng, randInt(rng, 35, 50))}`,
  (rng) => `github_pat_${randAlnum(rng, randInt(rng, 30, 60))}`,
  (rng) => `xoxb-${randAlnum(rng, randInt(rng, 15, 40))}`,
  (rng) => `xoxp-${randAlnum(rng, randInt(rng, 15, 40))}`,
  (rng) => `AKIA${randAlnum(rng, 16).toUpperCase().replace(/[^0-9A-Z]/g, 'A')}`,
  (rng) => `Bearer ${randAlnum(rng, randInt(rng, 20, 50))}`,
  (rng) => `authorization: ${randAlnum(rng, randInt(rng, 20, 50))}`,
  (rng) => `api_key=${randAlnum(rng, randInt(rng, 20, 40))}`,
  (rng) => `api-key: ${randAlnum(rng, randInt(rng, 20, 40))}`,
  (rng) => {
    const head = randAlnum(rng, randInt(rng, 10, 30));
    const mid = randAlnum(rng, randInt(rng, 10, 30));
    const tail = randAlnum(rng, randInt(rng, 10, 30));
    return `eyJ${head}.${mid}.${tail}`;
  },
  (rng) => `SECRET_FOO=${randAlnum(rng, randInt(rng, 12, 40))}`,
  (rng) => `TOKEN_BAR=${randAlnum(rng, randInt(rng, 12, 40))}`,
  (rng) => `PASSWORD=${randAlnum(rng, randInt(rng, 12, 40))}`,
  (rng) => `API_KEY=${randAlnum(rng, randInt(rng, 12, 40))}`
];

function randomSecret(rng: () => number): string {
  const gen = SECRET_GENERATORS[randInt(rng, 0, SECRET_GENERATORS.length)];
  return gen(rng);
}

function randomBenignString(rng: () => number, len = randInt(rng, 0, 60)): string {
  // Whitespace + punctuation + alphanumerics — nothing that should
  // trigger a pattern by itself.
  const CHARS = ' abcdefghijklmnopqrstuvwxyz0123456789 .,!?-_';
  let out = '';
  for (let i = 0; i < len; i++) out += CHARS[randInt(rng, 0, CHARS.length)];
  return out;
}

const ITERATIONS = 200;
const REDACTED = '[REDACTED]';

describe('SanitizedLogger.sanitize — property-based coverage', () => {
  // Several SECRET_PATTERNS use `\b` word boundaries (ghp_, github_pat_,
  // xox*, AKIA*, KEY=VALUE). They only match when the token is preceded
  // and followed by a non-word character. Real log lines always have
  // whitespace around them; the test reproduces that realistic context
  // by space-padding the secret rather than concatenating it directly
  // against alphanumeric noise.
  const pad = (rng: () => number, s: string) =>
    `${randomBenignString(rng)} ${s} ${randomBenignString(rng)}`;

  it('redacts every generated secret pattern variant', () => {
    const rng = makeRng(0x1337);
    const logger = new SanitizedLogger();
    for (let i = 0; i < ITERATIONS; i++) {
      const secret = randomSecret(rng);
      const surrounded = pad(rng, secret);
      const sanitized = logger.sanitize(surrounded);
      expect(
        sanitized.includes(secret),
        `iter ${i}: secret "${secret.slice(0, 12)}..." survived sanitize: "${sanitized.slice(0, 80)}"`
      ).toBe(false);
      expect(sanitized).toContain(REDACTED);
    }
  });

  it('is idempotent on already-sanitized text (no double-redaction inflation)', () => {
    const rng = makeRng(0xc0de);
    const logger = new SanitizedLogger();
    for (let i = 0; i < ITERATIONS; i++) {
      const text = pad(rng, randomSecret(rng));
      const once = logger.sanitize(text);
      const twice = logger.sanitize(once);
      expect(twice).toBe(once);
    }
  });

  it('passes benign strings through unchanged', () => {
    const rng = makeRng(0xbeef);
    const logger = new SanitizedLogger();
    for (let i = 0; i < ITERATIONS; i++) {
      const text = randomBenignString(rng, randInt(rng, 5, 120));
      const sanitized = logger.sanitize(text);
      // Benign strings should never produce REDACTED tokens.
      expect(sanitized.includes(REDACTED), `benign collision: "${text}"`).toBe(false);
    }
  });
});

describe('SanitizedLogger.sanitizeRecord — structural closure', () => {
  it('redacts secrets in deeply nested object trees', () => {
    const rng = makeRng(0xface);
    const logger = new SanitizedLogger();
    const secrets: string[] = [];
    function buildTree(depth: number): unknown {
      if (depth <= 0) {
        const s = randomSecret(rng);
        secrets.push(s);
        return s;
      }
      const fanout = randInt(rng, 1, 4);
      const node: Record<string, unknown> = {};
      for (let i = 0; i < fanout; i++) {
        node[`k${i}`] = buildTree(depth - 1);
      }
      // Mix in an array branch too.
      node.arr = Array.from({ length: randInt(rng, 0, 3) }, () => buildTree(depth - 1));
      return node;
    }
    for (let i = 0; i < 25; i++) {
      secrets.length = 0;
      const tree = buildTree(randInt(rng, 2, 5));
      const cleaned = logger.sanitizeRecord({ root: tree });
      const serialized = JSON.stringify(cleaned);
      for (const s of secrets) {
        expect(serialized.includes(s), `iter ${i}: secret survived: ${s.slice(0, 12)}`).toBe(false);
      }
    }
  });

  it('handles cycles via [CIRCULAR] sentinel without throwing', () => {
    const logger = new SanitizedLogger();
    type Node = { value: string; child?: Node };
    const a: Node = { value: 'sk-ant-' + 'A'.repeat(30) };
    const b: Node = { value: 'ghp_' + 'B'.repeat(40), child: a };
    a.child = b; // cycle
    const cleaned = logger.sanitizeRecord({ a } as unknown as Record<string, unknown>);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).toContain('[CIRCULAR]');
  });

  it('drops functions / symbols / bigints rather than serializing them', () => {
    const logger = new SanitizedLogger();
    const input = {
      keep: 'plain',
      func: () => 1,
      sym: Symbol('x'),
      big: BigInt(123),
      nested: { keep: 'plain2', func: () => 2 }
    } as unknown as Record<string, unknown>;
    const cleaned = logger.sanitizeRecord(input) as Record<string, unknown>;
    expect(cleaned).toEqual({ keep: 'plain', nested: { keep: 'plain2' } });
  });
});
