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
