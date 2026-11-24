// Feature 020 T016 — `truncateDisplayEntryBody`: 4 KiB per-field cap,
// UTF-8 boundary snap, no mutation. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §5 +
// specs/020-phase-level-logs/research.md §6.

import { describe, expect, it } from 'vitest';
import { REDACTION_SENTINEL, SanitizedLogger } from '../../../../src/lib/logger';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
import { sanitizeDisplayEntryBody } from '../../../../src/services/phase-log/phase-log-sanitizer';
import { truncateDisplayEntryBody } from '../../../../src/services/phase-log/phase-log-truncator';

function makeEntry(overrides: Partial<PhaseLogDisplayEntry['body']>): PhaseLogDisplayEntry {
  return {
    seq: 0,
    kind: 'assistant-text',
    ts: null,
    body: overrides,
    bodyTruncated: null
  } as PhaseLogDisplayEntry;
}

describe('Feature 020 T016 — truncateDisplayEntryBody', () => {
  it('passes a small entry through unchanged with bodyTruncated null', () => {
    const e = makeEntry({ text: 'small body' });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.body.text).toBe('small body');
    expect(out.bodyTruncated).toBeNull();
  });

  it('truncates a single field that exceeds the cap and records originalLength', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: huge });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(Buffer.byteLength(out.body.text ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(out.bodyTruncated?.text?.originalLength).toBe(5000);
  });

  it('keeps fields under the cap untouched', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: 'small', toolResult: huge });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.body.text).toBe('small');
    expect(out.bodyTruncated?.text).toBeUndefined();
    expect(out.bodyTruncated?.toolResult?.originalLength).toBe(5000);
  });

  it('snaps slice to a UTF-8 char boundary so the output is valid UTF-8', () => {
    // Build a string that, in UTF-8, would land mid-codepoint at exactly 4096 bytes.
    // 'é' (U+00E9) encodes to 2 bytes (0xC3 0xA9). 2048 'é' = 4096 bytes;
    // we add one extra 'é' so the natural cut at byte 4096 would split the next 'é'.
    const s = 'é'.repeat(2049);
    const e = makeEntry({ text: s });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    const outText = out.body.text ?? '';
    // Valid UTF-8: re-encoding the JS string and asserting byte length ≤ cap.
    expect(Buffer.byteLength(outText, 'utf8')).toBeLessThanOrEqual(4096);
    // And the truncated string contains only whole 'é' characters.
    expect(outText.length * 2).toBe(Buffer.byteLength(outText, 'utf8'));
  });

  it('does not mutate the input entry', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: huge });
    const before = e.body.text;
    truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(e.body.text).toBe(before);
    expect(e.bodyTruncated).toBeNull();
  });

  it('truncates multiple fields independently', () => {
    const e = makeEntry({
      text: 'a'.repeat(5000),
      toolInput: 'b'.repeat(8192),
      toolResult: 'c'.repeat(100)
    });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.bodyTruncated?.text?.originalLength).toBe(5000);
    expect(out.bodyTruncated?.toolInput?.originalLength).toBe(8192);
    expect(out.bodyTruncated?.toolResult).toBeUndefined();
  });

  it('truncates multi-MiB fields without losing exact byte-length accounting or UTF-8 validity', () => {
    const huge = `${'é'.repeat(2049)}${'x'.repeat(3 * 1024 * 1024)}`;
    const expectedBytes = Buffer.byteLength(huge, 'utf8');
    const out = truncateDisplayEntryBody(makeEntry({ text: huge }), { perFieldBytes: 4096 });
    const outText = out.body.text ?? '';
    expect(Buffer.byteLength(outText, 'utf8')).toBeLessThanOrEqual(4096);
    expect(outText.length * 2).toBe(Buffer.byteLength(outText, 'utf8'));
    expect(out.bodyTruncated?.text?.originalLength).toBe(expectedBytes);
  });

  it('does not re-truncate an existing toolArguments truncation sentinel under a tiny perFieldBytes cap', () => {
    const sentinel = { __truncated: true, originalBytes: 12345 };
    const out = truncateDisplayEntryBody(makeEntry({ toolArguments: sentinel }), { perFieldBytes: 24 });
    expect(out.body.toolArguments).toEqual({ __truncated: true, originalBytes: 12345 });
    expect(out.bodyTruncated).toBeNull();
  });

  it('still truncates spoofed toolArguments with extra keys or prototype-inherited __truncated', () => {
    const withExtra = { __truncated: true, originalBytes: 10, payload: 'x'.repeat(100) };
    const extraOut = truncateDisplayEntryBody(makeEntry({ toolArguments: withExtra }), { perFieldBytes: 24 });
    const expectedExtraBytes = Buffer.byteLength(JSON.stringify(withExtra), 'utf8');
    expect(extraOut.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedExtraBytes });
    expect(extraOut.bodyTruncated?.toolArguments?.originalLength).toBe(expectedExtraBytes);

    const forgedProto = Object.assign(
      Object.create({ __truncated: true, originalBytes: 10 }) as Record<string, unknown>,
      { payload: 'y'.repeat(100) }
    );
    const protoOut = truncateDisplayEntryBody(
      makeEntry({ toolArguments: forgedProto as NonNullable<PhaseLogDisplayEntry['body']['toolArguments']> }),
      { perFieldBytes: 24 }
    );
    const expectedProtoBytes = Buffer.byteLength(JSON.stringify(forgedProto), 'utf8');
    expect(protoOut.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedProtoBytes });
    expect(protoOut.bodyTruncated?.toolArguments?.originalLength).toBe(expectedProtoBytes);
  });

  it('fails closed when toolArguments cannot be JSON-stringified (cyclic, BigInt, throwing or undefined toJSON) (SR-306-2)', () => {
    const perFieldBytes = 4096;
    const expectedFallbackBytes = perFieldBytes + 1;

    const cyclic: Record<string, unknown> = { label: 'loop' };
    cyclic['self'] = cyclic;

    const withBigInt: Record<string, unknown> = { count: BigInt(42) };

    const throwingToJson: Record<string, unknown> = {
      toJSON() {
        throw new Error('boom');
      }
    };

    const undefinedToJson: Record<string, unknown> = {
      toJSON() {
        return undefined;
      }
    };

    for (const unserializable of [cyclic, withBigInt, throwingToJson, undefinedToJson]) {
      const entry = makeEntry({
        toolArguments: unserializable as NonNullable<PhaseLogDisplayEntry['body']['toolArguments']>
      });
      const out = truncateDisplayEntryBody(entry, { perFieldBytes });
      expect(out.body.toolArguments).toEqual({
        __truncated: true,
        originalBytes: expectedFallbackBytes
      });
      expect(out.bodyTruncated).toEqual({
        toolArguments: { originalLength: expectedFallbackBytes }
      });
    }
  });

  it('caps oversized (>100 KiB) toolName at <= 128 bytes with UTF-8 boundary snap and records originalLength (R7-17-05)', () => {
    const hugeAscii = 'T'.repeat(120_000);
    const asciiOut = truncateDisplayEntryBody(makeEntry({ toolName: hugeAscii }), { perFieldBytes: 4096 });
    expect(Buffer.byteLength(asciiOut.body.toolName ?? '', 'utf8')).toBeLessThanOrEqual(128);
    expect(asciiOut.body.toolName?.length).toBe(128);
    expect(asciiOut.bodyTruncated?.toolName?.originalLength).toBe(120_000);

    const multiByte = 'é'.repeat(80); // 160 UTF-8 bytes
    const multiOut = truncateDisplayEntryBody(makeEntry({ toolName: multiByte }), { perFieldBytes: 4096 });
    expect(Buffer.byteLength(multiOut.body.toolName ?? '', 'utf8')).toBeLessThanOrEqual(128);
    expect((multiOut.body.toolName ?? '').length * 2).toBe(Buffer.byteLength(multiOut.body.toolName ?? '', 'utf8'));
    expect(multiOut.bodyTruncated?.toolName?.originalLength).toBe(160);
  });

  it('redacts secrets straddling byte 128 and ANSI/bidi-padded secrets BEFORE applying the 128-byte toolName cap (SR-312-1)', () => {
    const logger = new SanitizedLogger();
    const sanitize = (s: string): string => logger.sanitize(s);

    const ghToken = ['ghp', 'A'.repeat(36)].join('_');
    const npmToken = ['npm', 'B'.repeat(36)].join('_');
    const gcpKey = ['AIza', 'C'.repeat(35)].join('');
    const sgKey = ['SG', 'D'.repeat(22), 'E'.repeat(43)].join('.');
    const jwt = [
      ['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''),
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    ].join('.');

    const cases: ReadonlyArray<{ readonly label: string; readonly raw: string; readonly needle: string }> = [
      { label: 'ghp-straddle-128', raw: `${'A'.repeat(110)} ${ghToken}`, needle: 'ghp_' },
      { label: 'npm-straddle-128', raw: `${'B'.repeat(110)} ${npmToken}`, needle: 'npm_' },
      { label: 'aiza-straddle-128', raw: `${'C'.repeat(110)} ${gcpKey}`, needle: 'AIza' },
      { label: 'sg-straddle-128', raw: `${'D'.repeat(100)} ${sgKey}`, needle: 'SG.' },
      { label: 'jwt-straddle-128', raw: `${'E'.repeat(105)} ${jwt}`, needle: 'eyJ' },
      { label: 'ansi-padded-ghp', raw: `${'\u001b[31m'.repeat(24)}${ghToken}`, needle: 'ghp_' },
      { label: 'bidi-padded-sg', raw: `${'\u202e'.repeat(45)}${sgKey}`, needle: 'SG.' },
      { label: 'zwsp-padded-npm', raw: `${'\u200b'.repeat(45)}${npmToken}`, needle: 'npm_' },
      { label: 'ansi-padded-jwt', raw: `${'\u001b[31m'.repeat(24)}${jwt}`, needle: 'eyJ' }
    ];

    for (const { label, raw, needle } of cases) {
      const entry = makeEntry({ toolName: raw });
      const truncated = truncateDisplayEntryBody(entry, { perFieldBytes: 4096 });
      const sanitized = sanitizeDisplayEntryBody(truncated, sanitize);
      const outName = sanitized.body.toolName ?? '';

      expect(Buffer.byteLength(outName, 'utf8'), label).toBeLessThanOrEqual(128);
      expect(outName, label).not.toContain(needle);
      expect(outName, label).toContain(REDACTION_SENTINEL);
      expect(outName, label).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
      expect(truncated.bodyTruncated?.toolName?.originalLength, label).toBe(
        Buffer.byteLength(raw, 'utf8')
      );
    }

    // SR-A2 #1: delimiter secret-pull through truncateDisplayEntryBody + sanitizeDisplayEntryBody
    const dotPullToolName = `${['ghp', 'A'.repeat(4_548)].join('_')}.${['SG', 'B'.repeat(22), `${'C'.repeat(42)}Z`].join('.')}`;
    const dotPullTruncated = truncateDisplayEntryBody(makeEntry({ toolName: dotPullToolName }), {
      perFieldBytes: 4096,
      sanitize
    });
    const dotPullSanitized = sanitizeDisplayEntryBody(dotPullTruncated, sanitize);
    expect(dotPullSanitized.body.toolName).toBe(REDACTION_SENTINEL);
    expect(dotPullSanitized.body.toolName).not.toContain('SG.');
  });

  it('sanitizes secrets straddling perFieldBytes across all other capped fields before byte capping (SR-A2 #2 / CR-A2 #3)', () => {
    const logger = new SanitizedLogger();
    const customToken = ['CUSTOM', 'BOUNDARY', 'SECRET1234567890'].join('_');
    const sanitize = (s: string): string => logger.sanitize(s).replaceAll(customToken, REDACTION_SENTINEL);

    const skToken = ['sk', 'ant', 'api03', 'S'.repeat(36)].join('-');
    const ghToken = ['ghp', 'G'.repeat(36)].join('_');
    const fields = ['text', 'toolInput', 'toolResult', 'systemSummary', 'resultSummary'] as const;

    const payloads: ReadonlyArray<{ readonly label: string; readonly raw: string; readonly needle: string }> = [
      { label: 'sk-ascii-straddle', raw: `${'a'.repeat(4_080)} ${skToken}`, needle: 'sk-ant-' },
      { label: 'ghp-ascii-straddle', raw: `${'b'.repeat(4_080)} ${ghToken}`, needle: 'ghp_' },
      { label: 'custom-ascii-straddle', raw: `${'c'.repeat(4_080)} ${customToken}`, needle: 'CUSTOM_BOUNDARY' },
      { label: 'sk-multibyte-straddle', raw: `${'中'.repeat(1_360)} ${skToken}`, needle: 'sk-ant-' },
      { label: 'custom-accented-straddle', raw: `${'é'.repeat(2_040)} ${customToken}`, needle: 'CUSTOM_BOUNDARY' }
    ];

    for (const field of fields) {
      for (const { label, raw, needle } of payloads) {
        const entry = makeEntry({ [field]: raw });
        const truncated = truncateDisplayEntryBody(entry, { perFieldBytes: 4096, sanitize });
        const sanitized = sanitizeDisplayEntryBody(truncated, sanitize);
        const outValue = sanitized.body[field] ?? '';

        expect(Buffer.byteLength(outValue, 'utf8'), `${field}:${label}`).toBeLessThanOrEqual(4096);
        expect(outValue, `${field}:${label}`).not.toContain(needle);
        expect(outValue, `${field}:${label}`).toContain(REDACTION_SENTINEL);
        expect(truncated.bodyTruncated?.[field]?.originalLength, `${field}:${label}`).toBe(
          Buffer.byteLength(raw, 'utf8')
        );
      }
    }
  });

  it('blocks lookahead-boundary secret-pull, oversized JWTs, and one-line PEM blocks in capped body fields (SR-A2 #2)', () => {
    const logger = new SanitizedLogger();
    const sanitize = (s: string): string => logger.sanitize(s);

    const spacedLookaheadPull = `${['ghp', 'A'.repeat(8_170)].join('_')} ${['sk', 'ant', 'SECRET12345678901234567890'].join('-')}`;
    const spacedOut = truncateDisplayEntryBody(makeEntry({ text: spacedLookaheadPull }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(spacedOut.body.text).toBe(REDACTION_SENTINEL);
    expect(spacedOut.body.text).not.toContain('sk-ant-');
    expect(spacedOut.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(spacedLookaheadPull, 'utf8'));

    const dotLookaheadPull = `${['ghp', 'A'.repeat(8_130)].join('_')}.${['SG', 'B'.repeat(22), `${'C'.repeat(42)}Z`].join('.')}`;
    const dotOut = truncateDisplayEntryBody(makeEntry({ toolResult: dotLookaheadPull }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(dotOut.body.toolResult).toBe(REDACTION_SENTINEL);
    expect(dotOut.body.toolResult).not.toContain('SG.');

    const oversizedJwt = [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), 'A'.repeat(8_300), 'sig12345678'].join('.');
    const jwtOut = truncateDisplayEntryBody(makeEntry({ toolInput: oversizedJwt }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(jwtOut.body.toolInput).toBe(REDACTION_SENTINEL);
    expect(jwtOut.body.toolInput).not.toContain('eyJ');

    const pemBegin = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const pemEnd = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const oversizedOneLinePem = `${pemBegin}${'A'.repeat(8_300)}${pemEnd}`;
    const pemOut = truncateDisplayEntryBody(makeEntry({ systemSummary: oversizedOneLinePem }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(pemOut.body.systemSummary).toBe(REDACTION_SENTINEL);
    expect(pemOut.body.systemSummary).not.toContain('BEGIN');
    expect(pemOut.body.systemSummary).not.toContain('AAAA');
  });

  it('blocks oversized JWT dead zones, glued-prefix headers, sentinel injection, and custom-sanitize toolName secret-pull (SR-A3 #1, #2, #3)', () => {
    const logger = new SanitizedLogger();
    const sanitize = (s: string): string => logger.sanitize(s);
    const jwtPayload = ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0'].join('');
    const jwtSig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    // SR-A3 #1: post-dot 0..5 dead zone at perFieldBytes=4096 (lookaheadCap=8192)
    const jwtTrunc = `${['eyJ', 'A'.repeat(8_186)].join('')}.${jwtPayload}.${jwtSig}`;
    const jwtTruncOut = truncateDisplayEntryBody(makeEntry({ text: jwtTrunc }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(jwtTruncOut.body.text).toBe(REDACTION_SENTINEL);
    expect(jwtTruncOut.body.text).not.toContain('eyJ');
    expect(jwtTruncOut.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(jwtTrunc, 'utf8'));

    for (let postDotChars = 0; postDotChars <= 5; postDotChars += 1) {
      const headerFill = 8_192 - 3 - 1 - postDotChars;
      const deadZoneJwt = `${['eyJ', 'A'.repeat(headerFill)].join('')}.${jwtPayload}.${jwtSig}`;
      const out = truncateDisplayEntryBody(makeEntry({ toolResult: deadZoneJwt }), {
        perFieldBytes: 4096,
        sanitize
      });
      expect(out.body.toolResult, `postDotChars=${postDotChars}`).toBe(REDACTION_SENTINEL);
      expect(out.body.toolResult, `postDotChars=${postDotChars}`).not.toContain('eyJ');
    }

    // SR-A3 #1: glued-prefix JWT header in body field and toolName
    const prefJwtBody = `${['jwt', `eyJ${'A'.repeat(8_300)}`].join('_')}.${jwtPayload}.${jwtSig}`;
    const prefBodyOut = truncateDisplayEntryBody(makeEntry({ toolInput: prefJwtBody }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(prefBodyOut.body.toolInput).toBe(REDACTION_SENTINEL);
    expect(prefBodyOut.body.toolInput).not.toContain('eyJ');

    const prefJwtTool = `${['jwt', `eyJ${'A'.repeat(5_000)}`].join('_')}.${jwtPayload}.${jwtSig}`;
    const prefToolOut = truncateDisplayEntryBody(makeEntry({ toolName: prefJwtTool }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(prefToolOut.body.toolName).toBe(REDACTION_SENTINEL);
    expect(prefToolOut.body.toolName).not.toContain('eyJ');

    // SR-A3 #2: sentinel-injection single-blob secret-pull in body (perFieldBytes=128 & 4096) and toolName
    const secretPass = ['MY', 'SECRET', 'PASS'].join('_');
    const urlPullBody = `${['sk', 'ant', 'A'.repeat(4_170)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullBody128Out = truncateDisplayEntryBody(makeEntry({ text: urlPullBody }), {
      perFieldBytes: 128,
      sanitize
    });
    expect(urlPullBody128Out.body.text).toBe(REDACTION_SENTINEL);
    expect(urlPullBody128Out.body.text).not.toContain(secretPass);
    expect(urlPullBody128Out.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(urlPullBody, 'utf8'));

    const urlPullBody4096 = `${['sk', 'ant', 'A'.repeat(8_140)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullBody4096Out = truncateDisplayEntryBody(makeEntry({ text: urlPullBody4096 }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(urlPullBody4096Out.body.text).toBe(REDACTION_SENTINEL);
    expect(urlPullBody4096Out.body.text).not.toContain(secretPass);
    expect(urlPullBody4096Out.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(urlPullBody4096, 'utf8'));

    const urlPullTitle = `${['sk', 'ant', 'A'.repeat(4_050)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullTitleOut = truncateDisplayEntryBody(makeEntry({ toolName: urlPullTitle }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(urlPullTitleOut.body.toolName).toBe(`${REDACTION_SENTINEL},https://u:${REDACTION_SENTINEL}@host.com`);
    expect(urlPullTitleOut.body.toolName).not.toContain(secretPass);

    const urlPullTitle4096 = `${['sk', 'ant', 'A'.repeat(4_560)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullTitle4096Out = truncateDisplayEntryBody(makeEntry({ toolName: urlPullTitle4096 }), {
      perFieldBytes: 4096,
      sanitize
    });
    expect(urlPullTitle4096Out.body.toolName).toBe(REDACTION_SENTINEL);
    expect(urlPullTitle4096Out.body.toolName).not.toContain(secretPass);

    // SR-A3 #3: custom-sanitize toolName secret-pull across the 4096 pre-cap boundary
    const customSanitize = (s: string): string =>
      logger.sanitize(s).replace(/CUSTOM_[A-Za-z0-9]{16,}/g, REDACTION_SENTINEL);
    const customLeaked = ['CUSTOM', 'LEAKED12345678901234'].join('_');
    const customTool = `${['CUSTOM', 'A'.repeat(4_075)].join('_')} ${customLeaked}`;
    expect(customTool.length).toBe(4_110);

    const customTruncated = truncateDisplayEntryBody(makeEntry({ toolName: customTool }), {
      perFieldBytes: 4096,
      sanitize: customSanitize
    });
    const customSanitized = sanitizeDisplayEntryBody(customTruncated, customSanitize);
    expect(customSanitized.body.toolName).toBe(`${REDACTION_SENTINEL} ${REDACTION_SENTINEL}`);
    expect(customSanitized.body.toolName).not.toContain('CUSTOM_LEAKED');
    expect(customTruncated.bodyTruncated?.toolName?.originalLength).toBe(Buffer.byteLength(customTool, 'utf8'));

    const singleBlobCustomComma = `${['CUSTOM', 'A'.repeat(4_580)].join('_')},${customLeaked}`;
    const singleBlobCustomDot = `${['CUSTOM', 'A'.repeat(4_580)].join('_')}.${customLeaked}`;
    for (const rawName of [singleBlobCustomComma, singleBlobCustomDot]) {
      const trunc = truncateDisplayEntryBody(makeEntry({ toolName: rawName }), {
        perFieldBytes: 4096,
        sanitize: customSanitize
      });
      const clean = sanitizeDisplayEntryBody(trunc, customSanitize);
      expect(clean.body.toolName).toBe(REDACTION_SENTINEL);
      expect(clean.body.toolName).not.toContain('CUSTOM_LEAKED');
      expect(trunc.bodyTruncated?.toolName?.originalLength).toBe(Buffer.byteLength(rawName, 'utf8'));
    }
  });
});
