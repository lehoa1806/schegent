/**
 * FR-R6-F06 (T028, contracts/surfaces-and-wiring.md section 4) — the headless accounting reads.
 * Every input passes the shared validator first; a `null` reader answers `store-unavailable`;
 * a real reader returns the facade's result unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_QUALIFICATIONS } from '../../../src/contracts/usage-accounting/provider-qualifications';
import {
  createUsageAccountingReader,
  queryUsageAccounting,
  readUsageAccountingGaps,
  readUsageAccountingQualifications
} from '../../../src/headless/usage-accounting-api';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import { CLAUDE_PHASE_END, cliInvocationRow } from '../../fixtures/usage-accounting/phase-end-rows';
import { PhaseEndCorrelator } from '../../../src/services/usage-accounting/phase-end-ingestion';

const NOW = '2026-11-10T12:00:00.000Z';
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function seededService() {
  const service = createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
  const correlator = new PhaseEndCorrelator();
  correlator.observe(cliInvocationRow({}));
  const snapshot = correlator.observe(CLAUDE_PHASE_END);
  if (snapshot === undefined) throw new Error('no snapshot');
  service.ingestPhaseEnd(snapshot);
  return service;
}

describe('headless usage accounting API (T028)', () => {
  it('answers store-unavailable for every read on a null reader', () => {
    const reader = createUsageAccountingReader(null);
    const unavailable = { ok: false, refusal: { code: 'store-unavailable' } };
    expect(queryUsageAccounting(reader, QUERY)).toEqual(unavailable);
    expect(readUsageAccountingGaps(reader, {})).toEqual(unavailable);
    expect(readUsageAccountingQualifications(reader)).toEqual(unavailable);
  });

  it('returns the facade result unchanged on a real reader', () => {
    const service = seededService();
    const reader = createUsageAccountingReader(service);
    const answer = queryUsageAccounting(reader, QUERY);
    expect(answer.ok).toBe(true);
    expect(answer).toEqual(service.query(QUERY));
    expect(readUsageAccountingGaps(reader, {})).toEqual(service.readGaps({}));
    expect(readUsageAccountingQualifications(reader)).toEqual({ ok: true, value: PROVIDER_QUALIFICATIONS });
  });

  it('refuses an invalid request before the reader sees it', () => {
    const service = seededService();
    const query = vi.spyOn(service, 'query');
    const readGaps = vi.spyOn(service, 'readGaps');
    const reader = createUsageAccountingReader(service);
    expect(queryUsageAccounting(reader, { ...QUERY, limit: 0 })).toEqual({
      ok: false,
      refusal: { code: 'invalid-query', detail: 'limit' }
    });
    expect(readUsageAccountingGaps(reader, { surprise: true })).toMatchObject({
      ok: false,
      refusal: { code: 'invalid-query' }
    });
    expect(queryUsageAccounting(createUsageAccountingReader(null), 'not-an-object')).toMatchObject({
      ok: false,
      refusal: { code: 'invalid-query' }
    });
    expect(query).not.toHaveBeenCalled();
    expect(readGaps).not.toHaveBeenCalled();
  });
});
