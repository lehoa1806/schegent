// FR-R4-F12 (FR-009 to FR-012; contract PI2) -- a content-free identity for the prompt contract.
//
// WHAT IT IS. One value, recorded on every `phase-start` row, that answers: were these two attempts
// asked under the same output contract? It covers the output-contract text (the completion-token and
// audit-block instructions), the composition version, and the task block as rendered. It is a digest,
// so it records equality and recovers nothing.
//
// WHAT IT DELIBERATELY EXCLUDES. Everything a run varies: the brief, the iteration, the feature
// directory, the sidecar path, previous phase messages, carried issues, the request envelope, the
// continuation note, the phase id and every path. A full-prompt digest would change on every
// attempt, answer the question worse, and disclose more (research R9). It also excludes what the
// CLI loads itself (skill files, system prompts, CLI defaults) and the backend's argv.
//
// A DIGEST IS NOT ANONYMIZATION. Anyone holding a candidate instruction can compute its digest and
// confirm whether a row used it. The reference page says so.
//
// A leaf: it imports `node:crypto` only. It cannot reach the controller, the audit modules or `vscode`.
import { createHash } from 'node:crypto';

/**
 * Bumped when the scaffold `PromptBuilder.build` lays around the contract text and the task block
 * changes (research R10), so two rows with equal digests were composed the same way. The scaffold is
 * pinned by `tests/unit/runner/prompt-identity.test.ts` (d). Version 2 (review gap GC-14) labels
 * the previous-phase-message and carried-issue sections as data.
 */
export const PROMPT_COMPOSITION_VERSION = 2;

/**
 * The identity of the prompt an attempt sent.
 *
 * `contract`: a composed prompt. `resume`: a stored resume prompt was sent, so the contract text was
 * not composed for this attempt and no digest is recorded.
 */
export type PromptIdentity =
  | { readonly scope: 'contract'; readonly compositionVersion: number; readonly digest: string }
  | { readonly scope: 'resume' };

/** The identity of an attempt that sent an operator's stored resume prompt. */
export const RESUME_PROMPT_IDENTITY: PromptIdentity = Object.freeze({ scope: 'resume' as const });

/** What the task block was built from, as `PromptBuilder` resolved it. */
export type PromptTaskKind = 'instruction' | 'skill' | 'none';

const DIGEST_DOMAIN = 'schegent-prompt-contract';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The digest of the covered parts: `sha256:` and 64 lowercase hex characters over a JSON array, so
 * moving text from one part to the next cannot produce the same bytes.
 */
export function promptContractDigest(parts: {
  readonly compositionVersion: number;
  readonly contractText: string;
  readonly taskKind: PromptTaskKind;
  readonly taskText: string;
}): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([DIGEST_DOMAIN, parts.compositionVersion, parts.contractText, parts.taskKind, parts.taskText]))
    .digest('hex');
  return `sha256:${hash}`;
}

function sameKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Reads the identity off a `phase-start` payload.
 *
 * `recorded: true` only for one of the two exact shapes: no extra key, `compositionVersion` a
 * positive safe integer, `digest` matching `sha256:` and 64 lowercase hex. Anything else, absence
 * included, is `{ recorded: false }`: every row written before FR-R4-F12 has no identity, and a row
 * whose value is in neither shape is read the same way rather than guessed at.
 */
export function readPromptIdentity(
  payload: Readonly<Record<string, unknown>>
): { readonly recorded: true; readonly identity: PromptIdentity } | { readonly recorded: false } {
  const value: unknown = payload.promptIdentity;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { recorded: false };
  const candidate = value as Readonly<Record<string, unknown>>;

  if (candidate.scope === 'resume' && sameKeys(candidate, ['scope'])) {
    return { recorded: true, identity: RESUME_PROMPT_IDENTITY };
  }

  if (candidate.scope === 'contract' && sameKeys(candidate, ['scope', 'compositionVersion', 'digest'])) {
    const { compositionVersion, digest } = candidate;
    if (typeof compositionVersion !== 'number' || !Number.isSafeInteger(compositionVersion) || compositionVersion < 1) {
      return { recorded: false };
    }
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) return { recorded: false };
    return { recorded: true, identity: { scope: 'contract', compositionVersion, digest } };
  }

  return { recorded: false };
}
