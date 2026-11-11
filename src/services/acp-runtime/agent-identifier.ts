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

/** Unicode categories Cc, Cf, Cs (a lone surrogate), Zl and Zp. */
const UNSAFE_IDENTIFIER_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function isAgentIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.length <= ACP_RUNTIME_LIMITS.identifierMaxLength && !UNSAFE_IDENTIFIER_CHARACTER.test(value);
}
