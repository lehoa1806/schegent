import { describe, it, expect, vi } from 'vitest';
import { SanitizedLogger, type LogSink } from '../../../src/lib/logger';

function makeSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string) {
      lines.push(line);
    }
  };
}

describe('SanitizedLogger.sanitize', () => {
  const logger = new SanitizedLogger();

  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const out = logger.sanitize('config: sk-ant-api03_abcdefghijklmnopqrstuvwxyz12345');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-api03_abcdefghijklmnopqrstuvwxyz12345');
  });

  it('redacts Bearer tokens', () => {
    const out = logger.sanitize('Authorization: Bearer abc123def456ghi789jkl');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts api_key= patterns', () => {
    const out = logger.sanitize('api_key=abcdefghijklmnopqrstuv');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const out = logger.sanitize('token=eyJabcdefgh.eyJpayloadx.signature');
    expect(out).toContain('[REDACTED]');
  });

  it('preserves benign strings', () => {
    expect(logger.sanitize('hello world')).toBe('hello world');
  });

  it('handles multiple secrets in one string', () => {
    const out = logger.sanitize('Bearer abcdefghijklmnopqr and sk-ant-test_zzzzzzzzzzzzzzzzzzzzzz');
    const matches = out.match(/\[REDACTED\]/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('redacts Google Cloud API keys (AIza...)', () => {
    const out = logger.sanitize('GOOGLE_API_KEY=AIzaSyA1B2C3D4E5F6G7H8I9J0KaLbMcNdOePfQg');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AIzaSyA1B2C3D4E5F6G7H8I9J0KaLbMcNdOePfQg');
  });

  it('redacts Google OAuth access tokens (ya29.…)', () => {
    const out = logger.sanitize('token: ya29.A0Ae4lvCabcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ya29.A0Ae4lvCabcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts Stripe live secret keys', () => {
    const out = logger.sanitize('STRIPE=sk_live_abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts Stripe restricted keys (rk_live_)', () => {
    const out = logger.sanitize('rk_live_RAabcdefghijklmnopqrstu');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('rk_live_RAabcdefghijklmnopqrstu');
  });

  it('redacts OpenAI sk-proj- and sk-svcacct- variants', () => {
    const a = logger.sanitize('sk-proj-abcdefghijklmnopqrstuvwxyz1234');
    const b = logger.sanitize('sk-svcacct-abcdefghijklmnopqrstuvwxyz1234');
    expect(a).toContain('[REDACTED]');
    expect(b).toContain('[REDACTED]');
  });

  it('does not match sk- inside an unrelated word boundary', () => {
    // `worksk-` was previously susceptible to partial-match noise; the
    // word-boundary anchor on the `sk-` family rules it out.
    expect(logger.sanitize('worksk-irrelevanttext1234567890')).toBe('worksk-irrelevanttext1234567890');
  });

  it('preserves benign Google-prefixed strings that are not API keys', () => {
    // AIza requires 35 trailing chars from the API-key alphabet; "AIzaShort" is benign.
    expect(logger.sanitize('AIzaShort')).toBe('AIzaShort');
  });

  it('redacts AWS temporary session access key IDs (ASIA...)', () => {
    // STS / assumed-role keys carry the same blast radius as long-lived
    // AKIA credentials for their lifetime and must redact identically.
    // The shape is `ASIA` + exactly 16 uppercase alphanumerics.
    const out = logger.sanitize('aws_access_key_id=ASIAY44QH2Y4SAMPLE00');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ASIAY44QH2Y4SAMPLE00');
  });

  it('does not redact ASIA-prefixed strings that are not session keys', () => {
    // ASIA needs 16 trailing uppercase alphanumerics; "ASIAFoo" is benign.
    expect(logger.sanitize('ASIAFoo')).toBe('ASIAFoo');
  });

  it('redacts PEM RSA private key headers', () => {
    const out = logger.sanitize(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA…\n-----END RSA PRIVATE KEY-----'
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('redacts PEM OPENSSH private key headers', () => {
    const out = logger.sanitize(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk…\n'
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    // FR-R3-048 — the assertion that would have caught H-07. The line above
    // passes against output still containing every byte of the key.
    expect(out).not.toContain('-----END');
  });

  it('redacts PEM PGP private key headers', () => {
    const out = logger.sanitize(
      '-----BEGIN PGP PRIVATE KEY-----\nlQHYBGZ…\n-----END PGP PRIVATE KEY-----'
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('-----BEGIN PGP PRIVATE KEY-----');
    // FR-R3-048 — added, not substituted. The assertions above are kept because
    // this spelling is what the pre-change pattern matched and the hard rule
    // forbids weakening the set; these two are the ones that would have caught
    // H-07, and they check the body and the footer rather than the header.
    expect(out).not.toContain('lQHYBGZ…');
    expect(out).not.toContain('-----END');
  });

  it('redacts the standard PGP armor GnuPG actually writes', () => {
    // FR-R3-048 (H-07), research finding 1. The case above uses `PGP PRIVATE KEY`
    // — a nonstandard label — so it exercised the one PGP spelling the old
    // pattern happened to match and never touched this one, which it missed
    // entirely: `-----BEGIN PGP PRIVATE KEY BLOCK-----` did not match at all, so
    // an exported GPG private key passed through untouched, header included. A
    // test that picks the one input its subject handles is worse than no test,
    // because it is counted as coverage.
    const out = logger.sanitize(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQHYBGZstandardArmorBody\n-----END PGP PRIVATE KEY BLOCK-----'
    );
    expect(out).toContain('[REDACTED]');
    expect(out.includes('lQHYBGZstandardArmorBody')).toBe(false);
    expect(out.includes('-----END')).toBe(false);
  });

  it('preserves PUBLIC key headers (not secrets)', () => {
    // Public keys are explicitly intended to be shareable.
    const input = '-----BEGIN PUBLIC KEY-----';
    expect(logger.sanitize(input)).toBe(input);
  });

  it('redacts X-API-Key header style', () => {
    const out = logger.sanitize('X-API-Key: abcdefghijklmnopqrstuv');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('redacts x_api_key= environment style', () => {
    const out = logger.sanitize('x_api_key=abcdefghijklmnopqrstuv');
    expect(out).toContain('[REDACTED]');
  });
});

describe('SanitizedLogger.info/warn/error', () => {
  it('writes timestamped lines to all sinks', () => {
    const a = makeSink();
    const b = makeSink();
    const logger = new SanitizedLogger([a, b]);
    logger.info('hello');
    expect(a.lines).toHaveLength(1);
    expect(b.lines).toHaveLength(1);
    expect(a.lines[0]).toContain('INFO');
    expect(a.lines[0]).toContain('hello');
  });

  it('sanitizes secrets before writing', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.warn('Bearer abcdefghijklmnopqrst');
    expect(sink.lines[0]).toContain('[REDACTED]');
    expect(sink.lines[0]).not.toContain('abcdefghijklmnopqrst');
  });

  it('does not propagate sink failures', () => {
    const failing: LogSink = {
      appendLine: vi.fn(() => {
        throw new Error('disk full');
      })
    };
    const sink = makeSink();
    const logger = new SanitizedLogger([failing, sink]);
    expect(() => logger.error('test')).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });

  it('records WARN level', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.warn('something');
    expect(sink.lines[0]).toContain('WARN');
  });

  it('records ERROR level', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.error('boom');
    expect(sink.lines[0]).toContain('ERROR');
  });
});

describe('SanitizedLogger.debug — Feature 019', () => {
  it('writes DEBUG-level lines to every registered sink', () => {
    const a = makeSink();
    const b = makeSink();
    const logger = new SanitizedLogger([a, b]);
    logger.debug('phase-runner.iteration-tick');
    expect(a.lines).toHaveLength(1);
    expect(b.lines).toHaveLength(1);
    expect(a.lines[0]).toContain('DEBUG');
    expect(a.lines[0]).toContain('phase-runner.iteration-tick');
  });

  it('flows debug records through addSink() registration', () => {
    const logger = new SanitizedLogger();
    const sink = makeSink();
    logger.addSink(sink);
    logger.debug('queue-manager.enqueue');
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('DEBUG');
  });

  it('serializes the context object into the message', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.debug('phase-runner.lock-acquired', {
      pipelineId: 'std',
      phaseId: 'plan',
      waitMs: 12
    });
    expect(sink.lines[0]).toContain('phase-runner.lock-acquired');
    expect(sink.lines[0]).toContain('"pipelineId":"std"');
    expect(sink.lines[0]).toContain('"waitMs":12');
  });

  it('sanitizes secrets that leak into context fields', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.debug('auth-debug', {
      header: 'Bearer abcdefghijklmnopqrst'
    });
    expect(sink.lines[0]).toContain('[REDACTED]');
    expect(sink.lines[0]).not.toContain('abcdefghijklmnopqrst');
  });

  it('handles a missing context (info-style call site)', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.debug('plain-message');
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('DEBUG');
    expect(sink.lines[0]).toMatch(/plain-message\s*$/);
  });

  it('does not propagate sink failures from debug emits', () => {
    const failing: LogSink = {
      appendLine: vi.fn(() => {
        throw new Error('disk full');
      })
    };
    const sink = makeSink();
    const logger = new SanitizedLogger([failing, sink]);
    expect(() => logger.debug('test', { k: 'v' })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });

  it('does not regress INFO/WARN/ERROR formatting', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    logger.debug('d');
    expect(sink.lines).toHaveLength(4);
    expect(sink.lines[0]).toContain('INFO a');
    expect(sink.lines[1]).toContain('WARN b');
    expect(sink.lines[2]).toContain('ERROR c');
    expect(sink.lines[3]).toContain('DEBUG d');
  });

  it('falls back to context-serialize-error on cyclic context', () => {
    const sink = makeSink();
    const logger = new SanitizedLogger([sink]);
    const cycle: Record<string, unknown> = { name: 'cycle' };
    cycle.self = cycle;
    expect(() => logger.debug('cyclic', cycle)).not.toThrow();
    expect(sink.lines[0]).toContain('context-serialize-error');
  });
});

describe('SanitizedLogger.sanitizeRecord — Feature 043 structural visitor', () => {
  const logger = new SanitizedLogger();

  it('returns a structurally-equal record for plain string + number leaves', () => {
    const input = { msg: 'hello', count: 7, ok: true, none: null };
    const out = logger.sanitizeRecord(input);
    expect(out).toEqual({ msg: 'hello', count: 7, ok: true, none: null });
  });

  it('redacts string leaves via SECRET_PATTERNS at every depth', () => {
    const input = {
      top: 'Bearer abcdefghijklmnopqrst',
      nested: {
        header: 'authorization: Bearer aaaaaaaaaaaaaaaaaaaa',
        deeper: { tail: 'sk-ant-zzzzzzzzzzzzzzzzzzzzzz' }
      }
    };
    const out = logger.sanitizeRecord(input);
    expect(out.top).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.header).toContain('[REDACTED]');
    const deeper = nested.deeper as Record<string, unknown>;
    expect(deeper.tail).toBe('[REDACTED]');
  });

  it('handles a string containing a JSON-corrupting quote without throwing', () => {
    const input = { quoted: 'value with "quote" and \\ backslash' };
    const out = logger.sanitizeRecord(input);
    expect(out.quoted).toBe('value with "quote" and \\ backslash');
  });

  it('preserves number / boolean / null primitives identity-equal', () => {
    const sentinel = Symbol('not-touched');
    const input: Record<string, unknown> = {
      duration: 1500,
      exitCode: 0,
      flag: true,
      none: null,
      _ignore: sentinel
    };
    const out = logger.sanitizeRecord(input);
    expect(out.duration).toBe(1500);
    expect(out.exitCode).toBe(0);
    expect(out.flag).toBe(true);
    expect(out.none).toBe(null);
  });

  it('preserves array order and per-element types', () => {
    const input = { items: ['a', 1, false, null, { k: 'v' }] };
    const out = logger.sanitizeRecord(input);
    expect(out.items).toEqual(['a', 1, false, null, { k: 'v' }]);
  });

  it('tolerates cyclic objects and replaces the cycle with [CIRCULAR]', () => {
    const a: Record<string, unknown> = { name: 'a', tail: 'safe' };
    a.self = a;
    expect(() => logger.sanitizeRecord(a)).not.toThrow();
    const out = logger.sanitizeRecord(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.tail).toBe('safe');
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('tolerates cyclic arrays and replaces the cycle with [CIRCULAR]', () => {
    const arr: unknown[] = ['head'];
    arr.push(arr);
    const wrap = { items: arr };
    expect(() => logger.sanitizeRecord(wrap)).not.toThrow();
    const out = logger.sanitizeRecord(wrap);
    const items = out.items as unknown[];
    expect(items[0]).toBe('head');
    expect(items[1]).toBe('[CIRCULAR]');
  });

  it('drops function / symbol / bigint leaves on copy (mirrors JSON.stringify)', () => {
    const input: Record<string, unknown> = {
      keep: 'visible',
      drop_fn: () => 1,
      drop_sym: Symbol('s'),
      drop_big: BigInt(10)
    };
    const out = logger.sanitizeRecord(input);
    expect(out.keep).toBe('visible');
    expect(Object.keys(out)).toEqual(['keep']);
  });

  it('drops function / symbol / bigint elements from arrays', () => {
    const fn = (): number => 1;
    const sym = Symbol('s');
    const input = { items: ['a', fn, sym, BigInt(5), 'b'] };
    const out = logger.sanitizeRecord(input);
    expect(out.items).toEqual(['a', 'b']);
  });

  it('does not corrupt structure when a string would have broken JSON shape', () => {
    const input = { weird: '"":"value":,' };
    const out = logger.sanitizeRecord(input);
    expect(out.weird).toBe('"":"value":,');
  });

  it('returns a fresh object (not the same reference as input)', () => {
    const input = { a: 1 };
    const out = logger.sanitizeRecord(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});
