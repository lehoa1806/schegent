/**
 * FR-008 / FR-008a / FR-008c — the protocol fields the verdict readers actually
 * read, in both tiers, with a symbol-grained anchor for each.
 *
 * Two tiers, because the pipeline has two. `phase-runner.ts:756` unwraps the
 * backend's stream-json envelope BEFORE `parseInvocation` sees anything, so the
 * envelope fields are read by one module and the audit-block fields by another,
 * and a corpus entering downstream of the unwrapper — as all eleven original
 * cases did — cannot witness a rename in the first tier at all.
 *
 * **What is deliberately NOT here (FR-008c).** Three readers touch envelope
 * fields and are excluded with a reason rather than by omission:
 *
 *   - session-id extraction, which reads `session_id` to persist a resumable
 *     session;
 *   - rate-limit reset extraction, which reads reset timestamps for backoff;
 *   - invocation usage accounting, which reads token counts for reporting.
 *
 * None of the three decides whether a phase advanced. Pinning them would turn
 * an upstream telemetry rename into a red gate on a tree whose verdicts are all
 * still correct — and a gate that fails for reasons the operator knows are
 * harmless is a gate that gets overridden by reflex, which is worse than no
 * gate. FR-010 says a field no verdict reader reads must NOT be pinned; this is
 * that rule applied to the three concrete cases where it bites.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReadField {
  readonly tier: 'envelope' | 'audit-block';
  readonly path: string;
  readonly anchor: { readonly file: string; readonly symbol: string; readonly line: number };
  readonly kind: 'string' | 'boolean' | 'string[]' | 'object' | 'array';
  readonly presence: 'required' | 'optional';
}

const UNWRAP = 'repo/src/parser/stream-json-unwrapper.ts';
const AUDIT = 'repo/src/parser/audit-log-parser.ts';

/**
 * T008 — the audit-block tier, enumerated from source at run time.
 *
 * `REQUIRED_FIELDS` is module-private (`audit-log-parser.ts:122`), so it cannot
 * be imported. Reading the declaration out of the source file is still a
 * derivation rather than a transcription, and it is the derivation that matters:
 * rename a field in the parser and this list follows it, leaving the fixture's
 * synthesized block behind — which is precisely the drift FR-009 demands fail.
 *
 * Anchored to `parseAuditLogBlock` (`:197`) and NEVER to the file.
 * `parseAuditLogLineDetailed` (`:23`) lives in the same file, reads the host's
 * own persisted audit JSONL, and decides no verdict. A file-grained anchor
 * would sweep it in (FR-008a).
 */
export function auditBlockReadFields(): ReadonlyArray<ReadField> {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'parser', 'audit-log-parser.ts'),
    'utf8'
  );
  const declaration = /const REQUIRED_FIELDS = \[([\s\S]*?)\] as const;/.exec(source);
  // `.at(1)` rather than `[1]`, here and in the matches below, because it is
  // typed `string | undefined` whichever way `noUncheckedIndexedAccess` is set —
  // so the miss is handled once, honestly, instead of being a check the default
  // build calls redundant and the ratchet gate
  // (tests/lint/compiler-strictness-ratchet.test.ts) calls missing.
  const body = declaration?.at(1);
  if (body === undefined) {
    throw new Error(
      'REQUIRED_FIELDS is no longer declared as `const REQUIRED_FIELDS = [ … ] as const;` in ' +
        'audit-log-parser.ts. This derivation reads the declaration because the const is not ' +
        'exported; re-point it at the new shape rather than transcribing the field list here — a ' +
        'transcribed list is the failure FR-002a exists to prevent.'
    );
  }
  const names = [...body.matchAll(/'([a-z_]+)'/g)].flatMap((match) => {
    const name = match.at(1);
    return name === undefined ? [] : [name];
  });
  if (names.length === 0) {
    throw new Error('REQUIRED_FIELDS parsed to an empty list; the extraction regex is stale.');
  }
  return names.map((name) => ({
    tier: 'audit-block' as const,
    path: name,
    anchor: { file: AUDIT, symbol: 'parseAuditLogBlock', line: 197 },
    kind: 'string' as const,
    presence: 'required' as const
  }));
}

/**
 * T009 — the envelope tier, hand-derived from `unwrapStreamJson`.
 *
 * No union and no exported array stands behind these: they are property reads
 * inside one function, so this table is MAINTENANCE and is declared as such on
 * every entry (`derivation: 'hand-anchored'` in the enumeration). Line numbers
 * were measured against the tree, not copied — three of the anchors carried in
 * the task text were stale by one to three lines.
 */
export const ENVELOPE_READ_FIELDS: ReadonlyArray<ReadField> = Object.freeze([
  {
    tier: 'envelope',
    path: 'is_error',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 35 },
    kind: 'boolean',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'terminal_reason',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 38 },
    kind: 'string',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'errors',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 39 },
    kind: 'array',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'type',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 43 },
    kind: 'string',
    presence: 'required'
  },
  {
    tier: 'envelope',
    path: 'message.content',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 48 },
    kind: 'array',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'message.content[].type',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 50 },
    kind: 'string',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'message.content[].text',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 51 },
    kind: 'string',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'item.type',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 68 },
    kind: 'string',
    presence: 'optional'
  },
  {
    tier: 'envelope',
    path: 'item.text',
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson.processLine', line: 68 },
    kind: 'string',
    presence: 'optional'
  }
]);

export type EnvelopeShape =
  | 'claude-assistant'
  | 'codex-item-completed'
  | 'agy-item-completed'
  | 'raw-passthrough';

/**
 * T010 — the schema-shape assertion, over both tiers.
 *
 * Returns violations rather than throwing, so the negative half of FR-009a can
 * assert that a mutation DOES produce one and that an unread-field mutation
 * produces none. A throwing assertion can only be tested in one direction.
 *
 * Required fields are pinned on presence AND kind; protocol-optional fields are
 * pinned on kind-when-present only. The distinction is FR-010: a backend that
 * omits `is_error` on a successful turn is behaving correctly, and a corpus
 * that failed on the omission would be pinning the absence of an error as an
 * error.
 */
export function envelopeViolations(
  shape: EnvelopeShape,
  lines: ReadonlyArray<string>
): string[] {
  const violations: string[] = [];
  if (lines.length === 0) violations.push(`${shape}: envelope has no lines`);

  lines.forEach((line, index) => {
    const at = `${shape}[${index}]`;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // `raw-passthrough` exists precisely because a non-object line leaves
        // `sawAnyLine` false and the unwrapper returns the raw text. For that
        // shape a non-object is the property under test, not a violation.
        if (shape !== 'raw-passthrough') violations.push(`${at}: not a JSON object`);
        return;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      if (shape !== 'raw-passthrough') violations.push(`${at}: not parseable as JSON`);
      return;
    }

    if (shape === 'raw-passthrough') {
      violations.push(
        `${at}: parses as a JSON object, so the unwrapper would set sawAnyLine and this case ` +
          'would no longer reach the raw-passthrough branch it exists to cover'
      );
      return;
    }

    // `type` is the discriminator every branch of `processLine` switches on.
    if (typeof record.type !== 'string') {
      violations.push(`${at}: missing read field \`type\` (string)`);
      return;
    }

    if ('is_error' in record && typeof record.is_error !== 'boolean') {
      violations.push(`${at}: read field \`is_error\` present but not a boolean`);
    }
    if (record.is_error === true) {
      if ('terminal_reason' in record && typeof record.terminal_reason !== 'string') {
        violations.push(`${at}: read field \`terminal_reason\` present but not a string`);
      }
      if ('errors' in record && !Array.isArray(record.errors)) {
        violations.push(`${at}: read field \`errors\` present but not an array`);
      }
    }

    if (record.type === 'assistant') {
      const message = record.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== 'object') {
        violations.push(`${at}: missing read field \`message\` (object)`);
        return;
      }
      if (!Array.isArray(message.content)) {
        violations.push(`${at}: missing read field \`message.content\` (array)`);
        return;
      }
      message.content.forEach((block: unknown, blockIndex: number) => {
        const where = `${at}.message.content[${blockIndex}]`;
        if (!block || typeof block !== 'object') {
          violations.push(`${where}: not an object`);
          return;
        }
        const typed = block as Record<string, unknown>;
        if (typeof typed.type !== 'string') {
          violations.push(`${where}: missing read field \`type\` (string)`);
          return;
        }
        if (typed.type === 'text' && typeof typed.text !== 'string') {
          violations.push(`${where}: missing read field \`text\` (string) on a text block`);
        }
      });
      return;
    }

    if (record.type === 'item_completed' || record.type === 'item.completed') {
      const item = record.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== 'object') {
        violations.push(`${at}: missing read field \`item\` (object)`);
        return;
      }
      if (typeof item.type !== 'string') {
        violations.push(`${at}: missing read field \`item.type\` (string)`);
        return;
      }
      if (item.type === 'agent_message' && typeof item.text !== 'string') {
        violations.push(`${at}: missing read field \`item.text\` (string) on an agent_message`);
      }
      return;
    }

    // `is_error` is read at `:35`, BEFORE the `type` dispatch and regardless of
    // it, so a record that sets it IS consumed no matter what `type` says. The
    // terminal `{"type":"result","is_error":true,…}` frame is the shape that
    // proves it, and flagging it would have made the api-error branch —
    // `unwrapper:api-error-detected`, an enumerated entry — uncoverable by any
    // conformant case.
    if (record.is_error === true) return;

    violations.push(
      `${at}: \`type\` is "${record.type}", which no branch of unwrapStreamJson reads. A case ` +
        'carrying an envelope no branch consumes covers nothing.'
    );
  });

  return violations;
}

/**
 * The audit-block half of the same assertion: every field
 * `parseAuditLogBlock` requires must be present as a `name:` key in the block
 * the harness synthesizes.
 *
 * This is the tier where the drift test bites hardest. Rename a required field
 * in the parser and the derived list follows it while the fixture's block stays
 * where it was, so the rename fails here — offline, with no credential and no
 * network, which is the whole of FR-009.
 */
export function auditBlockViolations(block: string): string[] {
  const violations: string[] = [];
  const present = new Set(
    [...block.matchAll(/^([a-z_]+):/gm)].map((match) => match[1])
  );
  for (const field of auditBlockReadFields()) {
    if (!present.has(field.path)) {
      violations.push(
        `audit block is missing read field \`${field.path}\`, required by ` +
          `${field.anchor.symbol} (${field.anchor.file}:${field.anchor.line})`
      );
    }
  }
  return violations;
}
