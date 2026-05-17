import type { SanitizedLogger } from '../lib/logger';

export type HistoryTerminalStatus = 'completed' | 'failed' | 'canceled';

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
  // Additive read-time fields (US6 / Wave 6 wires write-time population).
  // Optional so legacy entries (pre-US6) remain valid; rerun paths fall back
  // to a warning when these are absent.
  readonly originalDescription?: string;
  readonly pipelineId?: string;
}

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
}

export function buildHistoryEntry(args: BuildHistoryEntryArgs): HistoryEntry {
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
  // Feature 013 — Wave 6 (US6, FR-029): persist the FULL sanitized
  // description so reruns can replay the original input byte-identically
  // post-sanitization. The existing `descriptionPreview` field stays at
  // 80 chars for UI rendering; consumers MUST prefer `originalDescription`
  // when present.
  const originalDescription = sanitized;
  const pipelineId =
    typeof args.pipelineId === 'string' && args.pipelineId.length > 0
      ? args.pipelineId
      : undefined;
  return {
    runId: args.runId,
    featureId: args.featureId,
    descriptionPreview: preview,
    terminalStatus: args.terminalStatus,
    startedAt: new Date(args.startedAt).toISOString(),
    completedAt: new Date(args.completedAt).toISOString(),
    durationMs,
    lastErrorSummary,
    auditLogPointer: `runId:${args.runId}`,
    originalDescription,
    ...(pipelineId !== undefined ? { pipelineId } : {})
  };
}

export function ensureHistoryEntry(raw: unknown): HistoryEntry | null {
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
  return {
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
        : `runId:${runId}`,
    ...(originalDescription !== undefined ? { originalDescription } : {}),
    ...(pipelineId !== undefined ? { pipelineId } : {})
  };
}
