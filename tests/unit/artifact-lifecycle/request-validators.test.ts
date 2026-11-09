import { describe, expect, it } from 'vitest';
import {
  DELETION_SELECTION_MAX_IDS,
  INVENTORY_PAGE_MAX_ENTRIES
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { CMD_READ_STORAGE_DETAILS } from '../../../src/contracts/sidebar-ipc';
import {
  validateDeletionExecuteRequest,
  validateDeletionPreviewRequest,
  validateInventoryRequest,
  validateReadStorageDetails
} from '../../../src/contracts/validators/artifact-lifecycle';

const AUTHORITY = { trusted: true, primary: true, auditHealthy: true };

function refusalCode(result: { ok: boolean; refusal?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.refusal?.code;
}

describe('validateInventoryRequest', () => {
  it('accepts an absent request as the first page', () => {
    expect(validateInventoryRequest(undefined)).toEqual({ ok: true, value: {} });
  });

  it('accepts a cursor, a page size and a retention class', () => {
    const request = { cursor: 'abc_DEF-1', pageSize: 10, retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog' };
    expect(validateInventoryRequest(request)).toEqual({ ok: true, value: request });
  });

  it.each([
    ['an unknown key', { cursor: 'a', extra: 1 }],
    ['a non-object', 'cursor'],
    ['an array', []],
    ['a cursor with a slash', { cursor: 'a/b' }],
    ['an empty cursor', { cursor: '' }],
    ['an over-long cursor', { cursor: 'a'.repeat(513) }],
    ['a page size of zero', { pageSize: 0 }],
    ['a page size over the bound', { pageSize: INVENTORY_PAGE_MAX_ENTRIES + 1 }],
    ['a fractional page size', { pageSize: 1.5 }],
    ['an unknown retention class', { retentionClass: 'nope' }]
  ])('refuses %s as invalid-input', (_label, request) => {
    expect(refusalCode(validateInventoryRequest(request))).toBe('invalid-input');
  });
});

describe('validateDeletionPreviewRequest', () => {
  it('accepts an empty selection', () => {
    expect(validateDeletionPreviewRequest({})).toEqual({ ok: true, value: {} });
  });

  it('accepts explicit ids and a class', () => {
    const request = { artifactIds: ['art-1', 'art-2'], retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog' };
    expect(validateDeletionPreviewRequest(request)).toEqual({ ok: true, value: request });
  });

  it.each([
    ['an unknown key', { artifactIds: [], previewId: 'p' }],
    ['ids that are not an array', { artifactIds: 'art-1' }],
    ['a malformed id', { artifactIds: ['../etc'] }],
    ['a non-string id', { artifactIds: [7] }],
    ['too many ids', { artifactIds: Array.from({ length: DELETION_SELECTION_MAX_IDS + 1 }, (_, i) => `a${i}`) }],
    ['an unknown retention class', { retentionClass: 'nope' }]
  ])('refuses %s as invalid-input', (_label, request) => {
    expect(refusalCode(validateDeletionPreviewRequest(request))).toBe('invalid-input');
  });
});

describe('validateDeletionExecuteRequest', () => {
  const base = { previewId: 'preview-1', confirmation: 'confirmed', authority: AUTHORITY };

  it('accepts a confirmed request', () => {
    expect(validateDeletionExecuteRequest({ ...base, artifactIds: ['art-1'] })).toEqual({
      ok: true,
      value: { ...base, artifactIds: ['art-1'] }
    });
  });

  it('leaves a missing confirmation to the service gate, which refuses it in order', () => {
    const { confirmation: _omitted, ...unconfirmed } = base;
    expect(validateDeletionExecuteRequest(unconfirmed)).toEqual({
      ok: true,
      value: { ...unconfirmed, confirmation: undefined }
    });
  });

  it('passes a false authority flag through for the service gate to refuse', () => {
    const request = { ...base, authority: { ...AUTHORITY, trusted: false } };
    expect(validateDeletionExecuteRequest(request).ok).toBe(true);
  });

  it.each([
    ['an unknown key', { ...base, force: true }],
    ['a missing preview id', { confirmation: 'confirmed', authority: AUTHORITY }],
    ['a malformed preview id', { ...base, previewId: 'a b' }],
    ['a confirmation other than confirmed', { ...base, confirmation: 'yes' }],
    ['a missing authority', { previewId: 'p', confirmation: 'confirmed' }],
    ['a non-boolean authority flag', { ...base, authority: { ...AUTHORITY, primary: 'true' } }],
    ['an extra authority key', { ...base, authority: { ...AUTHORITY, admin: true } }],
    ['a malformed id', { ...base, artifactIds: ['a/b'] }]
  ])('refuses %s as invalid-input', (_label, request) => {
    expect(refusalCode(validateDeletionExecuteRequest(request))).toBe('invalid-input');
  });
});

describe('validateReadStorageDetails', () => {
  const context = { type: CMD_READ_STORAGE_DETAILS, correlationId: 'c-1' };

  it('accepts an empty payload and a cursor', () => {
    expect(validateReadStorageDetails({ payload: {} }, 'c-1')).toEqual({ ok: true, command: { ...context, payload: {} } });
    expect(validateReadStorageDetails({ payload: { cursor: 'abc' } }, 'c-1')).toEqual({
      ok: true,
      command: { ...context, payload: { cursor: 'abc' } }
    });
  });

  it.each([
    ['a missing payload', {}, 'missing-payload'],
    ['an unknown payload key', { payload: { cursor: 'a', pageSize: 5 } }, 'unexpected-payload-fields'],
    ['a malformed cursor', { payload: { cursor: 'a/b' } }, 'invalid-cursor'],
    ['a non-string cursor', { payload: { cursor: 5 } }, 'invalid-cursor']
  ])('refuses %s', (_label, obj, reason) => {
    expect(validateReadStorageDetails(obj as Record<string, unknown>, 'c-1')).toEqual({ ok: false, reason, ...context });
  });
});
