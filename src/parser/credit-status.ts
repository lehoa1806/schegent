// FR-R4-F02 (spec 240, US6; contract W1, W2; FR-017, FR-018, FR-019) — what a `/status` poll says
// about the account, as a three-valued answer decided from positive evidence only.
//
// The credit watchdog resumes unattended Runs when this returns `recovered`, so the cost of a wrong
// `recovered` is a Run started against an exhausted account, while the cost of a wrong
// `not-recovered` is one more poll. The grammar below is therefore written to say `recovered` only
// for text that states it, and to say `not-recovered` for everything ambiguous. It replaces an
// any-substring test that read "Status: not ready" and "Credits not available" as healthy.
//
// The forms are a starting grammar written without a real capture of the CLI's `/status` output.
// The platform observation Q1 replaces or confirms them; a structured discriminator found there
// takes precedence and this grammar becomes its fallback.
//
// No status text leaves this module (G3): the answer is a three-valued string, so there is nothing
// of the CLI's output for a caller to log, store or project.
import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';
import { unwrapStreamJson } from './stream-json-unwrapper';

export type CreditStatus = 'recovered' | 'not-recovered' | 'unreachable';

/** At most this many lines of the status output are read; the rest are ignored. */
export const CREDIT_STATUS_MAX_LINES = 50;

/** A line longer than this is skipped whole, never truncated into a different line. */
export const CREDIT_STATUS_MAX_LINE_CHARS = 200;

export type CreditStatusInput =
  | {
      readonly exitCode: number | null;
      readonly killed: boolean;
      readonly timedOut: boolean;
      readonly stdout: ZippedStreamBuffer | string;
    }
  | { readonly thrown: true };

/** A line opening with one of these is quoted or structured content, never evidence. */
const QUOTED_OR_STRUCTURED_OPENERS = '{["\'`';

const NEGATIVE_WORDS = [
  'not',
  'no',
  'none',
  'unavailable',
  'insufficient',
  'exhausted',
  'depleted',
  'exceeded',
  'limit',
  'limited',
  'reached',
  'wait',
  'retry',
  'until'
] as const;

const NEGATIVE_PATTERN = new RegExp(`\\b(?:${NEGATIVE_WORDS.join('|')})\\b`, 'i');

const POSITIVE_PATTERN =
  /^(?:credits|quota|status|account status)\s*:\s*(?:available|restored|ok|healthy|ready|active)\.?$/i;

/** The lines the grammar may read, trimmed: bounded, short enough, and not quoted or structured. */
function consideredLines(text: string): string[] {
  return text
    .split('\n')
    .slice(0, CREDIT_STATUS_MAX_LINES)
    .filter((line) => line.length <= CREDIT_STATUS_MAX_LINE_CHARS)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !QUOTED_OR_STRUCTURED_OPENERS.includes(line[0] as string));
}

/**
 * Classify one `/status` invocation. A poll that threw, exited nonzero (a missing code included),
 * was killed or timed out is `unreachable` and its text is not read (G1). At exit zero the answer
 * comes only from the grammar (G2): any negative word on a considered line is `not-recovered`;
 * otherwise `recovered` needs a line that is exactly a positive form; anything else, an empty
 * output included, is `not-recovered`.
 */
export function classifyCreditStatus(result: CreditStatusInput): CreditStatus {
  if ('thrown' in result) return 'unreachable';
  if (result.exitCode !== 0 || result.killed || result.timedOut) return 'unreachable';
  const lines = consideredLines(unwrapStreamJson(result.stdout).text);
  if (lines.some((line) => NEGATIVE_PATTERN.test(line))) return 'not-recovered';
  return lines.some((line) => POSITIVE_PATTERN.test(line)) ? 'recovered' : 'not-recovered';
}
