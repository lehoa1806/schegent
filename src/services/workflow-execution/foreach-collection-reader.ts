// FR-R5-F34 (D1, D2, D9, SPEC-12) — Contained ForEach collection reader,
// strict bounded JSON + D2 primitive validator, immutable collection freezer,
// and ordered result-index builder.

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  MAX_RESULT_STRING_BYTES,
  utf8ByteLength,
  type DecisionFieldValue
} from '../../contracts/decision-results';

const MAX_RESULT_FIELD_NAME_BYTES = 64;
import {
  DEFAULT_FOR_EACH_MAX_ITEMS,
  DEFAULT_FOR_EACH_ON_ITEM_ERROR,
  MAX_CONTROL_NESTING_DEPTH,
  MAX_FOR_EACH_COLLECTION_BYTES,
  MAX_FOR_EACH_ITEM_BYTES,
  MAX_FOR_EACH_ITEM_FIELDS,
  MAX_FOR_EACH_ITEM_KEY_BYTES,
  MAX_FOR_EACH_MAX_ITEMS,
  MIN_FOR_EACH_MAX_ITEMS,
  type ForEachControl,
  type ForEachItemErrorPolicy
} from '../../contracts/workflow-controls';
import type {
  ForEachItemRuntimeSlot,
  ForEachSlotError
} from '../../contracts/control-ledger';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type {
  WorkflowDefinition,
  WorkflowNode
} from '../../contracts/workflow-definitions';
import {
  appendInputEnvelope,
  attemptsForNode,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import { openWithinRoot } from '../../lib/safe-open';
import { readContainedEvidenceFile } from '../result-operator';
import { lookupRecord } from './control-ledger-store';
import {
  createChildWorkflowInvocationFrame,
  createNodeAttemptRecord
} from './connected-run-factory';

export type ForEachCollectionRefusalCode = 'invalid-collection' | 'collection-too-large';

export type ForEachCollectionRefusalReason =
  | 'missing-evidence'
  | 'malformed-evidence'
  | 'unattributed-evidence'
  | 'collection-bytes-exceeded'
  | 'item-count-exceeded'
  | 'item-bytes-exceeded'
  | 'item-too-many-fields'
  | 'invalid-item-field'
  | 'invalid-or-duplicate-item-key'
  | 'conflicting-item-input-binding'
  | 'invalid-collection-source-port'
  | 'invalid-item-input-port'
  | 'invalid-collection-envelope';

export interface FrozenForEachItemSlot {
  readonly index: number;
  readonly itemKey: string;
  readonly itemObject: Readonly<Record<string, DecisionFieldValue>>;
  readonly canonicalJson: string;
  readonly byteLength: number;
}

export interface FrozenForEachCollection {
  readonly version: 1;
  readonly collectionRef: string;
  readonly collectionSha256: string;
  readonly sourceBytes: number;
  readonly itemCount: number;
  readonly items: readonly FrozenForEachItemSlot[];
  readonly artifactRelativePath?: string;
}

export type ReadForEachCollectionResult =
  | {
      readonly ok: true;
      readonly collection: FrozenForEachCollection;
    }
  | {
      readonly ok: false;
      readonly code: ForEachCollectionRefusalCode;
      readonly reason: ForEachCollectionRefusalReason;
      readonly message: string;
    };

export interface ReadForEachCollectionInput {
  readonly control: ForEachControl;
  readonly workspaceRoot?: string | undefined;
  readonly relativeFilePath?: string | undefined;
  readonly rawCollectionText?: string | undefined;
  readonly rawCollectionBytes?: Uint8Array | undefined;
  readonly enclosingWorkflow?: WorkflowDefinition | undefined;
  readonly childWorkflow?: WorkflowDefinition | undefined;
  readonly nodeId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly persistCollectionArtifact?: boolean | undefined;
  readonly onDuringReadHook?: (() => Promise<void> | void) | undefined;
}

export interface OrderedForEachResultSlot {
  readonly index: number;
  readonly itemKey: string;
  readonly state: 'pending' | 'executing' | 'completed' | 'failed';
  readonly invocationId?: string;
  readonly resultRef?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly error?: ForEachSlotError;
}

export interface OrderedForEachResultIndex {
  readonly version: 1;
  readonly collectionRef: string;
  readonly collectionSha256: string;
  readonly itemCount: number;
  readonly hasErrors: boolean;
  readonly errorCount: number;
  readonly slots: readonly OrderedForEachResultSlot[];
}

export type BuildOrderedResultIndexResult =
  | {
      readonly ok: true;
      readonly resultIndex: OrderedForEachResultIndex;
      readonly resultIndexJson: string;
      readonly resultIndexRef: string;
      readonly byteLength: number;
      readonly artifactRelativePath?: string;
    }
  | {
      readonly ok: false;
      readonly code: 'aggregate-result-too-large';
      readonly byteLength: number;
      readonly message: string;
    };

export interface ResolvedFrozenForEachControl {
  readonly version: 1;
  readonly kind: 'for-each';
  readonly collection: ForEachControl['collection'];
  readonly itemKeyField?: string;
  readonly itemInputPortId: string;
  readonly maxItems: number;
  readonly onItemError: ForEachItemErrorPolicy;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function hasDuplicateOrForbiddenJsonKeys(rawJson: string): boolean {
  let pos = 0;
  const len = rawJson.length;
  const skipWs = (): void => {
    while (pos < len && [0x20, 0x09, 0x0a, 0x0d].includes(rawJson.charCodeAt(pos))) pos += 1;
  };
  const readStr = (): string | null => {
    if (rawJson.charCodeAt(pos) !== 0x22) return null;
    const start = pos++;
    while (pos < len) {
      const ch = rawJson.charCodeAt(pos);
      if (ch === 0x5c) pos += 2;
      else if (ch === 0x22) {
        pos += 1;
        try {
          return JSON.parse(rawJson.slice(start, pos)) as string;
        } catch {
          return null;
        }
      } else pos += 1;
    }
    return null;
  };
  const scan = (): boolean => {
    skipWs();
    if (pos >= len) return false;
    const ch = rawJson.charCodeAt(pos);
    if (ch === 0x7b) {
      pos += 1;
      skipWs();
      if (pos < len && rawJson.charCodeAt(pos) === 0x7d) {
        pos += 1;
        return false;
      }
      const seen = new Set<string>();
      while (pos < len) {
        skipWs();
        const key = readStr();
        if (key === null || FORBIDDEN_KEYS.has(key) || seen.has(key)) return true;
        seen.add(key);
        skipWs();
        if (pos >= len || rawJson.charCodeAt(pos++) !== 0x3a || scan()) return true;
        skipWs();
        if (pos < len && rawJson.charCodeAt(pos) === 0x2c) pos += 1;
        else if (pos < len && rawJson.charCodeAt(pos) === 0x7d) {
          pos += 1;
          return false;
        } else return true;
      }
      return true;
    }
    if (ch === 0x5b) {
      pos += 1;
      skipWs();
      if (pos < len && rawJson.charCodeAt(pos) === 0x5d) {
        pos += 1;
        return false;
      }
      while (pos < len) {
        if (scan()) return true;
        skipWs();
        if (pos < len && rawJson.charCodeAt(pos) === 0x2c) pos += 1;
        else if (pos < len && rawJson.charCodeAt(pos) === 0x5d) {
          pos += 1;
          return false;
        } else return true;
      }
      return true;
    }
    if (ch === 0x22) return readStr() === null;
    while (pos < len && ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x7d, 0x5d].includes(rawJson.charCodeAt(pos))) pos += 1;
    return false;
  };
  return scan();
}

function refuse(
  code: ForEachCollectionRefusalCode,
  reason: ForEachCollectionRefusalReason,
  message: string
): ReadForEachCollectionResult {
  return { ok: false, code, reason, message };
}

function validateBindingAndPortContracts(
  input: ReadForEachCollectionInput
): ReadForEachCollectionResult | null {
  const { control, enclosingWorkflow, childWorkflow, nodeId } = input;
  if (
    control.maxItems !== undefined &&
    (!Number.isInteger(control.maxItems) ||
      control.maxItems < MIN_FOR_EACH_MAX_ITEMS ||
      control.maxItems > MAX_FOR_EACH_MAX_ITEMS)
  ) {
    return refuse(
      'invalid-collection',
      'invalid-collection-envelope',
      `ForEach maxItems must be an integer in ${MIN_FOR_EACH_MAX_ITEMS}..${MAX_FOR_EACH_MAX_ITEMS}.`
    );
  }
  if (enclosingWorkflow !== undefined && nodeId !== undefined) {
    const conflictingBinding = (enclosingWorkflow.bindings ?? []).some(
      (b) => b.kind === 'input' && b.nodeId === nodeId && b.inputKey === control.itemInputPortId
    );
    if (conflictingBinding) {
      return refuse(
        'invalid-collection',
        'conflicting-item-input-binding',
        `ForEach itemInputPortId '${control.itemInputPortId}' conflicts with a normal input binding on node '${nodeId}'.`
      );
    }
    if (control.collection.source === 'workflow-input') {
      const portId = control.collection.portId;
      const wfPort = (enclosingWorkflow.inputs ?? []).find((p) => p.portId === portId);
      if (wfPort !== undefined && (wfPort.type !== 'local-file' || wfPort.required === false)) {
        return refuse(
          'invalid-collection',
          'invalid-collection-source-port',
          `ForEach workflow-input collection port '${portId}' must be a required 'local-file' port.`
        );
      }
    }
  }
  if (childWorkflow !== undefined) {
    const itemPort = (childWorkflow.inputs ?? []).find(
      (p) => p.portId === control.itemInputPortId
    );
    if (itemPort === undefined || itemPort.type !== 'text' || itemPort.required === false) {
      return refuse(
        'invalid-collection',
        'invalid-item-input-port',
        `ForEach itemInputPortId '${control.itemInputPortId}' must target a required 'text' input port on child workflow '${childWorkflow.workflowId}'.`
      );
    }
  }
  return null;
}

async function writeProtectedJsonArtifact(
  workspaceRoot: string,
  subdir: string,
  leafId: string,
  rawText: string
): Promise<string | undefined> {
  try {
    const canonicalRoot = await fsp.realpath(path.resolve(workspaceRoot));
    const segments = ['.schegent', subdir, `${leafId}.json`];
    const opened = await openWithinRoot(canonicalRoot, segments, {
      flags: 'w',
      createDirs: true,
      dirMode: 0o700,
      fileMode: 0o600
    });
    if (opened.outcome === 'refused') return undefined;
    try {
      await opened.handle.writeFile(rawText, 'utf8');
      return segments.join('/');
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

export async function readAndValidateForEachCollection(
  input: ReadForEachCollectionInput
): Promise<ReadForEachCollectionResult> {
  const precheckError = validateBindingAndPortContracts(input);
  if (precheckError !== null) return precheckError;

  let rawText: string;
  let sourceBytes: number;
  if (input.relativeFilePath !== undefined) {
    if (input.workspaceRoot === undefined || input.workspaceRoot.trim().length === 0) {
      return refuse(
        'invalid-collection',
        'missing-evidence',
        'Workspace root is required to read a contained local-file collection.'
      );
    }
    const readRes = await readContainedEvidenceFile(
      input.workspaceRoot,
      input.relativeFilePath,
      MAX_FOR_EACH_COLLECTION_BYTES,
      {
        ...(input.invocationId !== undefined ? { attemptId: input.invocationId } : {}),
        ...(input.onDuringReadHook !== undefined ? { onDuringReadHook: input.onDuringReadHook } : {})
      }
    );
    if (!readRes.ok) {
      return readRes.reason === 'evidence-too-large'
        ? refuse('collection-too-large', 'collection-bytes-exceeded', readRes.diagnostic)
        : refuse('invalid-collection', readRes.reason, readRes.diagnostic);
    }
    rawText = readRes.rawText;
    sourceBytes = readRes.sourceBytes;
  } else if (input.rawCollectionBytes !== undefined) {
    sourceBytes = input.rawCollectionBytes.byteLength;
    if (sourceBytes > MAX_FOR_EACH_COLLECTION_BYTES) {
      return refuse(
        'collection-too-large',
        'collection-bytes-exceeded',
        `Collection size (${sourceBytes} bytes) exceeds ${MAX_FOR_EACH_COLLECTION_BYTES}-byte limit.`
      );
    }
    try {
      rawText = new TextDecoder('utf-8', { fatal: true }).decode(input.rawCollectionBytes);
    } catch {
      return refuse('invalid-collection', 'malformed-evidence', 'Collection contains invalid UTF-8 byte sequences.');
    }
  } else if (input.rawCollectionText !== undefined) {
    rawText = input.rawCollectionText;
    sourceBytes = utf8ByteLength(rawText);
    if (sourceBytes > MAX_FOR_EACH_COLLECTION_BYTES) {
      return refuse(
        'collection-too-large',
        'collection-bytes-exceeded',
        `Collection size (${sourceBytes} bytes) exceeds ${MAX_FOR_EACH_COLLECTION_BYTES}-byte limit.`
      );
    }
  } else {
    return refuse('invalid-collection', 'missing-evidence', 'No collection file path or structured-data payload was supplied.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return refuse('invalid-collection', 'malformed-evidence', 'Collection payload is not valid JSON.');
  }
  if (hasDuplicateOrForbiddenJsonKeys(rawText)) {
    return refuse('invalid-collection', 'invalid-collection-envelope', 'Collection JSON contains duplicate or forbidden prototype keys.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('invalid-collection', 'invalid-collection-envelope', 'Collection JSON root must be an object { version: 1, items: [...] }.');
  }

  const rootObj = parsed as Record<string, unknown>;
  if (Object.keys(rootObj).length !== 2 || rootObj.version !== 1 || !Array.isArray(rootObj.items)) {
    return refuse('invalid-collection', 'invalid-collection-envelope', 'Collection JSON must have exact closed shape { version: 1, items: [...] }.');
  }

  const rawItems = rootObj.items as readonly unknown[];
  const effectiveMaxItems = input.control.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS;
  if (rawItems.length > effectiveMaxItems || rawItems.length > MAX_FOR_EACH_MAX_ITEMS) {
    return refuse(
      'collection-too-large',
      'item-count-exceeded',
      `Collection item count (${rawItems.length}) exceeds cap (${effectiveMaxItems}).`
    );
  }

  const itemKeyField = input.control.itemKeyField;
  if (
    itemKeyField !== undefined &&
    (itemKeyField.trim().length === 0 ||
      utf8ByteLength(itemKeyField) > MAX_RESULT_FIELD_NAME_BYTES ||
      FORBIDDEN_KEYS.has(itemKeyField))
  ) {
    return refuse('invalid-collection', 'invalid-or-duplicate-item-key', 'Authored itemKeyField is invalid.');
  }

  const seenItemKeys = new Set<string>();
  const frozenItems: FrozenForEachItemSlot[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const rawItem = rawItems.at(index);
    if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return {
        ok: false,
        code: 'invalid-collection',
        reason: 'invalid-item-field',
        message: `Collection item at index ${index} must be a JSON object.`
      };
    }
    const entries = Object.entries(rawItem as Record<string, unknown>);
    if (entries.length > MAX_FOR_EACH_ITEM_FIELDS) {
      return {
        ok: false,
        code: 'invalid-collection',
        reason: 'item-too-many-fields',
        message: `Collection item at index ${index} has ${entries.length} fields (max ${MAX_FOR_EACH_ITEM_FIELDS}).`
      };
    }
    const validatedFields: Record<string, DecisionFieldValue> = {};
    for (const [fieldKey, fieldVal] of entries) {
      if (
        fieldKey.length === 0 ||
        utf8ByteLength(fieldKey) > MAX_RESULT_FIELD_NAME_BYTES ||
        FORBIDDEN_KEYS.has(fieldKey)
      ) {
        return {
          ok: false,
          code: 'invalid-collection',
          reason: 'invalid-item-field',
          message: `Collection item at index ${index} has an invalid field name '${fieldKey}'.`
        };
      }
      if (typeof fieldVal === 'string') {
        if (utf8ByteLength(fieldVal) > MAX_RESULT_STRING_BYTES) {
          return {
            ok: false,
            code: 'invalid-collection',
            reason: 'invalid-item-field',
            message: `Collection item at index ${index} field '${fieldKey}' exceeds ${MAX_RESULT_STRING_BYTES}-byte string cap.`
          };
        }
        validatedFields[fieldKey] = fieldVal;
      } else if (typeof fieldVal === 'number') {
        if (!Number.isFinite(fieldVal)) {
          return {
            ok: false,
            code: 'invalid-collection',
            reason: 'invalid-item-field',
            message: `Collection item at index ${index} field '${fieldKey}' must be a finite number.`
          };
        }
        validatedFields[fieldKey] = fieldVal;
      } else if (typeof fieldVal === 'boolean') {
        validatedFields[fieldKey] = fieldVal;
      } else {
        return {
          ok: false,
          code: 'invalid-collection',
          reason: 'invalid-item-field',
          message: `Collection item at index ${index} field '${fieldKey}' must be a D2 primitive.`
        };
      }
    }

    const canonicalJson = JSON.stringify(validatedFields);
    const itemBytes = utf8ByteLength(canonicalJson);
    if (itemBytes > MAX_FOR_EACH_ITEM_BYTES) {
      return {
        ok: false,
        code: 'collection-too-large',
        reason: 'item-bytes-exceeded',
        message: `Collection item at index ${index} (${itemBytes} bytes) exceeds ${MAX_FOR_EACH_ITEM_BYTES}-byte item limit.`
      };
    }

    let itemKey: string;
    if (itemKeyField !== undefined) {
      const rawKey = lookupRecord(validatedFields, itemKeyField);
      if (
        typeof rawKey !== 'string' ||
        rawKey.trim().length === 0 ||
        utf8ByteLength(rawKey) > MAX_FOR_EACH_ITEM_KEY_BYTES
      ) {
        return {
          ok: false,
          code: 'invalid-collection',
          reason: 'invalid-or-duplicate-item-key',
          message: `Collection item at index ${index} is missing a valid nonempty string key '${itemKeyField}'.`
        };
      }
      if (seenItemKeys.has(rawKey)) {
        return {
          ok: false,
          code: 'invalid-collection',
          reason: 'invalid-or-duplicate-item-key',
          message: `Duplicate itemKey '${rawKey}' at index ${index}.`
        };
      }
      seenItemKeys.add(rawKey);
      itemKey = rawKey;
    } else {
      itemKey = String(index);
    }

    frozenItems.push(
      Object.freeze({
        index,
        itemKey,
        itemObject: Object.freeze(validatedFields),
        canonicalJson,
        byteLength: itemBytes
      })
    );
  }

  const collectionSha256 = createHash('sha256').update(rawText, 'utf8').digest('hex');
  const collectionRef = `fe-col-${collectionSha256.slice(0, 32)}`;
  let artifactRelativePath: string | undefined;
  if (input.workspaceRoot !== undefined && input.persistCollectionArtifact !== false) {
    artifactRelativePath = await writeProtectedJsonArtifact(
      input.workspaceRoot,
      'foreach-collections',
      collectionRef,
      rawText
    );
  }

  return {
    ok: true,
    collection: Object.freeze({
      version: 1,
      collectionRef,
      collectionSha256,
      sourceBytes,
      itemCount: frozenItems.length,
      items: Object.freeze(frozenItems),
      ...(artifactRelativePath !== undefined ? { artifactRelativePath } : {})
    })
  };
}

function countControlDepthForForEachNode(
  run: ConnectedWorkflowRun,
  parentFrame: WorkflowInvocationFrame
): number {
  let depth = 1;
  const invocations = run.invocations ?? {};
  let cursor: WorkflowInvocationFrame | undefined = parentFrame;
  const visited = new Set<string>();
  while (cursor !== undefined && !visited.has(cursor.invocationId)) {
    visited.add(cursor.invocationId);
    const wf =
      run.frozenClosure !== undefined
        ? lookupRecord(run.frozenClosure.workflowsById, cursor.workflowId)
        : undefined;
    if (wf?.control?.kind === 'candidate-block') depth += 1;
    if (cursor.parentInvocationId !== null) {
      const parentCallNodeId = cursor.parentCallNodeId;
      const parent: WorkflowInvocationFrame | undefined = lookupRecord(
        invocations,
        cursor.parentInvocationId
      );
      if (parent !== undefined && parentCallNodeId !== null) {
        const pWf =
          run.frozenClosure !== undefined
            ? lookupRecord(run.frozenClosure.workflowsById, parent.workflowId)
            : undefined;
        const callNode = pWf?.nodes.find((n) => n.nodeId === parentCallNodeId);
        if (callNode?.control?.kind === 'repeat' || callNode?.control?.kind === 'for-each') {
          depth += 1;
        }
      }
      cursor = parent;
    } else {
      cursor = undefined;
    }
  }
  return depth;
}

export function resolveFrozenForEachControl(
  run: ConnectedWorkflowRun,
  parentWorkflow: WorkflowDefinition,
  node: WorkflowNode,
  parentFrame?: WorkflowInvocationFrame
):
  | {
      readonly ok: true;
      readonly control: ResolvedFrozenForEachControl;
      readonly childWorkflow: WorkflowDefinition;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    } {
  const frozenWf =
    (run.frozenClosure !== undefined
      ? lookupRecord(run.frozenClosure.workflowsById, parentWorkflow.workflowId)
      : undefined) ?? parentWorkflow;
  const frozenNode = frozenWf.nodes.find((n) => n.nodeId === node.nodeId) ?? node;
  const ctrl = frozenNode.control;
  if (ctrl?.kind !== 'for-each') {
    return {
      ok: false,
      code: 'invalid-for-each-control',
      message: `Node '${node.nodeId}' does not declare a frozen ForEachControl.`
    };
  }
  const maxItems = ctrl.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS;
  if (
    !Number.isInteger(maxItems) ||
    maxItems < MIN_FOR_EACH_MAX_ITEMS ||
    maxItems > MAX_FOR_EACH_MAX_ITEMS
  ) {
    return {
      ok: false,
      code: 'invalid-collection',
      message: `ForEach maxItems (${String(maxItems)}) is outside ${MIN_FOR_EACH_MAX_ITEMS}..${MAX_FOR_EACH_MAX_ITEMS}.`
    };
  }
  const childWfId = frozenNode.workflowId ?? '';
  const childWorkflow =
    run.frozenClosure !== undefined
      ? lookupRecord(run.frozenClosure.workflowsById, childWfId)
      : undefined;
  if (childWorkflow === undefined) {
    return {
      ok: false,
      code: 'workflow-closure-invalid',
      message: `Child workflow '${childWfId}' is missing from the frozen closure.`
    };
  }
  if (parentFrame !== undefined) {
    const ancestorControlDepth = countControlDepthForForEachNode(run, parentFrame);
    const childHasNestedControl =
      childWorkflow.control?.kind === 'candidate-block' ||
      childWorkflow.nodes.some(
        (n) => n.control?.kind === 'repeat' || n.control?.kind === 'for-each'
      );
    const totalDepth = ancestorControlDepth + (childHasNestedControl ? 1 : 0);
    if (totalDepth > MAX_CONTROL_NESTING_DEPTH) {
      return {
        ok: false,
        code: 'control-nesting-depth-exceeded',
        message: `Control nesting depth (${totalDepth}) exceeds maximum (${MAX_CONTROL_NESTING_DEPTH}).`
      };
    }
  }
  const itemPort = (childWorkflow.inputs ?? []).find((p) => p.portId === ctrl.itemInputPortId);
  if (itemPort === undefined || itemPort.type !== 'text' || itemPort.required === false) {
    return {
      ok: false,
      code: 'invalid-collection',
      message: `ForEach itemInputPortId '${ctrl.itemInputPortId}' must target a required 'text' input port on '${childWorkflow.workflowId}'.`
    };
  }
  const conflictingBinding = (frozenWf.bindings ?? []).some(
    (b) => b.kind === 'input' && b.nodeId === frozenNode.nodeId && b.inputKey === ctrl.itemInputPortId
  );
  if (conflictingBinding) {
    return {
      ok: false,
      code: 'invalid-collection',
      message: `ForEach itemInputPortId '${ctrl.itemInputPortId}' conflicts with a normal input binding on node '${frozenNode.nodeId}'.`
    };
  }
  return {
    ok: true,
    control: Object.freeze({
      version: 1,
      kind: 'for-each',
      collection: ctrl.collection,
      ...(ctrl.itemKeyField !== undefined ? { itemKeyField: ctrl.itemKeyField } : {}),
      itemInputPortId: ctrl.itemInputPortId,
      maxItems,
      onItemError: ctrl.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR
    }),
    childWorkflow
  };
}

export function buildForEachItemInputEnvelope(input: {
  readonly parentInvocationId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly itemInputPortId: string;
  readonly itemCanonicalJson: string;
  readonly baseInputsByPort: Readonly<Record<string, ResolvedPortValue>>;
  readonly acceptedAt: number;
}): {
  readonly envelope: InvocationInputEnvelope;
  readonly inputsByPort: Readonly<Record<string, ResolvedPortValue>>;
} {
  const inputsByPort: Record<string, ResolvedPortValue> = {
    ...input.baseInputsByPort,
    [input.itemInputPortId]: Object.freeze({
      portId: input.itemInputPortId,
      type: 'text',
      value: input.itemCanonicalJson
    })
  };
  const frozenInputs = Object.freeze(inputsByPort);
  const envelope: InvocationInputEnvelope = Object.freeze({
    envelopeId: `${input.parentInvocationId}:${input.nodeId}:item-${input.itemIndex}:env`,
    invocationId: input.parentInvocationId,
    targetNodeId: input.nodeId,
    source: 'binding',
    inputsByPort: frozenInputs,
    localInputs: Object.freeze([]),
    outputTargetOverrides: Object.freeze([]),
    acceptedAt: input.acceptedAt
  });
  return { envelope, inputsByPort: frozenInputs };
}

export async function buildOrderedResultIndex(input: {
  readonly collectionRef: string;
  readonly collectionSha256: string;
  readonly slots: readonly ForEachItemRuntimeSlot[];
  readonly outputsByItemIndex?: Readonly<Record<number, Readonly<Record<string, string>>>> | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly persistArtifact?: boolean | undefined;
}): Promise<BuildOrderedResultIndexResult> {
  let errorCount = 0;
  const orderedSlots: OrderedForEachResultSlot[] = input.slots.map((slot) => {
    const idx = slot.index ?? slot.itemIndex;
    const state =
      slot.state ??
      (slot.status === 'in-flight'
        ? 'executing'
        : slot.status === 'skipped'
          ? 'pending'
          : slot.status);
    if (state === 'failed') errorCount += 1;
    const invId = slot.invocationId ?? slot.childInvocationId;
    const slotOutputs =
      input.outputsByItemIndex !== undefined && Object.hasOwn(input.outputsByItemIndex, idx)
        ? input.outputsByItemIndex[idx]
        : undefined;
    return Object.freeze({
      index: idx,
      itemKey: slot.itemKey,
      state,
      ...(invId !== undefined ? { invocationId: invId } : {}),
      ...(slot.resultRef !== undefined ? { resultRef: slot.resultRef } : {}),
      ...(slotOutputs !== undefined ? { outputs: slotOutputs } : {}),
      ...(slot.error !== undefined ? { error: slot.error } : {})
    });
  });

  const resultIndex: OrderedForEachResultIndex = Object.freeze({
    version: 1,
    collectionRef: input.collectionRef,
    collectionSha256: input.collectionSha256,
    itemCount: orderedSlots.length,
    hasErrors: errorCount > 0,
    errorCount,
    slots: Object.freeze(orderedSlots)
  });

  const resultIndexJson = JSON.stringify(resultIndex);
  const byteLength = utf8ByteLength(resultIndexJson);
  if (byteLength > MAX_FOR_EACH_COLLECTION_BYTES) {
    return {
      ok: false,
      code: 'aggregate-result-too-large',
      byteLength,
      message: `Ordered ForEach result index (${byteLength} bytes) exceeds ${MAX_FOR_EACH_COLLECTION_BYTES}-byte limit.`
    };
  }
  const digest = createHash('sha256').update(resultIndexJson, 'utf8').digest('hex');
  const resultIndexRef = `fe-idx-${digest.slice(0, 32)}`;
  let artifactRelativePath: string | undefined;
  if (input.workspaceRoot !== undefined && input.persistArtifact !== false) {
    artifactRelativePath = await writeProtectedJsonArtifact(
      input.workspaceRoot,
      'foreach-results',
      resultIndexRef,
      resultIndexJson
    );
  }
  return {
    ok: true,
    resultIndex,
    resultIndexJson,
    resultIndexRef,
    byteLength,
    ...(artifactRelativePath !== undefined ? { artifactRelativePath } : {})
  };
}

export function extractCollectionPayloadFromParentFrame(input: {
  readonly parentFrame: WorkflowInvocationFrame;
  readonly control: ResolvedFrozenForEachControl;
}): {
  readonly relativeFilePath?: string;
  readonly rawCollectionText?: string;
} {
  if (input.control.collection.source === 'workflow-input') {
    const portVal = lookupRecord(input.parentFrame.boundInputs, input.control.collection.portId);
    if (portVal === undefined) return {};
    const trimmed = portVal.value.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[')
      ? { rawCollectionText: portVal.value }
      : { relativeFilePath: portVal.value };
  }
  const upstreamAttempts = attemptsForNode(input.parentFrame, input.control.collection.nodeId);
  const latestCompleted = [...upstreamAttempts].reverse().find((a) => a.status === 'completed');
  const outVal =
    latestCompleted !== undefined
      ? lookupRecord(latestCompleted.declaredOutputs, input.control.collection.portId)
      : undefined;
  if (outVal === undefined) return {};
  const trimmed = outVal.value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[')
    ? { rawCollectionText: outVal.value }
    : { relativeFilePath: outVal.value };
}

export function buildForEachDeclaredOutputs(input: {
  readonly parentWorkflow: WorkflowDefinition;
  readonly nodeId: string;
  readonly resultIndexJson: string;
}): Readonly<Record<string, ResolvedPortValue>> {
  const outputs: Record<string, ResolvedPortValue> = {
    resultIndex: Object.freeze({
      portId: 'resultIndex',
      type: 'structured-data',
      value: input.resultIndexJson
    })
  };
  for (const b of input.parentWorkflow.bindings ?? []) {
    if (b.kind === 'output' && b.nodeId === input.nodeId) {
      const sourcePort = b.sourcePortId ?? b.portId;
      outputs[sourcePort] = Object.freeze({
        portId: sourcePort,
        type: 'structured-data',
        value: input.resultIndexJson
      });
    }
  }
  return Object.freeze(outputs);
}

export function prepareForEachItemFrames(input: {
  readonly run: ConnectedWorkflowRun;
  readonly parentFrame: WorkflowInvocationFrame;
  readonly node: WorkflowNode;
  readonly childWorkflow: WorkflowDefinition;
  readonly itemIndex: number;
  readonly itemInputPortId: string;
  readonly itemCanonicalJson: string;
  readonly baseInputsByPort: Readonly<Record<string, ResolvedPortValue>>;
  readonly startedAt: number;
}): {
  readonly nextRun: ConnectedWorkflowRun;
  readonly childFrame: WorkflowInvocationFrame;
  readonly parentAttempt: NodeAttemptRecord;
  readonly childEntryNodeId: string;
  readonly itemEnvelope: InvocationInputEnvelope;
} | null {
  const childEntryNodeId =
    input.childWorkflow.control?.kind === 'candidate-block'
      ? [...input.childWorkflow.control.candidates]
          .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))
          .at(0)?.nodeId ?? input.childWorkflow.startNodeIds.at(0)
      : input.childWorkflow.startNodeIds.at(0);
  if (childEntryNodeId === undefined) return null;

  const builtEnv = buildForEachItemInputEnvelope({
    parentInvocationId: input.parentFrame.invocationId,
    nodeId: input.node.nodeId,
    itemIndex: input.itemIndex,
    itemInputPortId: input.itemInputPortId,
    itemCanonicalJson: input.itemCanonicalJson,
    baseInputsByPort: input.baseInputsByPort,
    acceptedAt: input.startedAt
  });

  const attemptNumber = input.itemIndex + 1;
  const parentAttemptId = `${input.parentFrame.invocationId}:${input.node.nodeId}:attempt-${attemptNumber}`;
  const childFrame = createChildWorkflowInvocationFrame({
    parentFrame: input.parentFrame,
    callNodeId: input.node.nodeId,
    parentAttemptId,
    childWorkflow: input.childWorkflow,
    boundInputs: builtEnv.inputsByPort,
    startedAt: input.startedAt
  });
  const parentAttempt = createNodeAttemptRecord({
    frame: input.parentFrame,
    nodeId: input.node.nodeId,
    nodeKind: 'workflow',
    targetDefinitionId: input.childWorkflow.workflowId,
    inputEnvelope: builtEnv.envelope,
    startedAt: input.startedAt,
    childInvocationId: childFrame.invocationId
  });
  const updatedParentFrame = recordNodeAttempt(input.parentFrame, parentAttempt);
  let nextRun = upsertInvocationFrame(input.run, updatedParentFrame);
  nextRun = upsertInvocationFrame(nextRun, childFrame);
  nextRun = appendInputEnvelope(nextRun, builtEnv.envelope);
  return {
    nextRun,
    childFrame,
    parentAttempt,
    childEntryNodeId,
    itemEnvelope: builtEnv.envelope
  };
}

export function pauseParentFrameOnForEach(
  run: ConnectedWorkflowRun,
  parentFrame: WorkflowInvocationFrame,
  nodeId: string,
  pausedAt: number,
  reasonCode: string
): ConnectedWorkflowRun {
  const pausedFrame: WorkflowInvocationFrame = {
    ...parentFrame,
    activeNodeId: nodeId,
    status: 'paused',
    failureCode: reasonCode,
    controlMarkers: pauseInvocationControlMarkers(
      parentFrame.controlMarkers,
      pausedAt,
      'operator-pause'
    )
  };
  return upsertInvocationFrame(run, pausedFrame);
}
