// Feature 101 (US4, T045) — the four outcomes of CMD_READ_DEFINITION_VERSION.
//
// contracts/builder-projection.md §B.4 enumerates exactly four, and the whole
// point of enumerating them is that there is **no fifth and no empty-body
// fallback** (FR-012b): an empty body renders identically to a definition with
// no content, so a silent fallback would make a failed read look like a
// successful one. That is the property this file exists to hold — every
// assertion below that checks `status === 'rejected'` is also checking that no
// `result` rode along with it.
//
// The store collapses "the manifest does not name this version" and "the
// manifest names a record that is not there" into one `absent`, because from
// its side both are "there is nothing to hand you". They are not the same thing
// to an operator — the second is an integrity fault, someone's history has a
// hole in it — so the handler separates them with a second manifest read on the
// failure path only, and says so in the reason. Two reads on an error path is
// the price of not reporting a fault as a stale list.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as readDefinitionVersion } from '../../../src/ui/sidebar/commands/cmd-read-definition-version';
import { CMD_READ_DEFINITION_VERSION } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ReadDefinitionVersionCommand
} from '../../../src/contracts/sidebar-ipc';
import type {
  CatalogReadVersionOutcome,
  CatalogVersionMetadata
} from '../../../src/contracts/catalog-store';

const CORRELATION_ID = 'test-read-version-1';
const BODY = Object.freeze({ id: 'specify', instruction: 'Write the spec.', runner: 'claude' });

function metadata(versionId: string): CatalogVersionMetadata {
  return {
    versionId,
    contentHash: `sha256:${versionId}`,
    createdAt: 1_700_000_000_000,
    publishedAt: null,
    note: null
  };
}

interface StoreOpts {
  readonly readVersion?: CatalogReadVersionOutcome;
  readonly readThrows?: Error;
  readonly versions?: readonly CatalogVersionMetadata[];
  readonly withStore?: boolean;
}

function buildCtx(opts: StoreOpts = {}): {
  ctx: Parameters<typeof readDefinitionVersion>[0];
  acks: CommandAckMessage[];
  readSpy: ReturnType<typeof vi.fn>;
  listSpy: ReturnType<typeof vi.fn>;
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const readSpy = vi.fn(async (): Promise<CatalogReadVersionOutcome> => {
    if (opts.readThrows) throw opts.readThrows;
    return opts.readVersion ?? { outcome: 'read', record: { versionId: 'v2', kind: 'phase', id: 'specify', body: BODY } };
  });
  const listSpy = vi.fn(async (): Promise<readonly CatalogVersionMetadata[]> => opts.versions ?? []);
  const ctx = {
    deps: {
      catalogStore: opts.withStore === false ? null : { readVersion: readSpy, listVersions: listSpy },
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION_ID
  } as any;
  return { ctx, acks, readSpy, listSpy, warnings };
}

function makeCmd(
  payload: Partial<ReadDefinitionVersionCommand['payload']> = {}
): ReadDefinitionVersionCommand {
  return {
    type: CMD_READ_DEFINITION_VERSION,
    correlationId: CORRELATION_ID,
    payload: { kind: 'phase', id: 'specify', versionId: 'v2', ...payload }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-read-definition-version — outcome 1: the record reads (US4, T045)', () => {
  it('acks accepted with exactly the stored body', async () => {
    const { ctx, acks } = buildCtx();
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('accepted');
    expect(acks[0].correlationId).toBe(CORRELATION_ID);
    expect(acks[0].result).toEqual({ body: BODY });
  });

  it('addresses the store by coordinate — kind, id, versionId, never a path (FR-034)', async () => {
    const { ctx, readSpy } = buildCtx();
    await readDefinitionVersion(ctx, makeCmd({ kind: 'pipeline', id: 'ship-it', versionId: 'v7' }));
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith('pipeline', 'ship-it', 'v7');
  });

  it('does not consult the manifest a second time on the success path', async () => {
    const { ctx, listSpy } = buildCtx();
    await readDefinitionVersion(ctx, makeCmd());
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('cmd-read-definition-version — outcome 2: the manifest does not name it (US4, T045)', () => {
  it('acks rejected when the version is in no manifest entry', async () => {
    const { ctx, acks } = buildCtx({
      readVersion: { outcome: 'absent' },
      versions: [metadata('v1'), metadata('v3')]
    });
    await readDefinitionVersion(ctx, makeCmd({ versionId: 'v2' }));
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('unknown-version');
  });

  it('carries no result — an absent version is not an empty body (FR-012b)', async () => {
    const { ctx, acks } = buildCtx({ readVersion: { outcome: 'absent' }, versions: [] });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks[0]).not.toHaveProperty('result');
  });
});

describe('cmd-read-definition-version — outcome 3: the record behind the entry is gone (US4, T045)', () => {
  it('acks rejected as an integrity fault when the manifest names the version', async () => {
    const { ctx, acks } = buildCtx({
      readVersion: { outcome: 'absent' },
      versions: [metadata('v1'), metadata('v2')]
    });
    await readDefinitionVersion(ctx, makeCmd({ versionId: 'v2' }));
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('record-missing');
  });

  it('is a different reason from an unknown version — the two are not one outcome', async () => {
    const named = buildCtx({ readVersion: { outcome: 'absent' }, versions: [metadata('v2')] });
    await readDefinitionVersion(named.ctx, makeCmd({ versionId: 'v2' }));
    const unnamed = buildCtx({ readVersion: { outcome: 'absent' }, versions: [metadata('v1')] });
    await readDefinitionVersion(unnamed.ctx, makeCmd({ versionId: 'v2' }));
    expect(named.acks[0].reason).not.toBe(unnamed.acks[0].reason);
  });

  it('warns, because a hole in history is a host-side fault and not the operator\'s doing', async () => {
    const { ctx, warnings } = buildCtx({
      readVersion: { outcome: 'absent' },
      versions: [metadata('v2')]
    });
    await readDefinitionVersion(ctx, makeCmd({ versionId: 'v2' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('v2');
  });

  it('names no filesystem path in the warning (FR-034)', async () => {
    const { ctx, warnings } = buildCtx({
      readVersion: { outcome: 'absent' },
      versions: [metadata('v2')]
    });
    await readDefinitionVersion(ctx, makeCmd({ versionId: 'v2' }));
    expect(warnings[0]).not.toContain('/');
  });
});

describe('cmd-read-definition-version — outcome 4: the read fails (US4, T045)', () => {
  it('acks rejected when the store refuses', async () => {
    const { ctx, acks } = buildCtx({
      readVersion: { outcome: 'refused', reason: 'store-unreadable' }
    });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('read-failed');
    expect(acks[0]).not.toHaveProperty('result');
  });

  it('acks rejected when the record is there but does not verify', async () => {
    const { ctx, acks } = buildCtx({
      readVersion: { outcome: 'refused', reason: 'definition-invalid' }
    });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('read-failed');
  });

  it('acks rejected and warns when the store throws rather than returning', async () => {
    const { ctx, acks, warnings } = buildCtx({ readThrows: new Error('EIO') });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('read-failed');
    expect(acks[0]).not.toHaveProperty('result');
    expect(warnings).toHaveLength(1);
  });

  it('acks rejected when the stored body is not an object the panel can render', async () => {
    // Not a fifth outcome: the store verified the record's identity and hash,
    // not that its body is a definition. A body that is a bare string cannot be
    // the `Readonly<Record<string, unknown>>` the response promises, so it is
    // the same "this version could not be read" the operator already knows.
    const { ctx, acks } = buildCtx({
      readVersion: {
        outcome: 'read',
        record: { versionId: 'v2', kind: 'phase', id: 'specify', body: 'not a definition' }
      }
    });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('read-failed');
    expect(acks[0]).not.toHaveProperty('result');
  });
});

describe('cmd-read-definition-version — a host with no catalog store (US4, T045)', () => {
  it('acks rejected rather than inventing a body', async () => {
    // Not one of §B.4's four either: those describe a store that was asked. An
    // untrusted workspace activates no catalog (§B.3), so this is the precondition
    // failing before any of the four can apply. It still must not carry a result.
    const { ctx, acks } = buildCtx({ withStore: false });
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('catalog-unavailable');
    expect(acks[0]).not.toHaveProperty('result');
  });
});

describe('cmd-read-definition-version — the read writes nothing (US4, T045, SC-003)', () => {
  it('touches no store method other than the read and the failure-path manifest check', async () => {
    const store: Record<string, unknown> = {};
    const readSpy = vi.fn(async (): Promise<CatalogReadVersionOutcome> => ({
      outcome: 'read',
      record: { versionId: 'v2', kind: 'phase', id: 'specify', body: BODY }
    }));
    store['readVersion'] = readSpy;
    // Every other CatalogStore method throws: reaching one would be a write, a
    // rescan, or a manifest load this read has no business performing (FR-017).
    for (const method of ['applyLifecycleWrite', 'saveDraftLayer', 'publishLayer', 'read', 'listDefinitions']) {
      store[method] = () => {
        throw new Error(`cmd-read-definition-version must not call ${method}`);
      };
    }
    store['listVersions'] = vi.fn(async () => []);
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: { catalogStore: store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s } },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION_ID
    } as any;
    await readDefinitionVersion(ctx, makeCmd());
    expect(acks[0].status).toBe('accepted');
  });
});
