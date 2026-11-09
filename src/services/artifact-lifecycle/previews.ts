/**
 * FR-R6-F05 — persisted previews. Every mutating lifecycle operation names a
 * preview of its own kind, taken on the same basis revision and less than
 * `PREVIEW_LIFETIME_MS` old.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { randomUUID } from 'node:crypto';
import {
  PREVIEW_KINDS,
  PREVIEW_LIFETIME_MS,
  type LifecycleResult,
  type PreviewKind,
  type RetentionPreview,
  type RetentionPreviewSummary
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { includesValue, isOpaqueId, ok, refuse } from './lifecycle-results';

interface PreviewRow {
  readonly preview_id: string;
  readonly kind: string;
  readonly basis_revision: string;
  readonly summary_json: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
}

export class PreviewStore {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;
  private readonly newId: () => string;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number, newId: () => string = randomUUID) {
    this.conn = conn;
    this.nowMs = nowMs;
    this.newId = newId;
  }

  public create(kind: PreviewKind, basisRevision: string, summary: RetentionPreviewSummary): RetentionPreview {
    const createdAtMs = this.nowMs();
    const preview: RetentionPreview = {
      previewId: this.newId(),
      kind,
      basisRevision,
      createdAtMs,
      expiresAtMs: createdAtMs + PREVIEW_LIFETIME_MS,
      summary
    };
    this.conn.run(
      `INSERT INTO retention_previews (preview_id, kind, basis_revision, summary_json, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      preview.previewId,
      kind,
      basisRevision,
      JSON.stringify(summary),
      createdAtMs,
      preview.expiresAtMs
    );
    return preview;
  }

  public get(previewId: string): LifecycleResult<RetentionPreview> {
    if (!isOpaqueId(previewId)) return refuse('preview-required', 'no such preview');
    const row = this.conn.get<PreviewRow>(`SELECT * FROM retention_previews WHERE preview_id = ?`, previewId);
    if (row === undefined || !includesValue(PREVIEW_KINDS, row.kind)) return refuse('preview-required', 'no such preview');
    return ok({
      previewId: row.preview_id,
      kind: row.kind,
      basisRevision: row.basis_revision,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      summary: JSON.parse(row.summary_json) as RetentionPreviewSummary
    });
  }

  /** The preview, when it is of `kind`, unexpired, and taken on `currentBasis`. */
  public requireLive(previewId: string, kind: PreviewKind, currentBasis: string): LifecycleResult<RetentionPreview> {
    const found = this.get(previewId);
    if (!found.ok) return found;
    const preview = found.value;
    if (preview.kind !== kind) return refuse('preview-required', `a ${kind} preview is required`);
    if (this.nowMs() >= preview.expiresAtMs) return refuse('preview-expired', 'the preview has expired; preview again');
    if (preview.basisRevision !== currentBasis) {
      return refuse('preview-stale', 'state changed since the preview; preview again');
    }
    return found;
  }
}
