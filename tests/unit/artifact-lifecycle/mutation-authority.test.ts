import { describe, expect, it } from 'vitest';
import type {
  MutationAuthority,
  RetentionPreviewSummary
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { PREVIEW_LIFETIME_MS } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  checkMutationAuthority,
  runAuthorizedMutation,
  type LifecycleAuditRecord
} from '../../../src/services/artifact-lifecycle/mutation-authority';
import { PreviewStore } from '../../../src/services/artifact-lifecycle/previews';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const FULL: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };
const EMPTY_SUMMARY: RetentionPreviewSummary = {
  affectedCount: 1,
  affectedBytes: 10,
  protectedCount: 0,
  protectedBytes: 0,
  unclassifiedCount: 0,
  unclassifiedBytes: 0,
  perClass: [],
  protectedExceptions: [],
  coverage: 'complete',
  notes: []
};

function setup(): { conn: NodeSqliteConnection; previews: PreviewStore; clock: { now: number } } {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  const clock = { now: NOW };
  let next = 0;
  const previews = new PreviewStore(conn, () => clock.now, () => `preview-${(next += 1)}`);
  return { conn, previews, clock };
}

describe('FR-R6-F05 mutation authority (AC-09, FR-021)', () => {
  it('refuses in the fixed order: trust, primacy, audit, preview, confirmation', () => {
    const { conn, previews } = setup();
    try {
      const preview = previews.create('deletion', 'basis-1', EMPTY_SUMMARY);
      const check = (authority: MutationAuthority, previewId: string, confirmation: 'confirmed' | undefined) => {
        const result = checkMutationAuthority(previews, { authority, previewId, confirmation }, 'deletion', 'basis-1');
        return result.ok ? 'ok' : result.refusal.code;
      };
      const none: MutationAuthority = { trusted: false, primary: false, auditHealthy: false };
      expect(check(none, 'missing', undefined)).toBe('untrusted-workspace');
      expect(check({ ...none, trusted: true }, 'missing', undefined)).toBe('not-primary-window');
      expect(check({ trusted: true, primary: true, auditHealthy: false }, 'missing', undefined)).toBe('audit-unhealthy');
      expect(check(FULL, 'missing', undefined)).toBe('preview-required');
      expect(check(FULL, preview.previewId, undefined)).toBe('confirmation-required');
      expect(check(FULL, preview.previewId, 'confirmed')).toBe('ok');
    } finally {
      conn.close();
    }
  });

  it('refuses a preview of another kind, a stale basis and an expired preview', () => {
    const { conn, previews, clock } = setup();
    try {
      const preview = previews.create('deletion', 'basis-1', EMPTY_SUMMARY);
      const request = { authority: FULL, previewId: preview.previewId, confirmation: 'confirmed' as const };
      const code = (kind: 'deletion' | 'archival', basis: string): string => {
        const result = checkMutationAuthority(previews, request, kind, basis);
        return result.ok ? 'ok' : result.refusal.code;
      };
      expect(code('archival', 'basis-1')).toBe('preview-required');
      expect(code('deletion', 'basis-2')).toBe('preview-stale');
      clock.now = NOW + PREVIEW_LIFETIME_MS;
      expect(code('deletion', 'basis-1')).toBe('preview-expired');
    } finally {
      conn.close();
    }
  });

  it('runs no effect and emits no audit record when refused', () => {
    const { conn, previews } = setup();
    try {
      const audits: LifecycleAuditRecord[] = [];
      let ran = false;
      const result = runAuthorizedMutation(
        { previews, audit: { recordLifecycleMutation: (record) => audits.push(record) } },
        { authority: { ...FULL, trusted: false }, previewId: 'x', confirmation: 'confirmed' },
        'deletion',
        'basis-1',
        () => {
          ran = true;
          return { operationId: 'op-1', counts: {}, result: 'completed', value: 1 };
        }
      );
      expect(result.ok || result.refusal.code).toBe('untrusted-workspace');
      expect(ran).toBe(false);
      expect(audits).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('emits exactly one metadata-only audit record for an accepted mutation', () => {
    const { conn, previews } = setup();
    try {
      const preview = previews.create('deletion', 'basis-1', EMPTY_SUMMARY);
      const audits: LifecycleAuditRecord[] = [];
      const result = runAuthorizedMutation(
        { previews, audit: { recordLifecycleMutation: (record) => audits.push(record) } },
        { authority: FULL, previewId: preview.previewId, confirmation: 'confirmed' },
        'deletion',
        'basis-1',
        () => ({ operationId: 'op-1', counts: { deleted: 2, retained: 1 }, result: 'partial', value: 'done' })
      );
      expect(result).toEqual({ ok: true, value: 'done' });
      expect(audits).toEqual([
        { operationKind: 'deletion', operationId: 'op-1', counts: { deleted: 2, retained: 1 }, result: 'partial' }
      ]);
      expect(Object.keys(audits.at(0) ?? {}).sort()).toEqual(['counts', 'operationId', 'operationKind', 'result']);
    } finally {
      conn.close();
    }
  });

  it('persists previews so a restarted service still finds them', () => {
    const { conn, previews } = setup();
    try {
      const preview = previews.create('archival', 'basis-9', EMPTY_SUMMARY);
      const reopened = new PreviewStore(conn, () => NOW + 1, () => 'unused');
      const found = reopened.get(preview.previewId);
      expect(found.ok && found.value).toEqual(preview);
    } finally {
      conn.close();
    }
  });
});
