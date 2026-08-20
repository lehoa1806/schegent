// Feature 100 (FR-R3-016) T499, T500 — the lifecycle service.
//
// Every decision about a definition's state lives here. The store owns the write
// sequence and nothing else: it is told which of five instructions to run and it
// runs it. This file decides which one, and why a refusal is a refusal.
//
// The division matters because both halves re-check the same gate, on purpose.
// This service checks `expectedDraftVersion` against the snapshot it read so it
// can build a *structured* refusal — the authoritative record, the legal actions,
// every defect (FR-015). The store checks it again against the manifest the write
// itself loaded, because a gate checked before a write is a gate a concurrent
// writer can slip under. Neither check makes the other redundant: one produces the
// operator's answer, the other produces the guarantee.
//
// Two things this service is deliberately not:
//
//   - It is **not a validator**. It calls one (FR-017) through the
//     `DefinitionSemantics` port, because a definition's meaning lives in
//     `src/config/` and cannot be imported into a pure directory. A second oracle
//     here is the defect FR-017 names by name.
//   - It **deletes nothing**, on any path, including the paths where deleting
//     would tidy up. Deactivation retains history (FR-024, FR-028); a restore that
//     replaces a draft retains the replaced draft's record (FR-029b); a failed
//     write stays written (FR-037).

import {
  definitionStateOf,
  draftTokenOf,
  legalActionsFor,
  NO_DRAFT,
  type DeactivateOutcome,
  type DeactivateRequest,
  type DefinitionRecord,
  type DiscardDraftOutcome,
  type DiscardDraftRequest,
  type ExpectedDraftVersion,
  type LifecycleAction,
  type LifecycleAdvisory,
  type LifecycleRefusal,
  type LifecycleRefusalReason,
  type PackagePublishOutcome,
  type PackagePublishRequest,
  type PublishOutcome,
  type PublishRequest,
  type ReferenceBlocker,
  type RestoreOutcome,
  type RestoreRequest,
  type SaveDraftOutcome,
  type SaveDraftRequest,
  type ValidationDefect
} from '../contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogReadVersionOutcome,
  CatalogSnapshot,
  CatalogVersionId,
  LifecycleWriteOutcome,
  LifecycleWritePointers,
  StoredDefinition
} from '../contracts/catalog-store';
import type { CatalogStore } from './catalog-store';
import type { DefinitionSemantics } from './ports';

export interface LifecycleServicePorts {
  readonly store: CatalogStore;
  readonly semantics: DefinitionSemantics;
}

export interface LifecycleService {
  /**
   * Write a new draft version, leaving the active pointer exactly where it is
   * (FR-011, FR-012, FR-013, FR-015).
   */
  saveDraft(request: SaveDraftRequest): Promise<SaveDraftOutcome>;
  /** Validate, then move. Never one without the other (FR-016, FR-020, FR-023). */
  publish(request: PublishRequest): Promise<PublishOutcome>;
  /**
   * Copy a past version's body into a new draft, leaving the active pointer where
   * it is and every existing record exactly as it is (FR-029, FR-030).
   */
  restore(request: RestoreRequest): Promise<RestoreOutcome>;
  /**
   * Take a definition out of service: clear the active pointer, keep every version,
   * delete nothing, and land in Draft (FR-024, FR-024a, FR-028).
   */
  deactivate(request: DeactivateRequest): Promise<DeactivateOutcome>;
  /** Throw away the pending edit and nothing else (FR-033, FR-034). */
  discardDraft(request: DiscardDraftRequest): Promise<DiscardDraftOutcome>;
}

/**
 * Feature 100 (T508) — the five per-definition operations plus the package
 * publish, as the one thing the host wires and the command handlers depend on.
 *
 * A single dependency rather than two, because the two halves are never wired
 * apart: both need the same store and the same `DefinitionSemantics`, and a host
 * holding one without the other would be a host where five of the six lifecycle
 * commands work. The package publish stays a free function inside this directory
 * — it is a sequence over the store, not a sixth method of the service — and is
 * bound onto this interface at the wiring seam.
 */
export interface CatalogLifecycleOps extends LifecycleService {
  publishPackage(request: PackagePublishRequest): Promise<PackagePublishOutcome>;
}

/** The record a refusal carries when the definition is not in the manifest at all. */
function absentRecord(kind: CatalogKind, id: string): DefinitionRecord {
  return {
    kind,
    id,
    state: null,
    draftVersionId: null,
    activeVersionId: null,
    expectedDraftVersion: NO_DRAFT
  };
}

function recordOf(
  kind: CatalogKind,
  id: string,
  draftVersionId: CatalogVersionId | null,
  activeVersionId: CatalogVersionId | null
): DefinitionRecord {
  return {
    kind,
    id,
    state: definitionStateOf(draftVersionId, activeVersionId),
    draftVersionId,
    activeVersionId,
    expectedDraftVersion: draftTokenOf(draftVersionId)
  };
}

/** What the caller should have sent, read off the snapshot this service holds. */
function recordOfDefinition(definition: StoredDefinition): DefinitionRecord {
  return recordOf(
    definition.kind,
    definition.id,
    definition.draftVersionId,
    definition.activeVersionId
  );
}

/**
 * What the caller should have sent, read off the manifest the *store* held.
 *
 * A refusal raised after the write began must quote the store's pointers rather
 * than this service's snapshot: the snapshot is what the caller already acted on,
 * so echoing it back would tell an operator to retry with the token that just
 * failed (FR-015).
 */
function recordOfPointers(
  kind: CatalogKind,
  id: string,
  pointers: LifecycleWritePointers
): DefinitionRecord {
  if (!pointers.present) return absentRecord(kind, id);
  return recordOf(kind, id, pointers.draftVersionId, pointers.activeVersionId);
}

interface RefusalDetail {
  readonly defects?: readonly ValidationDefect[];
  readonly blockers?: readonly ReferenceBlocker[];
  readonly advisories?: readonly LifecycleAdvisory[];
  readonly storeReason?: string;
}

function refuse(
  reason: LifecycleRefusalReason,
  current: DefinitionRecord,
  detail: RefusalDetail = {}
): LifecycleRefusal {
  const legalActions: readonly LifecycleAction[] = legalActionsFor(current.state);
  return { reason, current, legalActions, ...detail };
}

function findDefinition(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  id: string
): StoredDefinition | null {
  return (
    snapshot.definitions.find(
      (definition) => definition.kind === kind && definition.id === id
    ) ?? null
  );
}

/**
 * The store could not produce a snapshot at all — an unreadable manifest, an
 * unsupported format, an I/O fault (FR-031, FR-032).
 *
 * Reported as `store-refused` carrying the fault's name, never as a state-shaped
 * refusal: the difference between "your token is stale" and "the store cannot be
 * read" is the difference between retrying and stopping.
 */
function unreadableStoreRefusal(kind: CatalogKind, id: string, fault: string): LifecycleRefusal {
  return refuse('store-refused', absentRecord(kind, id), { storeReason: fault });
}

/**
 * The reason an operation's own precondition did not hold when the store looked.
 *
 * The store answers `not-applicable` for the race the expected-draft gate cannot
 * catch: the token named the draft pointer and the draft pointer is exactly where
 * the caller left it, but the *other* pointer moved underneath. Every arm here is
 * a lost race, which is why each reports the precondition rather than staleness —
 * "there is nothing active" is actionable and "you are out of date" is not.
 */
function unmetPreconditionReason(
  action: LifecycleAction,
  pointers: LifecycleWritePointers
): LifecycleRefusalReason {
  if (!pointers.present) return 'no-definition';
  switch (action) {
    case 'deactivate':
      return 'not-active';
    case 'publish':
    case 'discard-draft':
      return 'no-draft';
    default:
      // `save-draft` and `restore` write a record rather than move a pointer, and
      // the store answers them from the write path, which has no `not-applicable`
      // arm to reach. Kept total rather than thrown: a refusal is a value in this
      // stack, and an exception here would be the one path that is not.
      return 'no-definition';
  }
}

/**
 * Why the version a restore names could not be read (FR-031).
 *
 * Split rather than folded into one reason, because the two say different things to
 * an operator: `version-unreadable` is about *that version* and every other one is
 * still restorable, while a store that cannot be read at all is not a version
 * problem and retrying with a different version will not help.
 */
function sourceRefusal(
  current: DefinitionRecord,
  read: Exclude<CatalogReadVersionOutcome, { outcome: 'read' }>
): LifecycleRefusal {
  if (read.outcome === 'absent' || read.reason === 'definition-invalid') {
    return refuse('version-unreadable', current);
  }
  return refuse('store-refused', current, { storeReason: read.reason });
}

/** The store's answer, in the caller's vocabulary, for the arms every operation shares. */
function sharedRefusal(
  action: LifecycleAction,
  kind: CatalogKind,
  id: string,
  written: Extract<
    LifecycleWriteOutcome,
    { outcome: 'stale' | 'not-applicable' | 'refused' }
  >
): LifecycleRefusal {
  if (written.outcome === 'refused') {
    return refuse('store-refused', absentRecord(kind, id), { storeReason: written.reason });
  }
  const current = recordOfPointers(kind, id, written.pointers);
  if (written.outcome === 'stale') return refuse('stale-draft', current);
  return refuse(unmetPreconditionReason(action, written.pointers), current);
}

export function createLifecycleService(ports: LifecycleServicePorts): LifecycleService {
  const { store, semantics } = ports;

  /**
   * Read the store and locate one definition, or the refusal that replaces both.
   *
   * `definition` is `null` for an id the manifest does not hold, which is not an
   * error for a save — it is the first draft (FR-005).
   */
  async function locate(
    kind: CatalogKind,
    id: string
  ): Promise<
    | { readonly outcome: 'located'; readonly snapshot: CatalogSnapshot; readonly definition: StoredDefinition | null }
    | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal }
  > {
    const read = await store.read();
    if (read.outcome === 'unavailable') {
      return {
        outcome: 'refused',
        refusal: unreadableStoreRefusal(kind, id, read.fault.fault)
      };
    }
    return {
      outcome: 'located',
      snapshot: read.snapshot,
      definition: findDefinition(read.snapshot, kind, id)
    };
  }

  /**
   * The token gate, evaluated against the snapshot.
   *
   * Scoped to the single definition being written, and to its **draft pointer
   * alone** (FR-012a, FR-012b). A publication or deactivation of some other
   * definition moves no draft pointer here, so it cannot invalidate this edit —
   * which is the whole of FR-013, and the reason this is not a store-wide revision
   * gate the way a layer write's is.
   */
  function tokenMismatch(
    definition: StoredDefinition | null,
    expected: ExpectedDraftVersion
  ): boolean {
    return expected !== draftTokenOf(definition?.draftVersionId ?? null);
  }

  async function saveDraft(request: SaveDraftRequest): Promise<SaveDraftOutcome> {
    const { kind, id, expectedDraftVersion } = request;

    const located = await locate(kind, id);
    if (located.outcome === 'refused') {
      return { outcome: 'refused', refusal: located.refusal };
    }

    // The draft pointer decides, and it decides alone. The active pointer is
    // neither read here nor named in the instruction, so a save over a live
    // definition leaves what runs untouched for as long as the draft is unpublished
    // (FR-011, FR-012b).
    if (tokenMismatch(located.definition, expectedDraftVersion)) {
      const current =
        located.definition === null
          ? absentRecord(kind, id)
          : recordOfDefinition(located.definition);
      return { outcome: 'refused', refusal: refuse('stale-draft', current) };
    }

    const written = await store.applyLifecycleWrite({
      op: 'save-draft',
      kind,
      id,
      expectedDraftVersion,
      body: request.body,
      ...(request.note === undefined ? {} : { note: request.note })
    });

    switch (written.outcome) {
      case 'written': {
        // `writtenVersionId` is the record this call created. A `save-draft` always
        // writes one, so its null arm belongs to the pointer-only operations. It is
        // narrowed rather than asserted away: a `!` here would turn a store that
        // contradicted itself into an `undefined` handed to a caller as a version id.
        const draftVersionId = written.writtenVersionId;
        if (draftVersionId === null) {
          return {
            outcome: 'refused',
            refusal: refuse(
              'store-refused',
              recordOf(kind, id, written.draftVersionId, written.activeVersionId),
              { storeReason: 'no-version-written' }
            )
          };
        }
        return { outcome: 'saved', draftVersionId };
      }
      case 'unchanged':
        // The head already holds this body, so no version was appended (FR-011a).
        // Opening an editor and closing it does not manufacture history.
        return { outcome: 'unchanged', draftVersionId: written.versionId };
      case 'partial':
        return { outcome: 'partial', wrote: written.wrote, errno: written.errno };
      default:
        return {
          outcome: 'refused',
          refusal: sharedRefusal('save-draft', kind, id, written)
        };
    }
  }

  async function publish(request: PublishRequest): Promise<PublishOutcome> {
    const { kind, id, expectedDraftVersion } = request;

    const located = await locate(kind, id);
    if (located.outcome === 'refused') {
      return { outcome: 'refused', refusal: located.refusal };
    }

    const { definition, snapshot } = located;
    if (definition === null) {
      return { outcome: 'refused', refusal: refuse('no-definition', absentRecord(kind, id)) };
    }

    const current = recordOfDefinition(definition);

    // Refused, never a silent no-op (FR-023). Checked before the token, so the
    // operator is told the thing that is actionable: a definition with nothing
    // pending has nothing to publish whatever token was sent.
    if (definition.draftVersionId === null) {
      return { outcome: 'refused', refusal: refuse('no-draft', current) };
    }

    if (tokenMismatch(definition, expectedDraftVersion)) {
      return { outcome: 'refused', refusal: refuse('stale-draft', current) };
    }

    // The snapshot carries the draft body already (T498f), so the gate validates
    // what a read has verified the hash of rather than re-reading the record.
    // A draft pointer with no body is a broken record, which is a refusal of its
    // own: publishing it would make an unreadable version the live one (FR-031).
    if (definition.draftBody === null) {
      return { outcome: 'refused', refusal: refuse('version-unreadable', current) };
    }

    // Validate, then move — and move nothing at all when validation fails (FR-016).
    // The candidate set is this one definition, overlaid on the active catalog, so
    // a Pipeline whose own draft binds a Phase that is already active validates
    // against what will be live, not against what is (FR-017, FR-018).
    const defects = semantics.defectsOf(snapshot, [
      { kind, id, body: definition.draftBody }
    ]);
    if (defects.length > 0) {
      // Every defect, not the first (FR-019, SC-003). One refusal an operator can
      // fix in one pass beats N publish attempts that each name one more.
      return { outcome: 'refused', refusal: refuse('validation-failed', current, { defects }) };
    }

    const written = await store.applyLifecycleWrite({
      op: 'publish',
      kind,
      id,
      expectedDraftVersion
    });

    if (written.outcome === 'written') {
      // `activeVersionId` and `publishedAt` are both non-null on a publication: the
      // store sets the active pointer to the draft version and stamps the time on
      // it in the same manifest write (FR-020). Retention ran there too, so `pruned`
      // is its report rather than a second pass here (FR-021).
      //
      // Narrowed for the same reason the save path narrows its version id — a
      // publication that reported success while naming no active version is a store
      // fault, and inventing a `0` publication time would put a fabricated instant
      // into an operator's history.
      const { activeVersionId, publishedAt } = written;
      if (activeVersionId === null || publishedAt === null) {
        return {
          outcome: 'refused',
          refusal: refuse(
            'store-refused',
            recordOf(kind, id, written.draftVersionId, activeVersionId),
            { storeReason: 'no-active-version' }
          )
        };
      }
      return { outcome: 'published', activeVersionId, publishedAt, pruned: written.pruned };
    }
    if (written.outcome === 'unchanged') {
      // Not reachable: `unchanged` is the record writer's short-circuit and a
      // publication writes no record. Mapped rather than ignored so the switch
      // over the store's union stays total.
      return { outcome: 'refused', refusal: refuse('no-draft', current) };
    }
    if (written.outcome === 'partial') {
      // Also not reachable: a publication is one manifest write, so there is no
      // second file for a partial to have stopped between.
      return {
        outcome: 'refused',
        refusal: refuse('store-refused', current, { storeReason: written.errno })
      };
    }
    return { outcome: 'refused', refusal: sharedRefusal('publish', kind, id, written) };
  }

  async function restore(request: RestoreRequest): Promise<RestoreOutcome> {
    const { kind, id, expectedDraftVersion, fromVersionId } = request;

    const located = await locate(kind, id);
    if (located.outcome === 'refused') {
      return { outcome: 'refused', refusal: located.refusal };
    }

    const { definition } = located;
    if (definition === null) {
      return { outcome: 'refused', refusal: refuse('no-definition', absentRecord(kind, id)) };
    }

    const current = recordOfDefinition(definition);

    // The same token a save is guarded by, for the same reason (FR-029b): a restore
    // over a pending draft *replaces* it, so restoring against a stale view would
    // silently discard an edit. The refusal is the same structured staleness answer
    // rather than a shape of its own.
    if (tokenMismatch(definition, expectedDraftVersion)) {
      return { outcome: 'refused', refusal: refuse('stale-draft', current) };
    }

    // Read the source before writing anything, so a version that is absent or fails
    // its hash check creates **no** draft (FR-031). `readVersion` verifies the hash
    // itself, which is why there is no second integrity check here.
    const version = await store.readVersion(kind, id, fromVersionId);
    if (version.outcome !== 'read') {
      return { outcome: 'refused', refusal: sourceRefusal(current, version) };
    }

    // What the write is about to replace, read before it does. A restore replaces a
    // pending draft rather than coexisting with it (FR-029a); the replaced draft's
    // record stays on disk and in `versions`, so this names history rather than
    // something that was destroyed (FR-029b).
    const replacedDraftVersionId = definition.draftVersionId;

    // Only the **body** travels. `createdAt`, `publishedAt`, and `note` belong to
    // the version this came from, and copying them forward would attribute the
    // original write's time and the original operator's words to this one (FR-029).
    // The restored body is not validated here: a version that validated once need
    // not validate now, and the publish gate is where that is decided (FR-032).
    const written = await store.applyLifecycleWrite({
      op: 'restore',
      kind,
      id,
      expectedDraftVersion,
      body: version.record.body,
      fromVersionId
    });

    switch (written.outcome) {
      case 'written': {
        const draftVersionId = written.writtenVersionId;
        if (draftVersionId === null) {
          return {
            outcome: 'refused',
            refusal: refuse(
              'store-refused',
              recordOf(kind, id, written.draftVersionId, written.activeVersionId),
              { storeReason: 'no-version-written' }
            )
          };
        }
        return { outcome: 'restored', draftVersionId, fromVersionId, replacedDraftVersionId };
      }
      case 'unchanged':
        // The pending draft already holds exactly this body, so the restore is
        // idempotent and appends nothing. Reported as `restored` because it is: the
        // draft holds the requested version's body, which is the whole of what was
        // asked for. Reachable only with a draft in hand — the store compares a
        // restore against the draft pointer alone, never the active one.
        return {
          outcome: 'restored',
          draftVersionId: written.versionId,
          fromVersionId,
          replacedDraftVersionId
        };
      case 'partial':
        return { outcome: 'partial', wrote: written.wrote, errno: written.errno };
      default:
        return { outcome: 'refused', refusal: sharedRefusal('restore', kind, id, written) };
    }
  }

  async function deactivate(request: DeactivateRequest): Promise<DeactivateOutcome> {
    const { kind, id, expectedDraftVersion } = request;

    const located = await locate(kind, id);
    if (located.outcome === 'refused') {
      return { outcome: 'refused', refusal: located.refusal };
    }

    const { definition, snapshot } = located;
    if (definition === null) {
      return { outcome: 'refused', refusal: refuse('no-definition', absentRecord(kind, id)) };
    }

    const current = recordOfDefinition(definition);

    // Refused rather than treated as done, which is also what guards a concurrent
    // double-deactivation: the second one arrives to find nothing active and says so
    // (FR-024). Checked before the token for the same reason publish checks its draft
    // first — a definition with nothing live has nothing to take out of service
    // whatever token was sent.
    if (definition.activeVersionId === null) {
      return { outcome: 'refused', refusal: refuse('not-active', current) };
    }

    if (tokenMismatch(definition, expectedDraftVersion)) {
      return { outcome: 'refused', refusal: refuse('stale-draft', current) };
    }

    // The referential gate. Only an **active** reference blocks (FR-025a): a Draft
    // cannot be triggered, so a reference it holds is an advisory and the publish
    // gate catches it at the moment that matters. Direct references per kind and
    // never transitive (FR-025b), and **every** blocker is named rather than the
    // first — an operator who has to rediscover the next one on each attempt is
    // being made to do the search this refusal exists to do (FR-025, SC-005).
    const blockers = semantics.referencesTo(snapshot, kind, id);
    if (blockers.length > 0) {
      return { outcome: 'refused', refusal: refuse('referenced', current, { blockers }) };
    }

    // Gathered before the write, from the snapshot the gate ran against, so the
    // advisories describe the catalog the decision was made in. Neither kind can
    // become a blocker, and reporting one writes no operator-owned configuration
    // (FR-025a, FR-059, FR-061).
    const advisories = semantics.advisoriesFor(snapshot, kind, id);

    const written = await store.applyLifecycleWrite({
      op: 'deactivate',
      kind,
      id,
      expectedDraftVersion
    });

    if (written.outcome !== 'written') {
      if (written.outcome === 'unchanged' || written.outcome === 'partial') {
        // Neither is reachable: a deactivation writes no record, so there is no
        // short-circuit to hit and no second file to stop between. Mapped rather
        // than ignored so the switch over the store's union stays total.
        return {
          outcome: 'refused',
          refusal: refuse('store-refused', current, {
            storeReason: written.outcome === 'partial' ? written.errno : 'unchanged'
          })
        };
      }
      return { outcome: 'refused', refusal: sharedRefusal('deactivate', kind, id, written) };
    }

    // Deactivation always lands in Draft (FR-024a). Where there was no pending draft
    // the draft pointer takes the version that was active — no record written, no
    // body copied — so the entry keeps naming a pointer and its retained version list
    // survives the operation intact. An entry naming neither pointer is not
    // representable, and `discardDraft` is the one operation that removes an entry.
    const draftVersionId = written.draftVersionId;
    if (draftVersionId === null) {
      return {
        outcome: 'refused',
        refusal: refuse('store-refused', recordOf(kind, id, null, written.activeVersionId), {
          storeReason: 'no-draft-after-deactivate'
        })
      };
    }
    return { outcome: 'deactivated', state: 'draft', draftVersionId, advisories };
  }

  async function discardDraft(request: DiscardDraftRequest): Promise<DiscardDraftOutcome> {
    const { kind, id, expectedDraftVersion } = request;

    const located = await locate(kind, id);
    if (located.outcome === 'refused') {
      return { outcome: 'refused', refusal: located.refusal };
    }

    const { definition } = located;
    if (definition === null) {
      return { outcome: 'refused', refusal: refuse('no-definition', absentRecord(kind, id)) };
    }

    const current = recordOfDefinition(definition);
    if (definition.draftVersionId === null) {
      return { outcome: 'refused', refusal: refuse('no-draft', current) };
    }

    if (tokenMismatch(definition, expectedDraftVersion)) {
      return { outcome: 'refused', refusal: refuse('stale-draft', current) };
    }

    const written = await store.applyLifecycleWrite({
      op: 'discard-draft',
      kind,
      id,
      expectedDraftVersion
    });

    if (written.outcome === 'written') {
      // The draft pointer is cleared and the active pointer is untouched (FR-033).
      // Where there was no active version the entry goes with it: the definition
      // never became part of the catalog and an entry naming neither pointer is not
      // a state (FR-034). Its version records stay on disk and the next scan reports
      // them as collectable — this is the only operation that removes an entry, and
      // it still deletes no file.
      return { outcome: 'discarded', entryRemoved: written.entryRemoved };
    }
    if (written.outcome === 'unchanged' || written.outcome === 'partial') {
      return {
        outcome: 'refused',
        refusal: refuse('store-refused', current, {
          storeReason: written.outcome === 'partial' ? written.errno : 'unchanged'
        })
      };
    }
    return { outcome: 'refused', refusal: sharedRefusal('discard-draft', kind, id, written) };
  }

  return { saveDraft, publish, restore, deactivate, discardDraft };
}
