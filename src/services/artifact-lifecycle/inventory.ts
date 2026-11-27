/**
 * FR-R6-F05 — the paged storage inventory (FR-009, FR-012, NFR-001).
 *
 * Registered artifacts come first, by keyset on `(retention_class,
 * artifact_id)`, so a cursor never skips or repeats a row when rows are
 * inserted on either side of it. After them come the entries of the latest
 * scan this service took, by position. A page holds at most
 * `INVENTORY_PAGE_MAX_ENTRIES` entries and stays under
 * `INVENTORY_PAGE_MAX_BYTES` serialized.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  INVENTORY_CURSOR_PATTERN,
  INVENTORY_PAGE_MAX_BYTES,
  INVENTORY_PAGE_MAX_ENTRIES,
  type ArtifactRecord,
  type LifecycleResult,
  type RetentionClassId,
  type StorageInventoryEntry,
  type StorageInventoryPage,
  type StorageInventoryRequest
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { RETENTION_CLASS_IDS } from '../../contracts/shared-memory-storage/consumer-and-retention-inventories';
import { pinnedRunsOf, standingOf, type LifecycleContext } from './lifecycle-context';
import { includesValue, ok, refuse } from './lifecycle-results';
import type { StorageScanSnapshot } from './storage-scan';
import { inventoryCoverage } from './storage-pressure';

/** Room left in the byte budget for the page envelope (`nextCursor`, `coverage`). */
const PAGE_ENVELOPE_RESERVE_BYTES = 512;
const CURSOR_VERSION = 1;

export type InventoryRequest = StorageInventoryRequest;

type InventoryCursor =
  | { readonly v: 1; readonly p: 'r'; readonly c: string; readonly a: string }
  | { readonly v: 1; readonly p: 's'; readonly s: string; readonly i: number };

interface Candidate {
  readonly entry: StorageInventoryEntry;
  /** The cursor that resumes after this entry. */
  readonly after: InventoryCursor;
}

/** The longest prefix of `entries` that fits `maxEntries` and serializes to at most `maxBytes`. */
export function boundInventoryPage(
  entries: readonly StorageInventoryEntry[],
  maxEntries: number,
  maxBytes: number
): readonly StorageInventoryEntry[] {
  let total = 2;
  let count = 0;
  for (const entry of entries) {
    if (count >= maxEntries) break;
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (count > 0 ? 1 : 0);
    if (total + size > maxBytes) break;
    total += size;
    count += 1;
  }
  return entries.slice(0, count);
}

function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): InventoryCursor | null {
  if (!INVENTORY_CURSOR_PATTERN.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value['v'] !== CURSOR_VERSION) return null;
  if (value['p'] === 'r' && typeof value['c'] === 'string' && typeof value['a'] === 'string') {
    return { v: CURSOR_VERSION, p: 'r', c: value['c'], a: value['a'] };
  }
  const index = value['i'];
  if (value['p'] === 's' && typeof value['s'] === 'string' && Number.isSafeInteger(index) && (index as number) >= 0) {
    return { v: CURSOR_VERSION, p: 's', s: value['s'], i: index as number };
  }
  return null;
}

function registeredEntry(ctx: LifecycleContext, record: ArtifactRecord, pinnedRuns: ReadonlySet<string>): StorageInventoryEntry {
  const standing = standingOf(ctx, record, pinnedRuns);
  return {
    artifactId: record.artifactId,
    source: 'registered',
    rootId: null,
    retentionClass: standing.unclassified ? null : record.retentionClass,
    storeKind: record.storeKind,
    byteSize: record.byteSize,
    availability: record.availability,
    protected: standing.protected,
    eligible: standing.eligible
  };
}

function scanCandidates(
  snapshot: StorageScanSnapshot | null,
  retentionClass: RetentionClassId | undefined,
  from: number,
  limit: number
): Candidate[] {
  if (snapshot === null || limit <= 0) return [];
  const matching =
    retentionClass === undefined
      ? snapshot.entries
      : snapshot.entries.filter((entry) => entry.retentionClass === retentionClass);
  return matching.slice(from, from + limit).map((entry, offset) => ({
    entry,
    after: { v: CURSOR_VERSION, p: 's', s: snapshot.scanId, i: from + offset + 1 }
  }));
}

function collectCandidates(
  ctx: LifecycleContext,
  snapshot: StorageScanSnapshot | null,
  cursor: InventoryCursor | null,
  pageSize: number,
  retentionClass: RetentionClassId | undefined
): Candidate[] {
  const wanted = pageSize + 1;
  if (cursor?.p === 's') return scanCandidates(snapshot, retentionClass, cursor.i, wanted);
  const after = cursor === null ? undefined : { retentionClass: cursor.c, artifactId: cursor.a };
  const rows = ctx.records.pageManaged({ after, retentionClass, limit: wanted });
  const pinnedRuns = pinnedRunsOf(ctx);
  const registered: Candidate[] = rows.map((record) => ({
    entry: registeredEntry(ctx, record, pinnedRuns),
    after: { v: CURSOR_VERSION, p: 'r', c: record.retentionClass, a: record.artifactId }
  }));
  if (rows.length > pageSize) return registered;
  return [...registered, ...scanCandidates(snapshot, retentionClass, 0, wanted - rows.length)];
}

/** One inventory page; refuses a page size outside 1..200 and a cursor this service did not issue. */
export function listInventory(
  ctx: LifecycleContext,
  snapshot: StorageScanSnapshot | null,
  request: InventoryRequest
): LifecycleResult<StorageInventoryPage> {
  const pageSize = request.pageSize ?? INVENTORY_PAGE_MAX_ENTRIES;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > INVENTORY_PAGE_MAX_ENTRIES) {
    return refuse('invalid-input', `page size must be an integer from 1 to ${INVENTORY_PAGE_MAX_ENTRIES}`);
  }
  if (request.retentionClass !== undefined && !includesValue(RETENTION_CLASS_IDS, request.retentionClass)) {
    return refuse('invalid-input', 'retention class is not recognised');
  }
  const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor);
  if (request.cursor !== undefined && cursor === null) return refuse('invalid-input', 'cursor is malformed');
  if (cursor?.p === 's' && cursor.s !== snapshot?.scanId) {
    return refuse('invalid-input', 'cursor belongs to a scan that is no longer current; restart the listing');
  }
  const candidates = collectCandidates(ctx, snapshot, cursor, pageSize, request.retentionClass);
  const entries = boundInventoryPage(
    candidates.map((candidate) => candidate.entry),
    pageSize,
    INVENTORY_PAGE_MAX_BYTES - PAGE_ENVELOPE_RESERVE_BYTES
  );
  const last = candidates.at(entries.length - 1);
  const more = entries.length < candidates.length && last !== undefined;
  return ok({
    entries,
    nextCursor: more ? encodeCursor(last.after) : null,
    coverage: inventoryCoverage(ctx)
  });
}
