// Feature 101 (US4, T052) — read one past version's body, on demand.
//
// contracts/builder-projection.md §B.4 enumerates exactly four outcomes, and the
// point of enumerating them is that there is no fifth and **no empty-body
// fallback** (FR-012b): an empty body renders identically to a definition with
// no content, so a fallback would turn every failed read into a plausible
// successful one. Every rejection below therefore acks with a reason and no
// `result` at all.
//
// The read writes nothing and moves no timestamp (FR-017, SC-003) — it is one
// `store.readVersion`, which is itself a manifest load and a record read.
//
// No path is accepted and none is returned (FR-034). The request is a
// coordinate; the reasons name a version id and never a location.

import type { CatalogKind } from '../../../contracts/catalog-store';
import type {
  ReadDefinitionVersionCommand,
  ReadDefinitionVersionResponse
} from '../../../contracts/sidebar-ipc';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

/**
 * Why the read produced no body.
 *
 * Four reasons for four §B.4 rows plus the unwired host, and no reason that
 * means "here is a body anyway".
 */
type RejectionReason =
  /** No catalog store — an untrusted or unopened workspace (§B.3). */
  | 'catalog-unavailable'
  /** The manifest names no such version for this definition. */
  | 'unknown-version'
  /** The manifest names it and the record behind it is not there: an integrity fault. */
  | 'record-missing'
  /** The store refused: an I/O failure, or a record that did not verify. */
  | 'read-failed';

export const handler: CommandHandler<ReadDefinitionVersionCommand> = async (ctx, command) => {
  const store = ctx.deps.catalogStore;
  if (!store) {
    await ack(ctx, 'rejected', 'catalog-unavailable' satisfies RejectionReason);
    return;
  }

  const { kind, id, versionId } = command.payload;

  let outcome: Awaited<ReturnType<typeof store.readVersion>>;
  try {
    outcome = await store.readVersion(kind, id, versionId);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: definition version read threw for ${describe(kind, id, versionId)}: `
        + ctx.deps.logger.sanitize((err as Error).message ?? 'unknown error')
    );
    await ack(ctx, 'rejected', 'read-failed' satisfies RejectionReason);
    return;
  }

  if (outcome.outcome === 'read') {
    const body = outcome.record.body;
    // The store verified the record's identity and its hash, not that its body
    // is an object. A body that is not one cannot be the response's
    // `Readonly<Record<string, unknown>>`, and is the same "this version could
    // not be read" as any other unreadable record — not a fifth outcome, and
    // certainly not an occasion to invent `{}`.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      await ack(ctx, 'rejected', 'read-failed' satisfies RejectionReason);
      return;
    }
    const response: ReadDefinitionVersionResponse = { body: body as Record<string, unknown> };
    await ack(ctx, 'accepted', undefined, response);
    return;
  }

  if (outcome.outcome === 'refused') {
    await ack(ctx, 'rejected', 'read-failed' satisfies RejectionReason);
    return;
  }

  // `absent` is two different things wearing one name. From the store's side
  // both are "there is nothing to hand you"; to an operator, a version the
  // manifest never named is a stale list, and a version it does name with no
  // record behind it is a hole in their history. Separating them costs one
  // manifest read, on the failure path only.
  const named = (await store.listVersions(kind, id)).some(
    (version) => version.versionId === versionId
  );
  if (!named) {
    await ack(ctx, 'rejected', 'unknown-version' satisfies RejectionReason);
    return;
  }
  ctx.deps.logger.warn(
    `sidebar router: catalog integrity fault — manifest names ${describe(kind, id, versionId)} `
      + 'but its record is absent'
  );
  await ack(ctx, 'rejected', 'record-missing' satisfies RejectionReason);
};

/** The coordinate, for the log. Three segments and no separator a path uses (FR-034). */
function describe(kind: CatalogKind, id: string, versionId: string): string {
  return `${kind} ${id} at ${versionId}`;
}
