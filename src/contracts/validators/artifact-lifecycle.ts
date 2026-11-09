import {
  DELETION_SELECTION_MAX_IDS,
  INVENTORY_CURSOR_PATTERN,
  INVENTORY_PAGE_MAX_ENTRIES,
  LIFECYCLE_OPAQUE_ID_PATTERN,
  LIFECYCLE_REFUSAL_CODES,
  type DeletionExecuteRequest,
  type DeletionSelection,
  type LifecycleResult,
  type MutationAuthority,
  type MutationRequestBase,
  type RetentionPolicy,
  type StorageInventoryRequest
} from '../artifact-lifecycle/lifecycle-types';
import type {
  ArchivalQueueInput,
  ArchivalRequest,
  PolicyAdoptionRequest
} from '../artifact-lifecycle/retention-policy-types';
import type { RetentionClassId } from '../shared-memory-storage/consumer-and-retention-inventories';
import { CMD_READ_STORAGE_DETAILS, type ReadStorageDetailsResponse, type SidebarCommand } from '../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok as ipcOk, type IpcValidationResult } from './shared';

// FR-R6-F05 (FR-021, contract surfaces-and-wiring.md §4, §5) — the request validators the headless
// lifecycle API and the sidebar storage-details handler share, so the two surfaces accept exactly the
// same requests. A refusal names the field that was wrong, never the value it held.
//
// The authority flags and the confirmation are checked for SHAPE here only. Whether a `false` flag or
// a missing confirmation refuses the mutation is the service gate's decision, made in its fixed order
// (untrusted, not primary, audit unhealthy, preview, confirmation), so this layer never reorders it.

type Plain = Record<string, unknown>;

const INVENTORY_KEYS = ['cursor', 'pageSize', 'retentionClass'] as const;
const SELECTION_KEYS = ['artifactIds', 'retentionClass'] as const;
const EXECUTE_KEYS = [...SELECTION_KEYS, 'previewId', 'confirmation', 'authority'] as const;
const AUTHORITY_KEYS = ['trusted', 'primary', 'auditHealthy'] as const;
const MUTATION_KEYS = ['previewId', 'confirmation', 'authority'] as const;
const POLICY_ADOPTION_KEYS = [...MUTATION_KEYS, 'policy'] as const;
const ARCHIVAL_KEYS = [...MUTATION_KEYS, 'queues'] as const;
const ARCHIVAL_PREVIEW_KEYS = ['queues'] as const;
const STORAGE_DETAILS_KEYS = ['cursor'] as const;

function invalid<T>(field: string): LifecycleResult<T> {
  return { ok: false, refusal: { code: 'invalid-input', message: `${field} is malformed` } };
}

function accept<T>(value: T): LifecycleResult<T> {
  return { ok: true, value };
}

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An inventory cursor this service could have issued; anything else is refused before decoding. */
export function isInventoryCursor(value: unknown): value is string {
  return typeof value === 'string' && INVENTORY_CURSOR_PATTERN.test(value);
}

/**
 * The F02 retention classes, restated as a keyed record. The webview bundles this
 * validator, and the F02 inventory module imports `node:crypto` at runtime, so only
 * its type is imported here; the `Record` key type makes `tsc` refuse a missing or
 * extra class, so the two lists cannot drift.
 */
const RETENTION_CLASSES: Readonly<Record<RetentionClassId, true>> = {
  'new-terminal-execution-usage-detail': true,
  'active-and-recovery-required-metadata': true,
  'aggregate-history': true,
  'transcripts-diagnostics-checkpoints-audit-catalog': true,
  'generated-reports-handoff-exports': true,
  'provider-owned-session-stores': true
};

function isRetentionClass(value: unknown): value is RetentionClassId {
  return typeof value === 'string' && Object.hasOwn(RETENTION_CLASSES, value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && LIFECYCLE_OPAQUE_ID_PATTERN.test(value);
}

function isPageSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= INVENTORY_PAGE_MAX_ENTRIES;
}

function readSelection(value: Plain): LifecycleResult<DeletionSelection> {
  const { artifactIds, retentionClass } = value;
  if (retentionClass !== undefined && !isRetentionClass(retentionClass)) return invalid('retentionClass');
  if (artifactIds === undefined) return accept(retentionClass === undefined ? {} : { retentionClass });
  if (!Array.isArray(artifactIds) || artifactIds.length > DELETION_SELECTION_MAX_IDS) return invalid('artifactIds');
  if (!artifactIds.every(isOpaqueId)) return invalid('artifactIds');
  const ids: readonly string[] = [...artifactIds];
  return accept(retentionClass === undefined ? { artifactIds: ids } : { artifactIds: ids, retentionClass });
}

function readAuthority(value: unknown): MutationAuthority | null {
  if (!isPlain(value) || hasUnexpectedKeys(value, AUTHORITY_KEYS)) return null;
  const { trusted, primary, auditHealthy } = value;
  if (typeof trusted !== 'boolean' || typeof primary !== 'boolean' || typeof auditHealthy !== 'boolean') return null;
  return { trusted, primary, auditHealthy };
}

/** One inventory page request; an absent request is the first page at the default size. */
export function validateInventoryRequest(input: unknown): LifecycleResult<StorageInventoryRequest> {
  if (input === undefined) return accept({});
  if (!isPlain(input) || hasUnexpectedKeys(input, INVENTORY_KEYS)) return invalid('request');
  const { cursor, pageSize, retentionClass } = input;
  if (cursor !== undefined && !isInventoryCursor(cursor)) return invalid('cursor');
  if (pageSize !== undefined && !isPageSize(pageSize)) return invalid('pageSize');
  if (retentionClass !== undefined && !isRetentionClass(retentionClass)) return invalid('retentionClass');
  return accept({
    ...(cursor === undefined ? {} : { cursor }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(retentionClass === undefined ? {} : { retentionClass })
  });
}

/** A deletion selection to preview; an absent request selects every managed artifact. */
export function validateDeletionPreviewRequest(input: unknown): LifecycleResult<DeletionSelection> {
  if (input === undefined) return accept({});
  if (!isPlain(input) || hasUnexpectedKeys(input, SELECTION_KEYS)) return invalid('request');
  return readSelection(input);
}

/** A deletion to execute: the previewed selection plus the preview id, confirmation and authority. */
export function validateDeletionExecuteRequest(input: unknown): LifecycleResult<DeletionExecuteRequest> {
  if (!isPlain(input) || hasUnexpectedKeys(input, EXECUTE_KEYS)) return invalid('request');
  const { previewId, confirmation } = input;
  if (!isOpaqueId(previewId)) return invalid('previewId');
  if (confirmation !== undefined && confirmation !== 'confirmed') return invalid('confirmation');
  const authority = readAuthority(input['authority']);
  if (authority === null) return invalid('authority');
  const selection = readSelection(input);
  if (!selection.ok) return selection;
  return accept({ ...selection.value, previewId, confirmation, authority });
}

function readMutationBase(input: Plain): LifecycleResult<MutationRequestBase> {
  const { previewId, confirmation } = input;
  if (!isOpaqueId(previewId)) return invalid('previewId');
  if (confirmation !== undefined && confirmation !== 'confirmed') return invalid('confirmation');
  const authority = readAuthority(input['authority']);
  if (authority === null) return invalid('authority');
  return accept({ previewId, confirmation, authority });
}

/*
 * The policy and queue payloads are checked here for container shape only (an object, an array of
 * objects). Their field rules live once, in the service (`isRetentionPolicy`, the archival queue
 * check), which refuses a malformed payload `invalid-input` before its authority gate.
 */

/** A retention policy to preview (FR-014); its fields are checked by the service. */
export function validateRetentionPolicyPreviewRequest(input: unknown): LifecycleResult<RetentionPolicy> {
  if (!isPlain(input)) return invalid('policy');
  return accept(input as unknown as RetentionPolicy);
}

/** A previewed, confirmed policy adoption (FR-014). */
export function validatePolicyAdoptionRequest(input: unknown): LifecycleResult<PolicyAdoptionRequest> {
  if (!isPlain(input) || hasUnexpectedKeys(input, POLICY_ADOPTION_KEYS)) return invalid('request');
  const base = readMutationBase(input);
  if (!base.ok) return base;
  const policy = input['policy'];
  if (!isPlain(policy)) return invalid('policy');
  return accept({ ...base.value, policy: policy as unknown as RetentionPolicy });
}

function readQueues(value: unknown): LifecycleResult<readonly ArchivalQueueInput[]> {
  if (!Array.isArray(value) || !value.every(isPlain)) return invalid('queues');
  return accept(value as unknown as readonly ArchivalQueueInput[]);
}

/** The queues whose terminal Tasks an archival preview considers (FR-016). */
export function validateArchivalPreviewRequest(input: unknown): LifecycleResult<readonly ArchivalQueueInput[]> {
  if (!isPlain(input) || hasUnexpectedKeys(input, ARCHIVAL_PREVIEW_KEYS)) return invalid('request');
  return readQueues(input['queues']);
}

/** A previewed, confirmed archival of terminal Tasks (FR-016). */
export function validateArchivalRequest(input: unknown): LifecycleResult<ArchivalRequest> {
  if (!isPlain(input) || hasUnexpectedKeys(input, ARCHIVAL_KEYS)) return invalid('request');
  const base = readMutationBase(input);
  if (!base.ok) return base;
  const queues = readQueues(input['queues']);
  if (!queues.ok) return queues;
  return accept({ ...base.value, queues: queues.value });
}

/** The sidebar's storage-details read: an optional inventory cursor, nothing else. */
export function validateReadStorageDetails(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_READ_STORAGE_DETAILS, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  if (hasUnexpectedKeys(payload, STORAGE_DETAILS_KEYS)) return fail('unexpected-payload-fields', context);
  const { cursor } = payload;
  if (cursor !== undefined && !isInventoryCursor(cursor)) return fail('invalid-cursor', context);
  return ipcOk({ ...context, payload: cursor === undefined ? {} : { cursor } } as SidebarCommand);
}

function isByteCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPressureShape(value: unknown): boolean {
  if (!isPlain(value)) return false;
  return (
    Array.isArray(value['perClass']) &&
    isByteCount(value['totalBytes']) &&
    isByteCount(value['unclassifiedBytes']) &&
    typeof value['overTarget'] === 'boolean' &&
    typeof value['coverage'] === 'string'
  );
}

function isPageShape(value: unknown): boolean {
  if (!isPlain(value) || !Array.isArray(value['entries'])) return false;
  const next = value['nextCursor'];
  return (next === null || isInventoryCursor(next)) && typeof value['coverage'] === 'string';
}

/**
 * The webview's gate before it renders storage details: the result envelope, a known refusal code,
 * and the pressure and page shapes the panel reads. Anything else becomes the helper's failure.
 */
export function isValidReadStorageDetailsResponse(value: unknown): value is ReadStorageDetailsResponse {
  if (!isPlain(value)) return false;
  if (value['ok'] === true) {
    const details = value['value'];
    return isPlain(details) && isPressureShape(details['pressure']) && isPageShape(details['page']);
  }
  if (value['ok'] !== false || !isPlain(value['refusal'])) return false;
  const { code, message } = value['refusal'];
  return typeof code === 'string' && (LIFECYCLE_REFUSAL_CODES as readonly string[]).includes(code) && typeof message === 'string';
}
