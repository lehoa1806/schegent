// FR-R6-F05 (T032, SC-009, contract surfaces-and-wiring.md §4, §5) — the headless lifecycle API and
// the sidebar storage-details handler answer the same value for the same state.
//
// The handler is driven through the reader production would wire once the store is open, against a
// real in-memory store. Reads are projections: neither surface touches the filesystem, appends an
// audit row or changes a record, so an untrusted or secondary window may run them.
import { describe, expect, it, vi } from 'vitest';
import { CMD_READ_STORAGE_DETAILS } from '../../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, ReadStorageDetailsCommand } from '../../../src/contracts/sidebar-ipc';
import {
  createStorageDetailsReader,
  getStorageInventory,
  getStoragePressure
} from '../../../src/headless/artifact-lifecycle-api';
import { handler } from '../../../src/ui/sidebar/commands/cmd-read-storage-details';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle/lifecycle-service';
import { lifecycleFixture, seedCheckpoint, type LifecycleFixture } from './lifecycle-fixture';

function seeded(): { fx: LifecycleFixture; service: ArtifactLifecycleService } {
  const fx = lifecycleFixture();
  const service = fx.build();
  seedCheckpoint(service, fx.fs, 'art-1');
  seedCheckpoint(service, fx.fs, 'art-2', { ownerRunId: 'run-2', byteSize: 90 });
  return { fx, service };
}

async function viaHandler(service: ArtifactLifecycleService, cursor?: string): Promise<CommandAckMessage> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s },
      storageDetails: createStorageDetailsReader(service)
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'parity-1'
  } as unknown as Parameters<typeof handler>[0];
  const command = {
    type: CMD_READ_STORAGE_DETAILS,
    correlationId: 'parity-1',
    payload: cursor === undefined ? {} : { cursor }
  } as ReadStorageDetailsCommand;
  await handler(ctx, command);
  expect(acks).toHaveLength(1);
  const first = acks.at(0);
  if (first === undefined) throw new Error('no ack');
  return first;
}

function resultOf(ackMessage: CommandAckMessage): unknown {
  return (ackMessage as unknown as { result: unknown }).result;
}

describe('artifact lifecycle surface parity (SC-009)', () => {
  it('gives the sidebar exactly the headless pressure report and first inventory page', async () => {
    const { service } = seeded();
    const pressure = getStoragePressure(service);
    const page = getStorageInventory(service);
    if (!pressure.ok || !page.ok) throw new Error('headless read refused');
    expect(page.value.entries).toHaveLength(2);

    const ackMessage = await viaHandler(service);
    expect(ackMessage.status).toBe('accepted');
    expect(resultOf(ackMessage)).toEqual({ ok: true, value: { pressure: pressure.value, page: page.value } });
  });

  it('refuses a cursor the service did not issue with the same refusal on both surfaces', async () => {
    const { service } = seeded();
    const headless = getStorageInventory(service, { cursor: 'not_a_real_cursor' });
    expect(headless.ok).toBe(false);
    if (headless.ok) return;

    const ackMessage = await viaHandler(service, 'not_a_real_cursor');
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe(headless.refusal.code);
    expect(resultOf(ackMessage)).toEqual(headless);
  });

  it('reads without touching the filesystem, the audit trail or the records', async () => {
    const { fx, service } = seeded();
    const before = getStorageInventory(service);
    const fsCallsBefore = fx.fs.calls.length;
    const auditsBefore = fx.audits.length;

    await viaHandler(service);
    getStoragePressure(service);

    expect(fx.fs.calls.length).toBe(fsCallsBefore);
    expect(fx.fs.unlinked).toEqual([]);
    expect(fx.audits.length).toBe(auditsBefore);
    expect(getStorageInventory(service)).toEqual(before);
  });
});
