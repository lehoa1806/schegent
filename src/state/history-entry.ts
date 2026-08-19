import type { SanitizedLogger } from '../lib/logger';
import { isRunOutputStatus, type RunOutputRecord } from '../contracts/run-results';

export type HistoryTerminalStatus = 'completed' | 'failed' | 'canceled';

/**
 * FR-R3-010 (T406) — the partition a history entry lands in when nothing can
 * say which queue it belonged to.
 *
 * Two paths reach it and they are the same case said at different times: the
 * v11 → v12 migration reading a legacy flat array whose entries name a Task no
 * queue holds, and `HistoryRecorder` writing a terminal Run whose Task row is
 * already gone. Both could instead guess `DEFAULT_QUEUE_ID` — `queueIdForTask`
 * does exactly that — but a guess here files one queue's record under another
 * queue's name, and the operator reading "what has this queue done" is given an
 * answer that is wrong rather than incomplete.
 *
 * It is a real partition, not a tombstone: `list()` folds it in with the rest,
 * so nothing disappears from the history pane. Only `listForQueue()` tells the
 * difference, which is the one place the difference matters.
 *
 * The double underscores keep it outside the id space `queue-registry.ts`
 * mints, so a queue can never be created that collides with it.
 */
export const HISTORY_UNATTRIBUTED_QUEUE_ID = '__unattributed__';

/**
 * FR-R3-010 (T407) — the one place the `auditLogPointer` format is decided.
 *
 * The field shipped in feature 013 as a bare template literal at the single
 * construction site with no reader anywhere, so nothing pinned it and fixtures
 * drifted into three different shapes (`runId:rh-1`, `.schegent/audit.log`,
 * and `''`). The format is now `runId:<runId>` and nothing else; the builder
 * below is the only writer and `parseAuditLogPointer` the only reader.
 *
 * Deliberately **not** a path. A pointer that named `.schegent/audit.log` would
 * be a workspace-relative filesystem path stored in control state, sent across
 * IPC, and — the moment anything echoed it into an audit payload — a violation
 * of the rule against serialising workspace paths into the structured log. A
 * run id is an identifier this build minted, and the resolver already knows
 * which log to open.
 */
export const AUDIT_POINTER_PREFIX = 'runId:';

export function buildAuditLogPointer(runId: string): string {
  return `${AUDIT_POINTER_PREFIX}${runId}`;
}

/**
 * The run id a pointer names, or `null` when it names nothing usable.
 *
 * Legacy tolerance is deliberate and bounded to one shape: an entry written
 * before this format was pinned may carry a path or an empty string, and both
 * parse to `null`. `null` means *this entry has no usable pointer* — a distinct
 * answer from "the pointer resolved and its evidence is gone", which is what
 * the resolver reports. Collapsing the two would tell an operator their
 * evidence had expired when in fact it was never addressable.
 */
export function parseAuditLogPointer(raw: string): { readonly runId: string } | null {
  if (!raw.startsWith(AUDIT_POINTER_PREFIX)) return null;
  const runId = raw.slice(AUDIT_POINTER_PREFIX.length);
  return runId.length > 0 ? { runId } : null;
}

export interface HistoryEntry {
  readonly runId: string;
  readonly featureId: string;
  readonly descriptionPreview: string;
  readonly terminalStatus: HistoryTerminalStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly lastErrorSummary: string | null;
  readonly auditLogPointer: string;
  /**
   * FR-R3-010 (T405) — where the full sanitized description lives, and how long
   * it is.
   *
   * The description itself left this record. It is operator-authored and capped
   * at `MAX_DESCRIPTION_LENGTH` (32,000 characters), and the memento array that
   * held it is rewritten whole on every completion, so storing it here made the
   * per-append cost a function of the *content* of history rather than of the
   * change being made. What stays is a bounded preview for rendering and this
   * reference for retrieval.
   *
   * `descriptionLength` is the length of the full text, kept alongside so the
   * UI can say "80 of 4,182 characters" without reading the file, and so a
   * caller can tell a genuinely short description from a truncated one without
   * a filesystem round trip.
   *
   * Both optional: entries written before this feature carry
   * `originalDescription` instead, and both readers below handle either.
   */
  readonly descriptionRef?: string;
  readonly descriptionLength?: number;
  /**
   * **Legacy read-only.** Written by feature 013 Wave 6 through FR-R3-010; the
   * builder no longer produces it. It is still read — by `ensureHistoryEntry`
   * and by the rerun path — because entries carrying it are on operator disks
   * and dropping it would break byte-identical replay for every run recorded
   * before this change. Nothing new should be added that writes it.
   */
  readonly originalDescription?: string;
  readonly pipelineId?: string;
  // Feature 091 (T012, FR-010) — what this Run recorded about its declared
  // outputs, so a later Run's `prior-output` reference has something to resolve
  // against once the Run itself is gone.
  //
  // Absent, not empty, when the Run recorded nothing. The reader one layer up
  // distinguishes "no such Run" from "that Run recorded nothing" (FR-011), and
  // storing `[]` for the second would be indistinguishable from the first for
  // every entry written before this field existed.
  readonly runOutputs?: readonly RunOutputRecord[];
}

/**
 * FR-R3-010 (T402) — a history entry with the queue it was filed under.
 *
 * `queueId` is **not** a stored field. `KEYS.history` is a
 * `Record<queueId, HistoryEntry[]>`, so the partition key *is* the queue
 * association: it has exactly one representation and cannot disagree with a
 * copy of itself. This is the same choice feature 093 made for `KEYS.run`, and
 * for the same reason — the alternative is two answers to one question with
 * nothing keeping them in step.
 *
 * The field is stamped on at read time by `ensureHistoryEntry`, so anything a
 * store read hands back carries it and nothing a builder produces does.
 */
export type HistoryRecord = HistoryEntry & { readonly queueId: string };

export const DESCRIPTION_PREVIEW_MAX = 80;

export interface BuildHistoryEntryArgs {
  readonly runId: string;
  readonly featureId: string;
  readonly description: string;
  readonly terminalStatus: HistoryTerminalStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly lastErrorSummary?: string | null;
  readonly logger: Pick<SanitizedLogger, 'sanitize'>;
  // Feature 013 — Wave 6 (US6, FR-029/FR-030): pipeline metadata used by
  // `rerun-from-history` to route a rerun back through the same pipeline.
  // Optional so legacy entries without a known pipeline remain valid.
  readonly pipelineId?: string | null;
  // Feature 091 (T012, FR-010) — carried verbatim from `WorkflowRun.runOutputs`.
  // Nothing is re-resolved here: the Run already answered what it produced, and
  // asking the filesystem again at history-write time could answer differently.
  readonly runOutputs?: readonly RunOutputRecord[];
}

/**
 * The full sanitized description, alongside the entry that references it.
 *
 * `buildHistoryEntry` returns both because it is the one place the
 * sanitization happens (the FR-029 sanitize-once invariant) and the caller
 * needs the sanitized text to write to disk. Returning the raw text for the
 * caller to sanitize again would be a second sanitization site, and returning
 * only the entry would force the caller to sanitize independently — which is
 * the same thing with an extra step.
 *
 * The entry carries **no** `descriptionRef`. The builder cannot know whether
 * the file will be written, and a reference is a claim that something is
 * retrievable — asserting it before the write and hoping is how a record comes
 * to point at nothing. `HistoryRecorder` attaches it after the store answers,
 * which is the only moment the claim is true.
 */
export interface BuiltHistoryEntry {
  readonly entry: HistoryEntry;
  readonly fullDescription: string;
}

/**
 * FR-R3-010 (T405) — stamp a written description's reference onto an entry.
 *
 * `null` means the write did not happen, and the entry goes to history without
 * a reference. That is not an error path: it is the same shape as a legacy
 * entry with no `originalDescription`, and the rerun path already reports the
 * description as unavailable for those. A history record is worth more than the
 * replay convenience attached to it, so nothing about the description can fail
 * a completion.
 */
export function withDescriptionRef(entry: HistoryEntry, ref: string | null): HistoryEntry {
  return ref === null ? entry : { ...entry, descriptionRef: ref };
}

export function buildHistoryEntry(args: BuildHistoryEntryArgs): BuiltHistoryEntry {
  const sanitized = args.logger.sanitize(args.description ?? '');
  const collapsed = sanitized.replace(/\s+/g, ' ').trim();
  const preview =
    collapsed.length > DESCRIPTION_PREVIEW_MAX
      ? collapsed.slice(0, DESCRIPTION_PREVIEW_MAX)
      : collapsed;
  const durationMs = Math.max(0, args.completedAt - args.startedAt);
  const lastErrorSummary =
    typeof args.lastErrorSummary === 'string' && args.lastErrorSummary.length > 0
      ? args.logger.sanitize(args.lastErrorSummary)
      : null;
  const pipelineId =
    typeof args.pipelineId === 'string' && args.pipelineId.length > 0
      ? args.pipelineId
      : undefined;
  // FR-R3-010 (T405) — the full sanitized description is no longer a field of
  // this record. Feature 013 Wave 6 put it here so a rerun could replay the
  // original input byte-identically; that requirement is unchanged, but the
  // storage is not. It now lives beside the run's other evidence on disk, and
  // the record keeps a bounded preview, the full length, and a reference.
  return {
    entry: {
      runId: args.runId,
      featureId: args.featureId,
      descriptionPreview: preview,
      terminalStatus: args.terminalStatus,
      startedAt: new Date(args.startedAt).toISOString(),
      completedAt: new Date(args.completedAt).toISOString(),
      durationMs,
      lastErrorSummary,
      auditLogPointer: buildAuditLogPointer(args.runId),
      descriptionLength: sanitized.length,
      ...(pipelineId !== undefined ? { pipelineId } : {}),
      ...(args.runOutputs !== undefined && args.runOutputs.length > 0
        ? { runOutputs: args.runOutputs }
        : {})
    },
    fullDescription: sanitized
  };
}

/**
 * Normalise one persisted row, stamping the partition it was read from.
 *
 * `queueId` comes from the caller because the partition key is the only place
 * the association is recorded (see `HistoryRecord`). A row that carried its own
 * `queueId` would be a second copy free to disagree with the key it is filed
 * under, and the disagreement would surface as an entry that answers one queue
 * on a fold and a different one on a per-queue read.
 */
export function ensureHistoryEntry(raw: unknown, queueId: string): HistoryRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const runId = typeof r.runId === 'string' ? r.runId : typeof r.id === 'string' ? r.id : null;
  const featureId = typeof r.featureId === 'string' ? r.featureId : null;
  if (!runId || !featureId) return null;
  const startedAtNumber = typeof r.startedAt === 'number' ? r.startedAt : null;
  const startedAt =
    typeof r.startedAt === 'string'
      ? r.startedAt
      : startedAtNumber !== null
        ? new Date(startedAtNumber).toISOString()
        : new Date(0).toISOString();
  const endedAtRaw = r.completedAt ?? r.endedAt ?? null;
  const completedAt =
    typeof endedAtRaw === 'string'
      ? endedAtRaw
      : typeof endedAtRaw === 'number'
        ? new Date(endedAtRaw).toISOString()
        : startedAt;
  const status = (r.terminalStatus ?? r.status ?? 'completed') as string;
  const terminalStatus: HistoryTerminalStatus =
    status === 'failed' || status === 'canceled' ? status : 'completed';
  const durationMs =
    typeof r.durationMs === 'number'
      ? r.durationMs
      : Math.max(
          0,
          new Date(completedAt).getTime() - new Date(startedAt).getTime() || 0
        );
  const originalDescription =
    typeof r.originalDescription === 'string' && r.originalDescription.length > 0
      ? r.originalDescription
      : undefined;
  const pipelineId =
    typeof r.pipelineId === 'string' && r.pipelineId.length > 0
      ? r.pipelineId
      : undefined;
  const runOutputs = normalizeRunOutputs(r.runOutputs);
  const descriptionRef =
    typeof r.descriptionRef === 'string' && r.descriptionRef.length > 0
      ? r.descriptionRef
      : undefined;
  // A stored length is trusted only when it is a non-negative integer. Anything
  // else is dropped rather than repaired: a fabricated length would tell the UI
  // how much text it is not showing, and being wrong about that is worse than
  // saying nothing.
  const descriptionLength =
    typeof r.descriptionLength === 'number'
      && Number.isInteger(r.descriptionLength)
      && r.descriptionLength >= 0
      ? r.descriptionLength
      : originalDescription !== undefined
        ? originalDescription.length
        : undefined;
  return {
    queueId,
    runId,
    featureId,
    descriptionPreview: typeof r.descriptionPreview === 'string' ? r.descriptionPreview : '',
    terminalStatus,
    startedAt,
    completedAt,
    durationMs,
    lastErrorSummary: typeof r.lastErrorSummary === 'string' ? r.lastErrorSummary : null,
    auditLogPointer:
      typeof r.auditLogPointer === 'string' && r.auditLogPointer.length > 0
        ? r.auditLogPointer
        : buildAuditLogPointer(runId),
    ...(descriptionRef !== undefined ? { descriptionRef } : {}),
    ...(descriptionLength !== undefined ? { descriptionLength } : {}),
    ...(originalDescription !== undefined ? { originalDescription } : {}),
    ...(pipelineId !== undefined ? { pipelineId } : {}),
    ...(runOutputs !== undefined ? { runOutputs } : {})
  };
}

/**
 * Feature 091 (T012, FR-010) — the read half of the round trip.
 *
 * A normaliser that drops this field passes every write-side test and still
 * empties the record on the next read, so it is worth being explicit: anything
 * that is not an array is treated as absent, and a record that is not
 * well-formed is dropped rather than repaired. `reference` survives only on a
 * `resolved` record — an unresolved one names no location, and inventing an
 * empty string for it would make an unlocatable output look locatable to
 * `resolvePriorOutput`.
 */
function normalizeRunOutputs(raw: unknown): readonly RunOutputRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const records: RunOutputRecord[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== 'string' || !isRunOutputStatus(record.status)) continue;
    const reference =
      record.status === 'resolved' && typeof record.reference === 'string'
        ? record.reference
        : undefined;
    records.push({
      name: record.name,
      status: record.status,
      ...(reference !== undefined ? { reference } : {})
    });
  }
  return records;
}
