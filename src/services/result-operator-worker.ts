// FR-R5-F24 (D2, SPEC-02) — Bounded result parser, selector extractor, field
// validator, and 3-valued completion evaluator executed inside a terminable
// worker thread.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type {
  AttemptOutcomeReason,
  AttemptOutcomeRecovery,
  AttemptOutcomeStatus,
  DecisionField,
  Primitive,
  ResultContract,
  ThreeValuedResult,
  TypedCondition,
  TypedLeaf
} from '../contracts/decision-results';

export interface WorkerEvaluationInput {
  readonly contract: ResultContract;
  readonly rawText: string;
  readonly currentAttemptId: string;
  /** Test hook to simulate a slow/stalled worker exceeding RESULT_OPERATOR_DEADLINE_MS. */
  readonly simulateHangMs?: number;
}

export interface WorkerEvaluationOutput {
  readonly status: AttemptOutcomeStatus;
  readonly reason: AttemptOutcomeReason;
  readonly recovery: AttemptOutcomeRecovery;
  readonly values: Readonly<Record<string, Primitive>>;
  readonly diagnostics: readonly string[];
}

/**
 * Self-contained worker evaluation function. Holds no external module references
 * so `executeResultContractInWorker` can run `workerEvaluateMain.toString()` inside
 * a `node:worker_threads` `Worker` (`eval: true`) in both TypeScript/Vitest and
 * compiled JavaScript environments without file-loader friction.
 */
export function workerEvaluateMain(input: WorkerEvaluationInput): WorkerEvaluationOutput {
  const MAX_SOURCE_BYTES = 262_144;
  const MAX_DIAG_BYTES = 65_536;
  const MAX_DEPTH = 16;
  const MAX_NODES = 8_192;
  const MAX_FIELDS = 32;
  const MAX_STRING_BYTES = 1_024;
  const MAX_SEGMENTS = 5;
  const MAX_SEGMENT_BYTES = 64;
  const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
  const encoder = new TextEncoder();

  const byteLen = (str: string): number => encoder.encode(str).byteLength;

  if (typeof input.simulateHangMs === 'number' && input.simulateHangMs > 0) {
    const end = Date.now() + input.simulateHangMs;
    while (Date.now() < end) {
      // Intentional busy-wait for worker deadline termination test
    }
  }

  const invalid = (reason: AttemptOutcomeReason, diagnostic: string): WorkerEvaluationOutput => ({
    status: 'invalid-result',
    reason,
    recovery: 'block-intervention',
    values: {},
    diagnostics: [diagnostic]
  });

  // Bounded recursive-descent JSON parser rejecting duplicate keys, depth > 16, nodes > 8192.
  const parseBounded = (
    text: string
  ): { ok: true; value: unknown } | { ok: false; error: string } => {
    let pos = 0;
    let nodes = 0;
    const len = text.length;

    const skipWs = (): void => {
      while (pos < len) {
        const ch = text.charCodeAt(pos);
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) pos += 1;
        else break;
      }
    };

    const parseString = (): string => {
      if (text.charCodeAt(pos) !== 0x22) throw new Error('Expected string');
      const start = pos;
      pos += 1;
      while (pos < len) {
        const ch = text.charCodeAt(pos);
        if (ch === 0x22) {
          pos += 1;
          return JSON.parse(text.slice(start, pos)) as string;
        }
        if (ch === 0x5c) {
          pos += 2;
        } else if (ch < 0x20) {
          throw new Error('Unescaped control character in string');
        } else {
          pos += 1;
        }
      }
      throw new Error('Unterminated string');
    };

    const parseValue = (depth: number): unknown => {
      if (depth > MAX_DEPTH) throw new Error('JSON depth exceeds MAX_JSON_DEPTH');
      skipWs();
      if (pos >= len) throw new Error('Unexpected end of JSON');
      nodes += 1;
      if (nodes > MAX_NODES) throw new Error('JSON value nodes exceed MAX_JSON_VALUE_NODES');

      const ch = text.charCodeAt(pos);
      if (ch === 0x7b) {
        pos += 1;
        skipWs();
        const obj = Object.create(null) as Record<string, unknown>;
        if (pos < len && text.charCodeAt(pos) === 0x7d) {
          pos += 1;
          return obj;
        }
        while (pos < len) {
          skipWs();
          const key = parseString();
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            throw new Error(`Duplicate JSON key '${key}'`);
          }
          skipWs();
          if (pos >= len || text.charCodeAt(pos) !== 0x3a) throw new Error('Expected colon');
          pos += 1;
          obj[key] = parseValue(depth + 1);
          skipWs();
          if (pos < len && text.charCodeAt(pos) === 0x2c) {
            pos += 1;
            skipWs();
            if (pos < len && text.charCodeAt(pos) === 0x7d) {
              throw new Error('Trailing comma in object');
            }
            continue;
          }
          if (pos < len && text.charCodeAt(pos) === 0x7d) {
            pos += 1;
            return obj;
          }
          throw new Error('Expected comma or closing brace');
        }
        throw new Error('Unterminated object');
      }

      if (ch === 0x5b) {
        pos += 1;
        skipWs();
        const arr: unknown[] = [];
        if (pos < len && text.charCodeAt(pos) === 0x5d) {
          pos += 1;
          return arr;
        }
        while (pos < len) {
          arr.push(parseValue(depth + 1));
          skipWs();
          if (pos < len && text.charCodeAt(pos) === 0x2c) {
            pos += 1;
            skipWs();
            if (pos < len && text.charCodeAt(pos) === 0x5d) {
              throw new Error('Trailing comma in array');
            }
            continue;
          }
          if (pos < len && text.charCodeAt(pos) === 0x5d) {
            pos += 1;
            return arr;
          }
          throw new Error('Expected comma or closing bracket');
        }
        throw new Error('Unterminated array');
      }

      if (ch === 0x22) return parseString();
      if (text.startsWith('true', pos)) {
        pos += 4;
        return true;
      }
      if (text.startsWith('false', pos)) {
        pos += 5;
        return false;
      }
      if (text.startsWith('null', pos)) {
        pos += 4;
        return null;
      }

      const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
      if (!numMatch) throw new Error('Invalid JSON token');
      const rawNum = numMatch[0];
      pos += rawNum.length;
      const num = Number(rawNum);
      if (!Number.isFinite(num)) throw new Error('Non-finite JSON number');
      return num;
    };

    try {
      const value = parseValue(1);
      skipWs();
      if (pos !== len) return { ok: false, error: 'Trailing tokens after JSON root' };
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  };

  const isRecord = (val: unknown): val is Record<string, unknown> =>
    typeof val === 'object' && val !== null && !Array.isArray(val);

  const rawBytes = byteLen(input.rawText);
  if (rawBytes > MAX_SOURCE_BYTES) {
    return invalid('evidence-too-large', `Result source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  if (input.rawText.trim().length === 0) {
    return invalid('missing-evidence', 'Result source is empty');
  }

  let rootValues: Record<string, unknown> | null = null;
  const { contract } = input;
  const rawContract = contract as { readonly version?: unknown; readonly operatorVersion?: unknown };
  if (rawContract.version !== 1 || rawContract.operatorVersion !== 1) {
    return invalid('malformed-evidence', 'Unsupported contract or operator version');
  }

  if (contract.operator === 'structured-result') {
    const parsed = parseBounded(input.rawText);
    if (!parsed.ok || !isRecord(parsed.value)) {
      return invalid(
        'malformed-evidence',
        parsed.ok ? 'Structured result root must be an object' : parsed.error
      );
    }
    const envelope = parsed.value;
    if (typeof envelope.attemptId !== 'string' || envelope.attemptId.trim().length === 0) {
      return invalid('unattributed-evidence', 'Structured result attemptId must be a non-empty string');
    }
    if (envelope.attemptId !== input.currentAttemptId) {
      return invalid(
        'unattributed-evidence',
        `Result attemptId '${envelope.attemptId}' does not match current attempt '${input.currentAttemptId}'`
      );
    }
    if (Object.prototype.hasOwnProperty.call(envelope, 'version') || Object.prototype.hasOwnProperty.call(envelope, 'values')) {
      for (const key of Object.keys(envelope)) {
        if (key !== 'version' && key !== 'attemptId' && key !== 'values') {
          return invalid('malformed-evidence', `Unknown structured result envelope key '${key}'`);
        }
      }
      if (envelope.version !== 1) {
        return invalid('malformed-evidence', 'Structured result version must be 1');
      }
      if (!isRecord(envelope.values)) {
        return invalid('malformed-evidence', 'Structured result values must be an object');
      }
      rootValues = envelope.values;
    } else {
      rootValues = envelope;
    }
  } else {
    if (contract.source.kind !== 'diagnostic-records') {
      return invalid('malformed-evidence', 'diagnostic-result operator requires diagnostic-records source');
    }
    const expectedRecordType = contract.source.recordType;
    const lines = input.rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return invalid('missing-evidence', 'No diagnostic records found');
    }
    const matchedValues: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (byteLen(line) > MAX_DIAG_BYTES) {
        return invalid('evidence-too-large', `Diagnostic record exceeds ${MAX_DIAG_BYTES} bytes`);
      }
      if (!line.startsWith('{') || !line.endsWith('}')) {
        // Ignore non-JSON quoted tool output or plain transcript lines unless malformed JSON record
        continue;
      }
      const parsed = parseBounded(line);
      if (!parsed.ok || !isRecord(parsed.value)) {
        return invalid(
          'malformed-evidence',
          parsed.ok ? 'Diagnostic record must be an object' : parsed.error
        );
      }
      const record = parsed.value;
      // Ignore quoted tool results or untagged records that are not canonical adapter diagnostic records
      if (
        record.provenance !== undefined &&
        record.provenance !== 'canonical-adapter' &&
        record.source !== 'canonical-adapter'
      ) {
        continue;
      }
      if (record.recordType !== expectedRecordType) {
        continue;
      }
      if (record.version !== undefined && record.version !== 1) {
        return invalid('malformed-evidence', 'Diagnostic record version must be 1');
      }
      if (typeof record.attemptId !== 'string' || record.attemptId.trim().length === 0) {
        return invalid('unattributed-evidence', 'Diagnostic record missing attemptId');
      }
      if (record.attemptId !== input.currentAttemptId) {
        return invalid('unattributed-evidence', 'Diagnostic record attemptId mismatch');
      }
      if (Object.prototype.hasOwnProperty.call(record, 'values')) {
        if (!isRecord(record.values)) {
          return invalid('malformed-evidence', 'Diagnostic record values must be an object');
        }
        matchedValues.push(record.values);
      } else {
        matchedValues.push(record);
      }
    }
    if (matchedValues.length === 0) {
      return invalid('missing-evidence', `No qualified diagnostic record of type '${expectedRecordType}'`);
    }
    if (matchedValues.length > 1) {
      const firstJson = JSON.stringify(matchedValues[0]);
      for (let i = 1; i < matchedValues.length; i += 1) {
        if (JSON.stringify(matchedValues[i]) !== firstJson) {
          return invalid('conflicting-evidence', 'Multiple diagnostic records contain conflicting values');
        }
      }
    }
    rootValues = matchedValues[0]!;
  }

  if (contract.fields.length === 0 || contract.fields.length > MAX_FIELDS) {
    return invalid('malformed-evidence', `Contract fields count must be 1..${MAX_FIELDS}`);
  }

  const extracted: Record<string, Primitive> = {};
  for (const field of contract.fields) {
    if (field.selector.length === 0 || field.selector.length > MAX_SEGMENTS) {
      return invalid('malformed-evidence', `Invalid selector length for '${field.fieldId}'`);
    }
    let cursor: unknown = rootValues;
    let found = true;
    for (const segment of field.selector) {
      if (segment.length === 0 || byteLen(segment) > MAX_SEGMENT_BYTES || FORBIDDEN.has(segment)) {
        return invalid('malformed-evidence', `Invalid or forbidden selector segment '${segment}'`);
      }
      if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
        found = false;
        cursor = undefined;
        break;
      }
      cursor = cursor[segment];
    }

    if (!found || cursor === undefined) {
      if (field.required) {
        return invalid('missing-evidence', `Required field '${field.fieldId}' is missing`);
      }
      continue;
    }

    const validateFieldVal = (val: unknown, def: DecisionField): val is Primitive => {
      switch (def.type) {
        case 'boolean':
          return typeof val === 'boolean';
        case 'number':
          return typeof val === 'number' && Number.isFinite(val);
        case 'string':
          return typeof val === 'string' && byteLen(val) <= MAX_STRING_BYTES;
      }
    };

    if (!validateFieldVal(cursor, field)) {
      return invalid(
        'malformed-evidence',
        `Field '${field.fieldId}' failed validation for type '${field.type}'`
      );
    }
    extracted[field.fieldId] = cursor;
  }

  const evalLeaf = (leaf: TypedLeaf): ThreeValuedResult => {
    const { left, operator, right } = leaf;
    if (left.source !== 'result-field') return 'unresolved';
    const hasVal = Object.prototype.hasOwnProperty.call(extracted, left.fieldId);
    if (operator === 'exists') return hasVal;
    if (!hasVal) return 'unresolved';
    const val = extracted[left.fieldId]!;
    switch (operator) {
      case 'equals':
        return typeof val === typeof right && val === right;
      case 'notEquals':
        return typeof val === typeof right ? val !== right : false;
      case 'in':
        return Array.isArray(right) && right.some((item) => typeof item === typeof val && item === val);
      case 'greaterThan':
        return typeof val === 'number' && typeof right === 'number' && val > right;
      case 'greaterThanOrEqual':
        return typeof val === 'number' && typeof right === 'number' && val >= right;
      case 'lessThan':
        return typeof val === 'number' && typeof right === 'number' && val < right;
      case 'lessThanOrEqual':
        return typeof val === 'number' && typeof right === 'number' && val <= right;
    }
  };

  const evaluateCondition = (cond: TypedCondition): ThreeValuedResult => {
    const { test } = cond;
    if ('left' in test && 'operator' in test) {
      return evalLeaf(test);
    }
    if ('all' in test) {
      let sawUnresolved = false;
      for (const leaf of test.all) {
        const res = evalLeaf(leaf);
        if (res === false) return false;
        if (res === 'unresolved') sawUnresolved = true;
      }
      return sawUnresolved ? 'unresolved' : true;
    }
    let sawUnresolved = false;
    for (const leaf of test.any) {
      const res = evalLeaf(leaf);
      if (res === true) return true;
      if (res === 'unresolved') sawUnresolved = true;
    }
    return sawUnresolved ? 'unresolved' : false;
  };

  const compResult = evaluateCondition(contract.completion);
  if (compResult === 'unresolved') {
    return invalid('unresolved-condition', 'Completion predicate evaluated to unresolved');
  }
  if (compResult === false) {
    return {
      status: 'incomplete',
      reason: 'work-remaining',
      recovery: 'retry-current',
      values: extracted,
      diagnostics: ['Completion predicate evaluated to false']
    };
  }

  return {
    status: 'done',
    reason: 'completed',
    recovery: 'none',
    values: extracted,
    diagnostics: []
  };
}

if (
  !isMainThread &&
  parentPort !== null &&
  workerData !== null &&
  typeof workerData === 'object' &&
  'contract' in workerData &&
  'currentAttemptId' in workerData &&
  typeof (workerData as { rawText?: unknown }).rawText === 'string'
) {
  parentPort.postMessage(workerEvaluateMain(workerData as WorkerEvaluationInput));
}
