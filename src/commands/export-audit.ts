import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseAuditLogLineDetailed } from '../parser/audit-log-parser';
import { CAP_EXHAUSTED_CAUSE } from '../audit/audit-payload';
import type { Notifier } from '../ui/notifications';

const COUNT_KEYS = new Set([
  'exitCode',
  'fileChangeCounts',
  'metrics',
  'omittedFileEvidenceCount',
  'omittedToolEvidenceCount',
  'outcome',
  'terminationReason',
  'toolCategoryCounts',
  // Feature 194 (FR-R3-155, T030) — the metadata-only export previously
  // omitted both new fields entirely, so neither reached the export an
  // incident review reads. `stalled` is a pure integer and fits this
  // allowlist's stated purpose outright. `cause` needed its own reasoning:
  // the published vocabulary has a second, free-form member (redacted
  // fatal-signature text, including operator-added FR-033 patterns) that
  // does not belong in a counts-only export. `AuditLogWriter.append()` runs
  // `phase-end` entries — and only those — through `projectPhaseEnd()`
  // (`src/audit/audit-payload.ts`) before they reach disk, which keeps that
  // member out of `payload.cause` for anything written by the current code —
  // but this function parses whatever `.jsonl` bytes are ACTUALLY on disk,
  // which can include entries a pre-feature-194 build wrote (before that
  // projection existed) or a future regression in it. The value check below
  // is deliberate defense-in-depth against those cases, not a redundant
  // duplicate of the write-path guarantee: for `phase-end` only the literal
  // `cap_exhausted` survives, regardless of which build wrote the line.
  'cause',
  'stalled'
]);

/**
 * A closed-vocabulary `cause` as this repo writes them: a short lowercase token.
 * Every member of every non-`phase-end` cause vocabulary matches — `operator`,
 * `consumed-by-fire`, `task-not-pending`, `invalid-position`, `no-op`,
 * `rate_limit`, `transient_error` — and free-form text does not: prose has
 * spaces, a redacted CLI excerpt has punctuation and capitals, a path has a
 * separator and a dot (AGENTS.md rule 22).
 */
const CLOSED_CAUSE_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Value checks for the allowlist above, for the same reason its `cause` note
 * gives: this function parses whatever bytes are on disk, not what the current
 * writer produces.
 *
 * Scoped by `(eventType, key)`, not by key alone. `cause` is not a `phase-end`
 * field — `phase-breakpoint-cleared`, `task-reordered`, `monitor-rate-limited`,
 * the backend-ping failures and the delayed-retry pauses all carry one, each
 * with its own closed vocabulary and none of them equal to `cap_exhausted`. A
 * by-name guard therefore allowlisted the field and then stripped it from every
 * event family but one, so an operator exporting a log to see why a breakpoint
 * cleared or a retry was scheduled read the field as never recorded. Those
 * vocabularies are code-resident, so they are admitted by shape rather than
 * enumerated here — an enumeration in the export is a second copy of five
 * vocabularies that would drift out of step with all of them.
 *
 * A REJECTION IS NOT AN ABSENCE. `stalled` absent means the stagnation rule did
 * not apply and a `phase-end` with no `cause` means a generic failure
 * (data-model.md §2 — "absence is not zero"), so filtering a value this guard
 * disbelieves would rewrite a tamper signal into a meaningful reading. Rejected
 * values export as `null`: the field was on disk, and this export will not carry
 * what it found.
 */
function guardedPayloadValue(eventType: string, key: string, value: unknown): unknown {
  if (key === 'cause') {
    const ok = eventType === 'phase-end'
      ? value === CAP_EXHAUSTED_CAUSE
      : typeof value === 'string' && CLOSED_CAUSE_TOKEN.test(value);
    return ok ? value : null;
  }
  if (key === 'stalled') {
    const ok = typeof value === 'number' && Number.isInteger(value) && value > 0;
    return ok ? value : null;
  }
  return value;
}

/**
 * FR-R3-112 — the export deliberately carries NO chain fields.
 *
 * `prevDigest` links the BYTES of one on-disk entry to the next. An export is a projection: it
 * drops payload fields, renumbers nothing, and emits rows that were never the bytes the digests
 * were taken over. Carrying the digests here would produce a file that looks chain-verifiable and
 * is not — worse than one that plainly is not, because someone would eventually verify it and
 * believe the result. The whitelist below does this by construction; this note says it is on
 * purpose so a future reader does not "fix" it.
 */
export function createCountsOnlyAuditExport(input: string): string {
  const rows: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const parsed = parseAuditLogLineDetailed(line).entry;
    if (!parsed || parsed.schemaVersion !== 3) continue;
    const payload = Object.fromEntries(
      Object.entries(parsed.payload)
        .filter(([key]) => COUNT_KEYS.has(key))
        .map(([key, value]) => [key, guardedPayloadValue(parsed.eventType, key, value)])
    );
    rows.push(JSON.stringify({
      id: parsed.id,
      timestamp: parsed.timestamp,
      eventType: parsed.eventType,
      phase: parsed.phase,
      iteration: parsed.iteration,
      outcome: parsed.outcome,
      schemaVersion: 3,
      payload
    }));
  }
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

export async function runExportAuditLog(ctx: {
  workspaceRoot: string;
  notifier: Notifier;
}): Promise<void> {
  const source = path.join(ctx.workspaceRoot, '.schegent', 'audit.log');
  let exported: string;
  try {
    exported = createCountsOnlyAuditExport(await fs.readFile(source, 'utf8'));
  } catch {
    ctx.notifier.info('Schegent: no audit log yet.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(ctx.workspaceRoot, 'schegent-audit-v3.jsonl')),
    filters: { 'JSON Lines': ['jsonl'] },
    saveLabel: 'Export metadata-only audit'
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(exported, 'utf8'));
  ctx.notifier.info('Schegent: metadata-only audit exported.');
}
