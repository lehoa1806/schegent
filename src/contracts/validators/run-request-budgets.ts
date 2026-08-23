/**
 * FR-R3-057 (M-03 / R-11) — resource budgets on a run request, enforced at
 * validation, before anything is persisted.
 *
 * `run-request-shape.ts` validated shape only, and bounded exactly two fields
 * (`portId`, `pipelineId`, 64 characters each). Everything that carries actual
 * volume -- an input's value, a supplemental item's text, the item counts -- was
 * unbounded. A single local input therefore amplified into memory, persisted
 * state, stdin volume (the trigger for H-04), tokens and provider cost.
 *
 * BYTES, NOT CHARACTERS
 *
 * Every budget here is UTF-8 bytes via `Buffer.byteLength`, because bytes are
 * what gets written, stored and billed. A character budget under-counts by up to
 * 4x on non-ASCII input, which is the wrong direction for a resource bound: the
 * operator writing CJK or emoji is the one who would exceed it.
 *
 * The one pre-existing bound, `instructions-too-long`, stays on characters. It
 * is a UI-facing description limit shared with queue items, not a resource
 * budget, and changing its unit would change which existing inputs it rejects.
 * The aggregate below counts instructions in bytes regardless, so the resource
 * question is still answered.
 *
 * WHY AN AGGREGATE
 *
 * Per-field budgets do not compose. 256 supplemental items of 1 MiB each is
 * 256 MiB with every individual field inside its limit. The aggregate is the
 * only bound that answers "how large can one accepted request be", which is the
 * number FR-R3-052's memory arithmetic needs.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** One contract input's value. Generous for pasted content, far below a leak. */
export const MAX_INPUT_VALUE_BYTES = MIB;

/** One supplemental `text` or `instruction` item. */
export const MAX_SUPPLEMENTAL_TEXT_BYTES = MIB;

/** A filesystem path. `PATH_MAX` on Linux and macOS. */
export const MAX_PATH_BYTES = 4096;

/** A URL. Above every practical limit, below what any server accepts. */
export const MAX_URL_BYTES = 2048;

/** An output target path. */
export const MAX_OUTPUT_TARGET_BYTES = 4096;

export const MAX_INPUT_COUNT = 64;
export const MAX_SUPPLEMENTAL_COUNT = 256;
export const MAX_OUTPUT_COUNT = 64;

/**
 * The whole request, summed. Binds even when every field passes, which is the
 * case per-field budgets cannot cover.
 */
export const MAX_REQUEST_TOTAL_BYTES = 4 * MIB;

export interface BudgetViolation {
  readonly field: string;
  readonly code: BudgetErrorCode;
  readonly limit: number;
  readonly actual: number;
}

export type BudgetErrorCode =
  | 'input-value-too-large'
  | 'supplemental-value-too-large'
  | 'output-target-too-long'
  | 'inputs-count-exceeded'
  | 'supplemental-count-exceeded'
  | 'outputs-count-exceeded'
  | 'request-bytes-exceeded';

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

interface BudgetShapedRequest {
  readonly inputs?: readonly unknown[];
  readonly supplemental?: readonly unknown[];
  readonly outputs?: readonly unknown[];
  readonly instructions?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The single byte-bearing string of a supplemental item, by kind, with the limit
 * that applies to it. Returns null for a kind that carries no free-form string
 * (`prior-output` is a structured reference, and inventing a string form for it
 * here would be the first half of a parser).
 */
function supplementalPayload(
  item: Record<string, unknown>
): { readonly value: string; readonly limit: number } | null {
  switch (item.kind) {
    case 'local-file':
    case 'local-folder':
      return typeof item.path === 'string'
        ? { value: item.path, limit: MAX_PATH_BYTES }
        : null;
    case 'url':
      return typeof item.url === 'string' ? { value: item.url, limit: MAX_URL_BYTES } : null;
    case 'text':
    case 'instruction':
      return typeof item.text === 'string'
        ? { value: item.text, limit: MAX_SUPPLEMENTAL_TEXT_BYTES }
        : null;
    default:
      return null;
  }
}

/**
 * Every budget a request violates, in field order. Empty means it fits.
 *
 * Reports ALL violations rather than the first, matching `validateRunRequest`'s
 * FR-013 discipline: an operator who pasted three oversized inputs should not
 * have to submit three times to learn that.
 *
 * Tolerant of a malformed request on purpose. The shape predicate is a separate
 * gate and runs alongside this one; a budget check that threw on an unexpected
 * type would turn a shape error into a crash at whichever boundary called it
 * first.
 */
export function runRequestBudgetViolations(
  request: BudgetShapedRequest
): readonly BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  let total = 0;

  const inputs = request.inputs ?? [];
  if (inputs.length > MAX_INPUT_COUNT) {
    violations.push({
      field: 'inputs',
      code: 'inputs-count-exceeded',
      limit: MAX_INPUT_COUNT,
      actual: inputs.length
    });
  }
  inputs.forEach((raw, index) => {
    const input = asRecord(raw);
    if (!input || typeof input.value !== 'string') return;
    const size = bytes(input.value);
    total += size;
    if (size > MAX_INPUT_VALUE_BYTES) {
      violations.push({
        field: `inputs[${index}].value`,
        code: 'input-value-too-large',
        limit: MAX_INPUT_VALUE_BYTES,
        actual: size
      });
    }
  });

  const supplemental = request.supplemental ?? [];
  if (supplemental.length > MAX_SUPPLEMENTAL_COUNT) {
    violations.push({
      field: 'supplemental',
      code: 'supplemental-count-exceeded',
      limit: MAX_SUPPLEMENTAL_COUNT,
      actual: supplemental.length
    });
  }
  supplemental.forEach((raw, index) => {
    const item = asRecord(raw);
    if (!item) return;
    const payload = supplementalPayload(item);
    if (!payload) return;
    const size = bytes(payload.value);
    total += size;
    if (size > payload.limit) {
      violations.push({
        field: `supplemental[${index}]`,
        code: 'supplemental-value-too-large',
        limit: payload.limit,
        actual: size
      });
    }
  });

  const outputs = request.outputs ?? [];
  if (outputs.length > MAX_OUTPUT_COUNT) {
    violations.push({
      field: 'outputs',
      code: 'outputs-count-exceeded',
      limit: MAX_OUTPUT_COUNT,
      actual: outputs.length
    });
  }
  outputs.forEach((raw, index) => {
    const output = asRecord(raw);
    if (!output || typeof output.target !== 'string') return;
    const size = bytes(output.target);
    total += size;
    if (size > MAX_OUTPUT_TARGET_BYTES) {
      violations.push({
        field: `outputs[${index}].target`,
        code: 'output-target-too-long',
        limit: MAX_OUTPUT_TARGET_BYTES,
        actual: size
      });
    }
  });

  if (typeof request.instructions === 'string') total += bytes(request.instructions);

  if (total > MAX_REQUEST_TOTAL_BYTES) {
    violations.push({
      field: 'request',
      code: 'request-bytes-exceeded',
      limit: MAX_REQUEST_TOTAL_BYTES,
      actual: total
    });
  }

  return violations;
}
