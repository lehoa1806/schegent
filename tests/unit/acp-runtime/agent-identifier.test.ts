// FR-R7-17 (R7-17-05) — unit tests for ACP identifier validation and bounded agent title sanitization.
import { describe, expect, it } from 'vitest';

import {
  AGENT_DISPLAY_TITLE_MAX_CHARS,
  AGENT_DISPLAY_TITLE_PRE_CAP_CHARS,
  isAgentIdentifier,
  isSafeProviderSessionId,
  sanitizeAgentDisplayTitle
} from '../../../src/services/acp-runtime/agent-identifier';

describe('agent-identifier', () => {
  describe('isAgentIdentifier', () => {
    it('accepts spaces, colons, slashes, non-ASCII printable characters, and 256 UTF-16 units', () => {
      expect(isAgentIdentifier('session:alpha / beta @ 42')).toBe(true);
      expect(isAgentIdentifier('세션-識別子:αβγ')).toBe(true);
      expect(isAgentIdentifier('a'.repeat(256))).toBe(true);
    });

    it('rejects empty, >256 chars, Cc, Cf, Cs, Zl, and Zp characters', () => {
      expect(isAgentIdentifier('')).toBe(false);
      expect(isAgentIdentifier('a'.repeat(257))).toBe(false);
      expect(isAgentIdentifier('bad\nline')).toBe(false);
      expect(isAgentIdentifier('bad\u001b[31m')).toBe(false);
      expect(isAgentIdentifier('bad\u202eoverride')).toBe(false);
      expect(isAgentIdentifier('bad\u2066isolate')).toBe(false);
      expect(isAgentIdentifier('bad\u200emark')).toBe(false);
      expect(isAgentIdentifier('bad\u2028sep')).toBe(false);
      expect(isAgentIdentifier('bad\u2029sep')).toBe(false);
      expect(isAgentIdentifier('bad\ud800surrogate')).toBe(false);
    });
  });

  describe('isSafeProviderSessionId', () => {
    it('accepts strict non-option provider IDs and refuses leading dashes or whitespace', () => {
      expect(isSafeProviderSessionId('sess_01:abc-9.x')).toBe(true);
      expect(isSafeProviderSessionId('-flag')).toBe(false);
      expect(isSafeProviderSessionId('has space')).toBe(false);
    });
  });

  describe('sanitizeAgentDisplayTitle', () => {
    it('returns null for non-string, empty, or control-only inputs', () => {
      expect(sanitizeAgentDisplayTitle(null)).toBeNull();
      expect(sanitizeAgentDisplayTitle(undefined)).toBeNull();
      expect(sanitizeAgentDisplayTitle(42)).toBeNull();
      expect(sanitizeAgentDisplayTitle('')).toBeNull();
      expect(sanitizeAgentDisplayTitle('   \n\t\r  ')).toBeNull();
      expect(sanitizeAgentDisplayTitle('\u001b[31m\u202e\u2066\u200f\u2028\u2029')).toBeNull();
    });

    it('strips ANSI CSI/OSC sequences, controls, bidi overrides/isolates/marks, and line separators', () => {
      const hostile =
        '\u001b[31mRun\u001b[0m \u001b]0;spoof-title\u0007\u202eshell\u202c ' +
        '\u2066cmd\u2069\u200e\u200f\u061c\r\nnext\u2028line\u2029end\u0007\ud800';
      const cleaned = sanitizeAgentDisplayTitle(hostile);
      expect(cleaned).toBe('Run shell cmd next line end');
      expect(cleaned).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    });

    it('redacts embedded secrets through SanitizedLogger without forking SECRET_PATTERNS', () => {
      const fakeOpenAi = ['sk', 'proj', 'A'.repeat(28)].join('-');
      const fakeGithub = ['ghp', 'B'.repeat(36)].join('_');
      const cleaned = sanitizeAgentDisplayTitle(`Deploy with ${fakeOpenAi} and ${fakeGithub}`);
      expect(cleaned).not.toBeNull();
      expect(cleaned).not.toContain(fakeOpenAi);
      expect(cleaned).not.toContain(fakeGithub);
      expect(cleaned).toContain('[REDACTED]');
    });

    it('bounds oversized (>100 KiB) titles safely without splitting surrogate pairs', () => {
      const huge = `${'x'.repeat(150_000)}`;
      const bounded = sanitizeAgentDisplayTitle(huge);
      expect(bounded).not.toBeNull();
      expect(bounded!.length).toBe(AGENT_DISPLAY_TITLE_MAX_CHARS);

      const withEmojiAtBoundary = `${'a'.repeat(127)}🚀tail`;
      const emojiSafe = sanitizeAgentDisplayTitle(withEmojiAtBoundary, 128);
      expect(emojiSafe).toBe('a'.repeat(127));
      expect(emojiSafe).not.toMatch(/\p{Cs}/u);
    });

    it('redacts secrets preceded by >4096 chars of invisible format, ANSI CSI/OSC, or whitespace padding (SR-312-2)', () => {
      const ghToken = ['ghp', 'A'.repeat(36)].join('_');
      const npmToken = ['npm', 'B'.repeat(36)].join('_');
      const sgToken = ['SG', 'C'.repeat(22), 'D'.repeat(43)].join('.');
      const gcpKey = ['AIza', 'E'.repeat(35)].join('');

      const vectors: ReadonlyArray<{ readonly label: string; readonly input: string; readonly prefix: string }> = [
        { label: 'zwsp-padding', input: `${'\u200b'.repeat(4_070)}${ghToken}`, prefix: 'ghp_' },
        { label: 'bidi-padding', input: `${'\u202e'.repeat(5_000)}${npmToken}`, prefix: 'npm_' },
        { label: 'ansi-csi-padding', input: `${'\u001b[31m'.repeat(814)}${ghToken}`, prefix: 'ghp_' },
        { label: 'ansi-osc-padding', input: `${'\u001b]0;pad\u0007'.repeat(600)}${sgToken}`, prefix: 'SG.' },
        { label: 'whitespace-padding', input: `${' '.repeat(4_070)}${gcpKey}`, prefix: 'AIza' },
        { label: 'newline-padding', input: `${'\r\n'.repeat(2_035)}${ghToken}`, prefix: 'ghp_' }
      ];

      for (const { label, input, prefix } of vectors) {
        const cleaned = sanitizeAgentDisplayTitle(input);
        expect(cleaned, label).toBe('[REDACTED]');
        expect(cleaned, label).not.toContain(prefix);
      }
    });

    it('drops incomplete trailing tokens split at the pre-cap boundary so partial secrets never leak (SR-312-2)', () => {
      const ghToken = ['ghp', 'Z'.repeat(36)].join('_');
      // 1. Visible prefix pushing secret across AGENT_DISPLAY_TITLE_PRE_CAP_CHARS (4096) with default maxChars
      const spacedOverDefault = `${'x '.repeat(2_035)}${ghToken}`;
      const cleanedDefault = sanitizeAgentDisplayTitle(spacedOverDefault);
      expect(cleanedDefault).not.toBeNull();
      expect(cleanedDefault).not.toContain('ghp_');

      // 2. Visible prefix pushing secret across preCap + lookahead when requesting a large maxChars
      const largeMax = AGENT_DISPLAY_TITLE_PRE_CAP_CHARS;
      const spacedOverPreCap = `${'x '.repeat(2_295)}${ghToken}`;
      const cleanedLarge = sanitizeAgentDisplayTitle(spacedOverPreCap, largeMax);
      expect(cleanedLarge).not.toBeNull();
      expect(cleanedLarge).not.toContain('ghp_');

      // 3. Delimited non-whitespace prefix pushing secret right across the pre-cap ceiling
      const delimitedOverPreCap = `${'x'.repeat(4_595)}:${ghToken}`;
      const cleanedDelimited = sanitizeAgentDisplayTitle(delimitedOverPreCap, largeMax);
      expect(cleanedDelimited).not.toBeNull();
      expect(cleanedDelimited).not.toContain('ghp_');
    });

    it('blocks surrogate-pair remaining===1, delimiter secret-pull, and oversized JWT/PEM bypasses (SR-A2 #1)', () => {
      const skPrefix = ['sk', 'ant', 'SECRET1234567'].join('-');
      const skLong = ['sk', 'ant', 'api03', 'B'.repeat(40)].join('-');
      const sgToken = ['SG', 'B'.repeat(22), `${'C'.repeat(42)}Z`].join('.');
      const pemBegin = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
      const pemEnd = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');

      // 1a. Surrogate pair at remaining === 1 (spaced & whitespace-free)
      const surrogateSpaced = `${['ghp', 'A'.repeat(4_070)].join('_')} ${skPrefix}\u200b😀89012345678901234567890`;
      expect(sanitizeAgentDisplayTitle(surrogateSpaced)).toBe('[REDACTED]');

      const surrogateTight = `${['ghp', 'A'.repeat(4_070)].join('_')}.${skPrefix}\u200b😀89012345678901234567890`;
      expect(sanitizeAgentDisplayTitle(surrogateTight)).toBe('[REDACTED]');

      // 1b. Delimiter secret-pull bypasses (`.`, `=`, `-`) at default 128 and pre-cap 4096
      const dotPull128 = `${['ghp', 'A'.repeat(4_036)].join('_')}.${sgToken}`;
      const dotPull128Out = sanitizeAgentDisplayTitle(dotPull128);
      expect(dotPull128Out).toBe('[REDACTED]');
      expect(dotPull128Out).not.toContain('SG.');

      const eqPull128 = `${['ghp', 'A'.repeat(4_036)].join('_')}=${sgToken}`;
      const eqPull128Out = sanitizeAgentDisplayTitle(eqPull128);
      expect(eqPull128Out).toBe('[REDACTED]');
      expect(eqPull128Out).not.toContain('SG.');

      const dashPull128 = `${['ghp', 'A'.repeat(4_070)].join('_')}-${['sk', 'ant', 'SECRET12345678901234567890'].join('-')}`;
      const dashPull128Out = sanitizeAgentDisplayTitle(dashPull128);
      expect(dashPull128Out).toBe('[REDACTED]');
      expect(dashPull128Out).not.toContain('sk-ant-');

      const dotPull4096 = `${['ghp', 'A'.repeat(4_548)].join('_')}.${sgToken}`;
      const dotPull4096Out = sanitizeAgentDisplayTitle(dotPull4096, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS);
      expect(dotPull4096Out).toBe('[REDACTED]');
      expect(dotPull4096Out).not.toContain('SG.');

      const eqTail4096 = `${'x'.repeat(4_580)}=${skLong}`;
      const eqTail4096Out = sanitizeAgentDisplayTitle(eqTail4096, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS);
      expect(eqTail4096Out).toBe('x'.repeat(AGENT_DISPLAY_TITLE_PRE_CAP_CHARS));
      expect(eqTail4096Out).not.toContain('sk-ant-');

      // 1c. Oversized whitespace-free JWT (payload > preCap, header > preCap) and PEM blocks
      const oversizedJwtPayload = [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), 'A'.repeat(4_100), 'sig12345678'].join('.');
      const jwtPayloadOut = sanitizeAgentDisplayTitle(oversizedJwtPayload);
      expect(jwtPayloadOut).toBe('[REDACTED]');
      expect(jwtPayloadOut).not.toContain('eyJ');

      const oversizedJwtHeader = [['eyJ', 'A'.repeat(4_100)].join(''), 'eyJzdWIiOiIxIn0', 'sig12345678'].join('.');
      const jwtHeaderOut = sanitizeAgentDisplayTitle(oversizedJwtHeader);
      expect(jwtHeaderOut).toBe('[REDACTED]');
      expect(jwtHeaderOut).not.toContain('eyJ');

      const oversizedPemOneLine = `${pemBegin}${'A'.repeat(4_100)}${pemEnd}`;
      const pemOneLineOut = sanitizeAgentDisplayTitle(oversizedPemOneLine);
      expect(pemOneLineOut).toBe('[REDACTED]');
      expect(pemOneLineOut).not.toContain('BEGIN');

      const oversizedPemMultiLine = `${pemBegin}\n${'A'.repeat(4_100)}\n${pemEnd}`;
      const pemMultiLineOut = sanitizeAgentDisplayTitle(oversizedPemMultiLine);
      expect(pemMultiLineOut).toBe('[REDACTED]');
      expect(pemMultiLineOut).not.toContain('BEGIN');

      // Benign long display titles stay intact and bounded to AGENT_DISPLAY_TITLE_MAX_CHARS
      const benignDashed = `tool-name-${'a'.repeat(5_000)}`;
      expect(sanitizeAgentDisplayTitle(benignDashed)).toBe(`tool-name-${'a'.repeat(AGENT_DISPLAY_TITLE_MAX_CHARS - 10)}`);

      const benignPath = `my.pkg/path/${'a'.repeat(5_000)}`;
      expect(sanitizeAgentDisplayTitle(benignPath)).toBe(`my.pkg/path/${'a'.repeat(AGENT_DISPLAY_TITLE_MAX_CHARS - 12)}`);
    });

    it('blocks oversized JWT post-dot 0..5 dead zone, glued-prefix headers, sentinel injection, and custom extraSanitize secret-pull (SR-A3 #1, #2, #3)', () => {
      const jwtPayload = ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0'].join('');
      const jwtSig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      // SR-A3 #1: post-dot 0..5 char dead zone at default maxChars (preCap=4096) and maxChars=4096 (preCap=4608)
      const jwt128 = `${['eyJ', 'A'.repeat(4_090)].join('')}.${jwtPayload}.${jwtSig}`;
      expect(sanitizeAgentDisplayTitle(jwt128)).toBe('[REDACTED]');
      expect(sanitizeAgentDisplayTitle(jwt128)).not.toContain('eyJ');

      for (let postDotChars = 0; postDotChars <= 5; postDotChars += 1) {
        const headerFill = 4_096 - 3 - 1 - postDotChars;
        const deadZoneJwt = `${['eyJ', 'A'.repeat(headerFill)].join('')}.${jwtPayload}.${jwtSig}`;
        const out = sanitizeAgentDisplayTitle(deadZoneJwt);
        expect(out, `postDotChars=${postDotChars}`).toBe('[REDACTED]');
        expect(out, `postDotChars=${postDotChars}`).not.toContain('eyJ');
      }

      const jwt4096 = `${['eyJ', 'A'.repeat(4_602)].join('')}.${jwtPayload}.${jwtSig}`;
      const jwt4096Out = sanitizeAgentDisplayTitle(jwt4096, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS);
      expect(jwt4096Out).toBe('[REDACTED]');
      expect(jwt4096Out).not.toContain('eyJ');

      // SR-A3 #1: glued-prefix JWT header (pre-dot and post-dot 0..5 dead zone)
      const prefJwt = `${['jwt', `eyJ${'A'.repeat(5_000)}`].join('_')}.${jwtPayload}.${jwtSig}`;
      expect(sanitizeAgentDisplayTitle(prefJwt)).toBe('[REDACTED]');
      expect(sanitizeAgentDisplayTitle(prefJwt)).not.toContain('eyJ');
      expect(sanitizeAgentDisplayTitle(prefJwt, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS)).toBe('[REDACTED]');

      const prefDeadZone = `${['jwt', `eyJ${'A'.repeat(4_086)}`].join('_')}.${jwtPayload}.${jwtSig}`;
      expect(sanitizeAgentDisplayTitle(prefDeadZone)).toBe('[REDACTED]');
      expect(sanitizeAgentDisplayTitle(prefDeadZone)).not.toContain('eyJ');

      // Linear-time ReDoS check on adversarial repeated `eyJ` runs without dot
      const startedAt = Date.now();
      const repeatedEyj = 'eyJ'.repeat(2_000);
      expect(sanitizeAgentDisplayTitle(repeatedEyj)).toBe('[REDACTED]');
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      // SR-A3 #2: sentinel-injection (`lastIndexOf('[REDACTED]')`) bypass blocked by failing closed
      const secretPass = ['MY', 'SECRET', 'PASS'].join('_');
      const urlPullTitle = `${['sk', 'ant', 'A'.repeat(4_050)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
      const urlPullTitleOut = sanitizeAgentDisplayTitle(urlPullTitle);
      expect(urlPullTitleOut).toBe('[REDACTED]');
      expect(urlPullTitleOut).not.toContain(secretPass);
      expect(urlPullTitleOut).not.toContain('https://');

      const urlPullTitle4096 = `${['sk', 'ant', 'A'.repeat(4_560)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
      const urlPullTitle4096Out = sanitizeAgentDisplayTitle(urlPullTitle4096, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS);
      expect(urlPullTitle4096Out).toBe('[REDACTED]');
      expect(urlPullTitle4096Out).not.toContain(secretPass);

      // SR-A3 #3: custom extraSanitize runs before effectiveMax slicing and triggers single-blob fail-closed
      const customPattern = /CUSTOM_[A-Za-z0-9]{16,}/g;
      const customSanitize = (s: string): string => s.replace(customPattern, '[REDACTED]');
      const customLeaked = ['CUSTOM', 'LEAKED12345678901234'].join('_');
      const customTool = `${['CUSTOM', 'A'.repeat(4_075)].join('_')} ${customLeaked}`;
      expect(customTool.length).toBe(4_110);

      const custom128Out = sanitizeAgentDisplayTitle(customTool, AGENT_DISPLAY_TITLE_MAX_CHARS, customSanitize);
      expect(custom128Out).toBe('[REDACTED]');
      expect(custom128Out).not.toContain('CUSTOM_LEAKED');

      const custom4096Out = sanitizeAgentDisplayTitle(customTool, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS, customSanitize);
      expect(custom4096Out).toBe('[REDACTED] [REDACTED]');
      expect(custom4096Out).not.toContain('CUSTOM_LEAKED');

      const singleBlobCustomComma = `${['CUSTOM', 'A'.repeat(4_580)].join('_')},${customLeaked}`;
      const singleBlobCustomDot = `${['CUSTOM', 'A'.repeat(4_580)].join('_')}.${customLeaked}`;
      const singleBlobCustomSentinel = `${['CUSTOM', 'A'.repeat(4_580)].join('_')},${['CUSTOM', 'LEAKED'].join('_')}[REDACTED]TAIL1234567890`;
      for (const vector of [singleBlobCustomComma, singleBlobCustomDot, singleBlobCustomSentinel]) {
        const out4096 = sanitizeAgentDisplayTitle(vector, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS, customSanitize);
        const out128 = sanitizeAgentDisplayTitle(vector, AGENT_DISPLAY_TITLE_MAX_CHARS, customSanitize);
        expect(out4096).toBe('[REDACTED]');
        expect(out4096).not.toContain('CUSTOM_LEAKED');
        expect(out128).toBe('[REDACTED]');
        expect(out128).not.toContain('CUSTOM_LEAKED');
      }
    });
  });
});

