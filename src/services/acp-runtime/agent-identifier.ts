/**
 * FR-R6-F13 (FR-012, FR-013) — what an agent may put in an identifier the host keeps.
 *
 * An agent-supplied identifier becomes a session key, a display row key or a value handed to the
 * host's permission policy, and none of those places passes over it with a display sanitizer. So
 * the rule is applied once, on receive: 1 to 256 UTF-16 units, and no control, format, surrogate
 * or line-breaking separator character. That keeps out terminal escapes, forged line breaks,
 * direction overrides and invisible characters; ordinary punctuation and spaces stay allowed.
 *
 * Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS } from '../../contracts/acp-runtime';
import { REDACTION_SENTINEL, SanitizedLogger } from '../../lib/logger';

/** Unicode categories Cc, Cf, Cs (a lone surrogate), Zl and Zp. */
const UNSAFE_IDENTIFIER_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Bounded display title defaults (FR-R7-17 / R7-17-05). */
export const AGENT_DISPLAY_TITLE_MAX_CHARS = 128;
export const AGENT_DISPLAY_TITLE_PRE_CAP_CHARS = 4_096;
const TITLE_PRE_CAP_LOOKAHEAD_CHARS = 512;

/** Bounded ANSI CSI / OSC / single-char ESC strippers (linear time, sticky anchored). */
const ANSI_ESC = String.fromCharCode(0x1b);
const ANSI_BEL = String.fromCharCode(0x07);
const ANSI_ESC_CODE = 0x1b;
const ANSI_CSI_Y = new RegExp(`${ANSI_ESC}\\[[0-?]{0,64}[ -/]{0,16}[@-~]`, 'y');
const ANSI_OSC_Y = new RegExp(`${ANSI_ESC}\\][^${ANSI_BEL}${ANSI_ESC}]{0,512}(?:${ANSI_BEL}|${ANSI_ESC}\\\\)?`, 'y');
const ANSI_ESC_TWO_Y = new RegExp(`${ANSI_ESC}[@-Z\\\\-_]`, 'y');
const FORMAT_OR_SURROGATE_Y = /[\p{Cf}\p{Cs}]+/uy;
const SPACE_OR_CONTROL_Y = new RegExp(`(?:[ \\t\\p{Zl}\\p{Zp}]|(?!${ANSI_ESC})\\p{Cc})+`, 'uy');
const VISIBLE_RUN_Y = /[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp} \t]+/uy;
const FORMAT_OR_SURROGATE_RE = /[\p{Cf}\p{Cs}]/gu;
const CONTROL_OR_LINE_SEP_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const COLLAPSE_SPACES_RE = /[ \t]{2,}/g;
const SECRET_TOKEN_CHAR_RE = /[A-Za-z0-9_\-.+/%]/;
/**
 * Linear-time truncated-token detectors used ONLY when `extractNormalizedPrefix` itself cut an
 * oversized token mid-token at the pre-cap ceiling (SR-A2 #1 / SR-A3 #1), so an oversized JWT
 * (including post-dot 0..5 char tails and glued-prefix headers) or PEM block whose closing
 * segment/footer was sliced off by pre-capping fails closed to `REDACTION_SENTINEL`.
 */
const TRUNCATED_JWT_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-]{6,})[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{0,5}$)/;
const TRUNCATED_JWT_HEADER_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-]{64,})[A-Za-z0-9_-]+$/;
const TRUNCATED_PEM_RE = /-----BEGIN [A-Z0-9 ]+-----/;

const TITLE_SECRET_SANITIZER = new SanitizedLogger([]);

interface ExtractedPrefix {
  readonly text: string;
  readonly truncatedMidToken: boolean;
  readonly hadWhitespace: boolean;
  readonly failClosedRedacted: boolean;
}

function sliceWithoutSplitSurrogate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

function matchSticky(re: RegExp, input: string, index: number): number {
  re.lastIndex = index;
  const match = re.exec(input);
  return match !== null ? re.lastIndex : -1;
}

function trimTrailingDelimitedToken(value: string): string {
  // Single whitespace-free token cut at the pre-cap ceiling: trim back to the last non-token
  // delimiter (e.g. `:`, `=`, `(`) so a suffixed secret cannot survive as a truncated fragment,
  // while leaving uniform identifier runs intact for final display bounding.
  for (let idx = value.length - 1; idx >= 0; idx -= 1) {
    const ch = value.charAt(idx);
    if (!SECRET_TOKEN_CHAR_RE.test(ch)) {
      return value.slice(0, idx + 1).trimEnd();
    }
  }
  return value;
}

/**
 * Strips ANSI escapes, format/surrogate characters, and control/line-separator runs BEFORE
 * counting toward `maxVisibleChars`, so invisible/ANSI/whitespace padding cannot push a secret
 * across the pre-cap boundary and evade redaction (SR-312-2). If `maxVisibleChars` splits a
 * non-whitespace visible token, the incomplete trailing fragment is dropped before redaction
 * and oversized truncated JWT/PEM blobs fail closed to `REDACTION_SENTINEL` (SR-A2 #1).
 */
function extractNormalizedPrefix(raw: string, maxVisibleChars: number): ExtractedPrefix {
  const chunks: string[] = [];
  let collected = 0;
  let pendingSpace = false;
  let truncatedMidToken = false;
  let i = 0;

  while (i < raw.length) {
    if (raw.charCodeAt(i) === ANSI_ESC_CODE) {
      let nextIdx = matchSticky(ANSI_CSI_Y, raw, i);
      if (nextIdx === -1) nextIdx = matchSticky(ANSI_OSC_Y, raw, i);
      if (nextIdx === -1) nextIdx = matchSticky(ANSI_ESC_TWO_Y, raw, i);
      if (nextIdx !== -1) {
        i = nextIdx;
        continue;
      }
      if (collected > 0) pendingSpace = true;
      i += 1;
      continue;
    }

    const fmtEnd = matchSticky(FORMAT_OR_SURROGATE_Y, raw, i);
    if (fmtEnd !== -1) {
      i = fmtEnd;
      continue;
    }

    const spaceEnd = matchSticky(SPACE_OR_CONTROL_Y, raw, i);
    if (spaceEnd !== -1) {
      if (collected > 0) pendingSpace = true;
      i = spaceEnd;
      continue;
    }

    const visEnd = matchSticky(VISIBLE_RUN_Y, raw, i);
    if (visEnd === -1) {
      i += 1;
      continue;
    }

    if (pendingSpace && collected > 0) {
      if (collected >= maxVisibleChars) {
        break;
      }
      chunks.push(' ');
      collected += 1;
      pendingSpace = false;
    }

    const remaining = maxVisibleChars - collected;
    if (remaining <= 0) {
      truncatedMidToken = true;
      break;
    }

    const runLen = visEnd - i;
    if (runLen <= remaining) {
      chunks.push(raw.slice(i, visEnd));
      collected += runLen;
      i = visEnd;
      continue;
    }

    // `runLen > remaining`, so `i + remaining + 1 <= visEnd` and `sliceWithoutSplitSurrogate`
    // sees a string strictly longer than `remaining`, preventing dangling high surrogates.
    // Mark `truncatedMidToken` BEFORE checking `slice.length > 0` so an astral surrogate pair
    // at `remaining === 1` (which yields an empty slice) still drops the incomplete trailing token.
    truncatedMidToken = true;
    const slice = sliceWithoutSplitSurrogate(raw.slice(i, i + remaining + 1), remaining);
    if (slice.length > 0) {
      chunks.push(slice);
      collected += slice.length;
    }
    break;
  }

  const joined = chunks.join('');
  if (joined.length === 0) {
    return { text: '', truncatedMidToken: false, hadWhitespace: false, failClosedRedacted: false };
  }
  if (!truncatedMidToken) {
    return {
      text: joined.trim(),
      truncatedMidToken: false,
      hadWhitespace: joined.includes(' '),
      failClosedRedacted: false
    };
  }
  if (TRUNCATED_PEM_RE.test(joined)) {
    return {
      text: REDACTION_SENTINEL,
      truncatedMidToken: true,
      hadWhitespace: false,
      failClosedRedacted: true
    };
  }
  const lastSpace = joined.lastIndexOf(' ');
  if (lastSpace > 0) {
    return {
      text: joined.slice(0, lastSpace).trimEnd(),
      truncatedMidToken: true,
      hadWhitespace: true,
      failClosedRedacted: false
    };
  }
  if (TRUNCATED_JWT_RE.test(joined) || TRUNCATED_JWT_HEADER_RE.test(joined)) {
    return {
      text: REDACTION_SENTINEL,
      truncatedMidToken: true,
      hadWhitespace: false,
      failClosedRedacted: true
    };
  }
  return {
    text: trimTrailingDelimitedToken(joined).trim(),
    truncatedMidToken: true,
    hadWhitespace: false,
    failClosedRedacted: false
  };
}

export function isAgentIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.length <= ACP_RUNTIME_LIMITS.identifierMaxLength && !UNSAFE_IDENTIFIER_CHARACTER.test(value);
}

/**
 * FR-R7-17 (R7-17-05) — sanitizes untrusted agent-supplied permission or tool titles before
 * reaching any display, projection, stream, or logging boundary.
 *
 * Strips ANSI escapes, format/bidi characters (`Cf`), lone surrogates (`Cs`), and
 * control/line-separator characters (`Cc`/`Zl`/`Zp`) while collecting a bounded visible prefix
 * (dropping any incomplete trailing token at the pre-cap ceiling), delegates secret redaction to
 * `SanitizedLogger.sanitize` (single source of truth per Hard Rules 1 and 23), and bounds output
 * to `maxChars` UTF-16 code units without splitting surrogate pairs.
 */
export function sanitizeAgentDisplayTitle(
  raw: unknown,
  maxChars: number = AGENT_DISPLAY_TITLE_MAX_CHARS,
  extraSanitize?: (value: string) => string
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const effectiveMax = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : AGENT_DISPLAY_TITLE_MAX_CHARS;
  const preCap = Math.max(AGENT_DISPLAY_TITLE_PRE_CAP_CHARS, effectiveMax + TITLE_PRE_CAP_LOOKAHEAD_CHARS);
  const extracted = extractNormalizedPrefix(raw, preCap);
  if (extracted.text.length === 0) return null;
  if (extracted.failClosedRedacted) {
    const boundedRedacted = sliceWithoutSplitSurrogate(REDACTION_SENTINEL, effectiveMax).trim();
    return boundedRedacted.length === 0 ? null : boundedRedacted;
  }
  let sanitized = TITLE_SECRET_SANITIZER.sanitize(extracted.text);
  if (extraSanitize !== undefined) {
    sanitized = extraSanitize(sanitized);
  }
  // SR-A2 #1 / SR-A3 #2 / SR-A3 #3: when a single whitespace-free blob was cut mid-token at
  // `preCap` and redaction (built-in or caller `extraSanitize`) mutated the prefix, fail closed
  // directly to `REDACTION_SENTINEL` so neither sentinel-injection nor secret-pull can surface
  // an unverified truncated tail.
  if (extracted.truncatedMidToken && !extracted.hadWhitespace && sanitized !== extracted.text) {
    sanitized = REDACTION_SENTINEL;
  }
  const redacted = sanitized
    .replace(FORMAT_OR_SURROGATE_RE, '')
    .replace(CONTROL_OR_LINE_SEP_RE, ' ')
    .replace(COLLAPSE_SPACES_RE, ' ')
    .trim();
  if (redacted.length === 0) return null;
  const bounded = sliceWithoutSplitSurrogate(redacted, effectiveMax).trim();
  return bounded.length === 0 ? null : bounded;
}

/**
 * FR-R7-14 (14-04) — Strict non-option identifier pattern for provider conversation IDs
 * (`session_id`, `thread_id`) passed to backend CLI resume flags (`--resume <id>`,
 * `exec resume --json <id>`). Starts with an ASCII alphanumeric character and excludes
 * leading `-`, whitespace, `=`, path separators, and control characters to block option injection.
 */
export const SAFE_PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function isSafeProviderSessionId(value: unknown): value is string {
  return isAgentIdentifier(value) && SAFE_PROVIDER_SESSION_ID_RE.test(value);
}
