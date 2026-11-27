// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/analytics-reporting.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_MUTATE_REPORT,
  CMD_READ_METRICS,
  CMD_READ_REPORT,
  CMD_READ_STORAGE_DETAILS,
  CMD_READ_USAGE_ACCOUNTING,
  type MutateReportCommand,
  type ReadMetricsCommand,
  type ReadReportCommand,
  type ReadStorageDetailsCommand,
  type ReadUsageAccountingCommand
} from '../../sidebar-ipc';
import { fail, isSafePathSegment, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';
import { isReadMetricsRunIdList } from '../../sidebar-ipc';

const RE_0 = new RegExp("^[A-Za-z0-9_-]{1,512}$");

export function validateReadMetrics(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_READ_METRICS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['includeArchives', 'runIds'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_METRICS, correlationId });
  }
  const validated_includeArchivesRaw: unknown = validatedObj['includeArchives'];
  let validated_includeArchives: boolean | undefined;
  if (validated_includeArchivesRaw !== undefined) {
    if (typeof validated_includeArchivesRaw !== 'boolean') {
      return fail('invalid-payload-field', { type: CMD_READ_METRICS, correlationId });
    }
    const validated_includeArchivesChecked: boolean = validated_includeArchivesRaw;
    validated_includeArchives = validated_includeArchivesChecked;
  }
  const validated_runIdsRaw: unknown = validatedObj['runIds'];
  let validated_runIds: readonly string[] | undefined;
  if (validated_runIdsRaw !== undefined) {
    if (!isReadMetricsRunIdList(validated_runIdsRaw)) {
      return fail('invalid-payload-field', { type: CMD_READ_METRICS, correlationId });
    }
    const validated_runIdsChecked = validated_runIdsRaw;
    validated_runIds = validated_runIdsChecked;
  }
  const validated = { ...(validated_includeArchives === undefined ? {} : { includeArchives: validated_includeArchives }), ...(validated_runIds === undefined ? {} : { runIds: validated_runIds }) };
  const command: ReadMetricsCommand = { type: CMD_READ_METRICS, correlationId, payload: validated };
  return ok(command);
}

export function validateReadStorageDetails(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_STORAGE_DETAILS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['cursor'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_STORAGE_DETAILS, correlationId });
  }
  const validated_cursorRaw: unknown = validatedObj['cursor'];
  let validated_cursor: string | undefined;
  if (validated_cursorRaw !== undefined) {
    if (typeof validated_cursorRaw !== 'string') {
      return fail('invalid-cursor', { type: CMD_READ_STORAGE_DETAILS, correlationId });
    }
    if (validated_cursorRaw.length < 1 || validated_cursorRaw.length > 512 || !RE_0.test(validated_cursorRaw)) {
      return fail('invalid-cursor', { type: CMD_READ_STORAGE_DETAILS, correlationId });
    }
    const validated_cursorChecked: string = validated_cursorRaw;
    validated_cursor = validated_cursorChecked;
  }
  const validated = { ...(validated_cursor === undefined ? {} : { cursor: validated_cursor }) };
  const command: ReadStorageDetailsCommand = { type: CMD_READ_STORAGE_DETAILS, correlationId, payload: validated };
  return ok(command);
}

export function validateReadUsageAccounting(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_USAGE_ACCOUNTING, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['query'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_USAGE_ACCOUNTING, correlationId });
  }
  if (!Object.hasOwn(validatedObj, 'query')) {
    return fail('missing-query', { type: CMD_READ_USAGE_ACCOUNTING, correlationId });
  }
  const validated_query: unknown = validatedObj['query'];
  const validated = { query: validated_query };
  const command: ReadUsageAccountingCommand = { type: CMD_READ_USAGE_ACCOUNTING, correlationId, payload: validated };
  return ok(command);
}

export function validateReadReport(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_REPORT, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  const disc: unknown = pObj['op'];
  if (typeof disc !== 'string') {
    return fail('missing-op', { type: CMD_READ_REPORT, correlationId });
  }
  switch (disc) {
    case 'run': {
      if (hasUnexpectedKeys(pObj, ['op', 'query'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      if (!Object.hasOwn(pObj, 'query')) {
        return fail('missing-query', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_query: unknown = pObj['query'];
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'run', query: arm_query } };
      return ok(command);
    }
    case 'page': {
      if (hasUnexpectedKeys(pObj, ['op', 'cursor'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_cursorRaw: unknown = pObj['cursor'];
      if (typeof arm_cursorRaw !== 'string') {
        return fail('invalid-cursor', { type: CMD_READ_REPORT, correlationId });
      }
      if (arm_cursorRaw.length < 1 || arm_cursorRaw.length > 512) {
        return fail('invalid-cursor', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_cursor: string = arm_cursorRaw;
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'page', cursor: arm_cursor } };
      return ok(command);
    }
    case 'drillDown': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId', 'rootId'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const arm_rootIdRaw: unknown = pObj['rootId'];
      if (!isSafePathSegment(arm_rootIdRaw)) {
        return fail('invalid-rootId', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_rootId: string = arm_rootIdRaw;
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'drillDown', reportId: arm_reportId, rootId: arm_rootId } };
      return ok(command);
    }
    case 'close': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'close', reportId: arm_reportId } };
      return ok(command);
    }
    case 'rerunSaved': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'rerunSaved', reportId: arm_reportId } };
      return ok(command);
    }
    case 'reproduceSaved': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'reproduceSaved', reportId: arm_reportId } };
      return ok(command);
    }
    case 'listSaved': {
      if (hasUnexpectedKeys(pObj, ['op', 'request'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const arm_requestRaw: unknown = pObj['request'];
      let arm_request: unknown | undefined;
      if (arm_requestRaw !== undefined) {
        const arm_requestChecked: unknown = arm_requestRaw;
        arm_request = arm_requestChecked;
      }
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'listSaved', ...(arm_request === undefined ? {} : { request: arm_request }) } };
      return ok(command);
    }
    case 'cancelActive': {
      if (hasUnexpectedKeys(pObj, ['op'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_REPORT, correlationId });
      }
      const command: ReadReportCommand = { type: CMD_READ_REPORT, correlationId, payload: { op: 'cancelActive' } };
      return ok(command);
    }
    default:
      return fail('invalid-op', { type: CMD_READ_REPORT, correlationId });
  }
}

export function validateMutateReport(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_MUTATE_REPORT, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  const disc: unknown = pObj['op'];
  if (typeof disc !== 'string') {
    return fail('missing-op', { type: CMD_MUTATE_REPORT, correlationId });
  }
  switch (disc) {
    case 'export': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId', 'format'])) {
        return fail('unexpected-payload-fields', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const arm_formatRaw: unknown = pObj['format'];
      if (!(arm_formatRaw === 'json' || arm_formatRaw === 'csv')) {
        return fail('invalid-format', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_format: 'json' | 'csv' = arm_formatRaw;
      const command: MutateReportCommand = { type: CMD_MUTATE_REPORT, correlationId, payload: { op: 'export', reportId: arm_reportId, format: arm_format } };
      return ok(command);
    }
    case 'save': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const command: MutateReportCommand = { type: CMD_MUTATE_REPORT, correlationId, payload: { op: 'save', reportId: arm_reportId } };
      return ok(command);
    }
    case 'deleteSaved': {
      if (hasUnexpectedKeys(pObj, ['op', 'reportId', 'confirmed'])) {
        return fail('unexpected-payload-fields', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportIdRaw: unknown = pObj['reportId'];
      if (!isSafePathSegment(arm_reportIdRaw)) {
        return fail('invalid-reportId', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_reportId: string = arm_reportIdRaw;
      const arm_confirmedRaw: unknown = pObj['confirmed'];
      if (arm_confirmedRaw !== true) {
        return fail('missing-confirmation', { type: CMD_MUTATE_REPORT, correlationId });
      }
      const arm_confirmed = true as const;
      const command: MutateReportCommand = { type: CMD_MUTATE_REPORT, correlationId, payload: { op: 'deleteSaved', reportId: arm_reportId, confirmed: arm_confirmed } };
      return ok(command);
    }
    default:
      return fail('invalid-op', { type: CMD_MUTATE_REPORT, correlationId });
  }
}
