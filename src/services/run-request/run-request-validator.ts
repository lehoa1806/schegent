// Feature 087 (T016-T020, T026, T032, US1/US2) — Run Request validation, and
// the only place an `ExecutionEnvelope` is constructed.
//
// "Parse, don't validate": this returns the more precise type rather than a
// boolean, so an envelope cannot exist without having been checked, and
// there is no `isValid` flag a later edit can leave stale. The enqueue path
// accepts nothing else, which is what makes "validation is the
// only thing that creates durable state for a Run" structural rather than a
// convention someone has to remember.
//
// FR-R3-001 (T257) widened what rests on that: the envelope is no longer only
// what the queue persists, it is what the prompt, the runner, and the output
// probe read. So this module exports exactly one thing that can produce one —
// `validateRunRequest()` — and no builder, factory, defaulter, or `Partial`
// widener beside it. `tests/lint/no-envelope-reconstruction.test.ts` fails the
// build if a second one appears anywhere under `src/`.
//
// Two rules shape the whole file:
//
//   * It accumulates (FR-013). Returning at the first bad field would make the
//     operator fix a request one round trip at a time.
//   * It returns, never throws, on a validation failure. A thrown error would
//     collapse every field down to whichever one happened to be checked first.
//
// Headless by construction: no `vscode` (T033 lints it), no clock — the freeze
// time arrives as `now` — and no direct filesystem access. The three gates that
// need the world get it through injected ports, which is also what lets the
// error-hygiene sweep fire every code without building a hostile tree on disk.

import type {
  FrozenInputBinding,
  FrozenSupplementalInput,
  RunInputValue,
  RunRequest,
  RunRequestErrorCode,
  RunRequestFieldError,
  SupplementalInput,
  ValidationOutcome
} from '../../contracts/run-request';
import type { CatalogVersionRef } from '../../contracts/catalog-version';
import type {
  PipelineInputPort,
  PipelineInputPortType
} from '../../contracts/pipeline-definitions';
import type { PhaseDef, PipelineDef } from '../../config/pipeline-config';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../config/pipeline-snapshot';
import { MAX_DESCRIPTION_LENGTH } from '../../queue/feature-request';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { WorkflowRunPipeline } from '../../state/workflow-run';
import {
  FOLDER_MAX_BYTES,
  FOLDER_MAX_FILES,
  type LocalCheckResult
} from './local-input-validator';
import {
  validateOutputTargets,
  type OutputTargetProbe
} from './output-target-validator';
import {
  resolvePriorOutput,
  type PriorRunOutputSource
} from './output-reference-resolver';
import { runRequestBudgetViolations } from '../../contracts/validators/run-request-budgets';

/**
 * The filesystem half of the local-reference gate, injected rather than imported
 * so this module holds no I/O of its own. `checkLocalFile` and `checkLocalFolder`
 * are the production implementations.
 */
export interface LocalInputProbe {
  checkFile(workspaceRoot: string, candidate: string): Promise<LocalCheckResult>;
  checkFolder(workspaceRoot: string, candidate: string): Promise<LocalCheckResult>;
}

/**
 * The Pipeline the request names, as it stands in the **effective** catalog at
 * submission, together with its Phases resolved through that same catalog.
 *
 * Passed in already resolved, and deliberately *not* already snapshotted. The
 * caller owns resolution — it is the only thing that can see the effective
 * catalog, and letting this module resolve too would create a second oracle
 * that could disagree with the one the run uses. But the caller does not own the
 * **freeze**: expanding this into the durable snapshot happens here, at
 * validation (FR-030), because a plan that was expanded elsewhere and handed in
 * could have been expanded at any time, against any catalog.
 */
export interface EffectivePipelineSource {
  readonly definition: PipelineDef;
  /** In sequence order. A Phase the catalog no longer has is absent, not substituted. */
  readonly phases: readonly PhaseDef[];
  /** The backend a Phase inherits when it names none. */
  readonly defaultRunnerKind?: BackendRunnerKind;
}

/**
 * Everything validation needs about the world, passed in rather than reached
 * for.
 */
export interface RunRequestValidationContext {
  readonly pipeline: EffectivePipelineSource;
  /** `null` when no folder is open; every path-bearing field then refuses. */
  readonly workspaceRoot: string | null;
  /** Injected so the frozen plan's `frozenAt` is deterministic under test. */
  readonly now: number;
  readonly localInputs: LocalInputProbe;
  readonly outputProbe: OutputTargetProbe;
  readonly priorOutputs: PriorRunOutputSource;
  /**
   * Feature 102 (T036, FR-021, FR-022) — the published version the caller
   * resolved for the definition in `pipeline`, stamped onto the plan verbatim.
   *
   * A value, never a lookup. This module resolves nothing of its own: a second
   * resolver over the effective catalog would be a second oracle, and the two
   * would answer differently the moment a publication lands between them. The
   * caller reads the version at the same gate it read the definition, so the
   * version and the body it describes come from one read.
   *
   * Absent means the caller resolved none — a start against a caller-supplied
   * snapshot, or a host with no version port wired — and the plan then records
   * none (FR-021, FR-027). This module never substitutes one.
   */
  readonly catalogVersion?: CatalogVersionRef;
}

/**
 * A `pipeline-output` input port is fed by an earlier Phase in the sequence, so
 * it is not part of the operator-facing contract at all (FR-001a). It is
 * neither required of the operator nor settable by them.
 */
const PHASE_FED_PORT_TYPE = 'pipeline-output';

function error(
  field: string,
  code: RunRequestErrorCode,
  message: string,
  bounds?: { limit: number; actual: number }
): RunRequestFieldError {
  return bounds === undefined ? { field, code, message } : { field, code, message, ...bounds };
}

function isOperatorSupplied(port: PipelineInputPort): boolean {
  return port.type !== PHASE_FED_PORT_TYPE;
}

/**
 * A required port supplied as whitespace is not supplied. The alternative —
 * accepting it and letting the Phase receive a blank — turns a composition
 * mistake into a wasted run.
 */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Wording for every refusal a value-level gate can return.
 *
 * The gates return codes, not prose, precisely so this table is the only place
 * a message is written — and so a reviewer can read the whole vocabulary at once
 * and see that none of it names a path (FR-020). The folder bounds interpolate
 * their limit because a number is not a location.
 */
function messageFor(failure: Extract<LocalCheckResult, { ok: false }>): string {
  switch (failure.code) {
    case 'path-escapes-workspace':
      return 'This path resolves outside the workspace.';
    case 'symlink-limit-exceeded':
      return 'This path is a symbolic link, or exceeds the link-traversal limit.';
    case 'file-not-found':
      return 'Nothing readable exists at this path.';
    case 'file-unreadable':
      return 'This file could not be read.';
    case 'folder-file-count-exceeded':
      return `This folder holds more than the ${failure.limit ?? FOLDER_MAX_FILES} files allowed.`;
    case 'folder-bytes-exceeded':
      return `This folder is larger than the ${failure.limit ?? FOLDER_MAX_BYTES} bytes allowed.`;
    case 'folder-extension-not-allowed':
      return 'This folder holds a file whose type is not accepted.';
    case 'url-malformed':
      return 'This is not a well-formed URL.';
    case 'url-scheme-not-allowed':
      return 'This URL scheme is not accepted.';
    case 'no-workspace-root':
      return 'Open a workspace folder before referencing a path.';
    default:
      return 'This value could not be validated.';
  }
}

function toFieldError(
  field: string,
  failure: Extract<LocalCheckResult, { ok: false }>
): RunRequestFieldError {
  const bounds =
    failure.limit === undefined || failure.actual === undefined
      ? undefined
      : { limit: failure.limit, actual: failure.actual };
  return error(field, failure.code, messageFor(failure), bounds);
}

const NO_WORKSPACE_ROOT: Extract<LocalCheckResult, { ok: false }> = {
  ok: false,
  code: 'no-workspace-root'
};

/**
 * Check the value itself, once its declared type has matched the port's.
 *
 * A blank value is passed over rather than checked: for a required port the
 * required gate has already reported it, and for an optional one a blank means
 * the operator supplied nothing.
 */
async function checkValue(
  type: PipelineInputPortType,
  value: string,
  context: RunRequestValidationContext
): Promise<LocalCheckResult> {
  if (isBlank(value)) return { ok: true };
  switch (type) {
    case 'local-file':
      return context.workspaceRoot === null
        ? NO_WORKSPACE_ROOT
        : context.localInputs.checkFile(context.workspaceRoot, value);
    case 'local-folder':
      return context.workspaceRoot === null
        ? NO_WORKSPACE_ROOT
        : context.localInputs.checkFolder(context.workspaceRoot, value);
    case 'web-url':
      return validateUrlReference(value);
    default:
      // `text`, `source`, `source-list`, and `repository-context` carry no
      // structure this feature defines. Inventing one here — splitting a
      // `source-list` on newlines, say — would be a semantics the spec does not
      // give and the catalog never agreed to.
      return { ok: true };
  }
}

interface ContractResult {
  readonly errors: readonly RunRequestFieldError[];
  readonly bindings: readonly FrozenInputBinding[];
}

async function validateContractInputs(
  supplied: readonly RunInputValue[],
  ports: readonly PipelineInputPort[],
  context: RunRequestValidationContext
): Promise<ContractResult> {
  const declared = new Map(ports.map((port) => [port.portId, port]));
  const errors: RunRequestFieldError[] = [];
  const bindings: FrozenInputBinding[] = [];
  const filled = new Map<string, string>();
  // A port this loop already faulted is not additionally reported as missing
  // below: the operator did address it, and "wrong type" plus "required" on one
  // field reads as two problems where there is one.
  const faulted = new Set<string>();

  for (const input of supplied) {
    const field = `inputs.${input.portId}`;
    const port = declared.get(input.portId);

    // A port already filled by an earlier entry is, for this entry, no longer a
    // port the request can address — the same condition an undeclared one is in.
    if (port === undefined || filled.has(input.portId)) {
      faulted.add(input.portId);
      errors.push(
        error(
          field,
          'unknown-input-port',
          'The Pipeline declares no unfilled input port with this identifier.'
        )
      );
      continue;
    }

    if (!isOperatorSupplied(port)) {
      faulted.add(input.portId);
      errors.push(
        error(
          field,
          'phase-fed-input-port',
          'This input is produced by an earlier Phase and cannot be supplied here.'
        )
      );
      continue;
    }

    // Structural, not coercive: a `local-file` port does not accept a `text`
    // value because a path happens to be a string. The declared types must be
    // equal, and the per-type checks of the value itself come later (T032).
    if (input.type !== port.type) {
      faulted.add(input.portId);
      errors.push(
        error(
          field,
          'type-mismatch',
          `Expected a value declared as ${port.type}, but this value is declared as ${input.type}.`
        )
      );
      continue;
    }

    const valueCheck = await checkValue(port.type, input.value, context);
    if (!valueCheck.ok) {
      faulted.add(input.portId);
      errors.push(toFieldError(field, valueCheck));
      continue;
    }

    filled.set(input.portId, input.value);
    bindings.push({ portId: port.portId, type: port.type, value: input.value });
  }

  // Reported in declaration order, after the supplied entries, so the operator
  // reads "what I sent was wrong" before "what I did not send is missing".
  for (const port of ports) {
    if (!isOperatorSupplied(port) || port.required !== true) continue;
    if (faulted.has(port.portId)) continue;
    const value = filled.get(port.portId);
    if (value !== undefined && !isBlank(value)) continue;
    errors.push(
      error(`inputs.${port.portId}`, 'missing-required-input', 'This input is required.')
    );
  }

  return { errors, bindings };
}

/**
 * The only schemes a URL reference may carry (FR-019).
 *
 * The allowlist is what closes `file:` — the traversal bypass that would walk
 * straight past the workspace-containment gate — along with `javascript:`,
 * `data:`, and the editor's own `vscode:` command surface.
 */
const ALLOWED_URL_SCHEMES = ['https:', 'http:'] as const;

/**
 * Check a URL's shape and scheme. Performs no network access, by construction:
 * there is no I/O in this function to remove later.
 *
 * Reachability is deliberately not checked. Dereferencing an operator-supplied
 * URL during validation is the SSRF primitive itself, and an unreachable host is
 * reported where access is attempted rather than substituted for here.
 */
export function validateUrlReference(value: string): LocalCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: 'url-malformed' };
  }
  // No separate host check: `https:` and `http:` are WHATWG "special" schemes,
  // for which the parser already requires a non-empty host — `https://` throws,
  // and `https:///path` normalizes to the host `path`. A guard here would be
  // unreachable for the only two schemes that get this far.
  if (!(ALLOWED_URL_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    return { ok: false, code: 'url-scheme-not-allowed' };
  }
  return { ok: true };
}

/**
 * FR-R3-057 — the budget violations, mapped to field errors.
 *
 * The message names the field and the two numbers and nothing else: no value
 * excerpt, no resolved path (FR-020). An operator who pasted 4 MiB needs to know
 * which field and by how much.
 */
function validateBudgets(request: RunRequest): readonly RunRequestFieldError[] {
  return runRequestBudgetViolations(request).map((violation) =>
    error(
      violation.field,
      violation.code,
      `${violation.field} exceeds its budget of ${violation.limit} ` +
        `(actual ${violation.actual}).`,
      { limit: violation.limit, actual: violation.actual }
    )
  );
}

function validateInstructions(instructions: string | undefined): readonly RunRequestFieldError[] {
  if (instructions === undefined || instructions.length <= MAX_DESCRIPTION_LENGTH) return [];
  // The limit is the existing host bound on a queue item's description, imported
  // rather than restated — a second literal is a second thing to keep in step.
  return [
    error(
      'instructions',
      'instructions-too-long',
      `Instructions exceed the ${MAX_DESCRIPTION_LENGTH}-character limit.`,
      { limit: MAX_DESCRIPTION_LENGTH, actual: instructions.length }
    )
  ];
}

interface SupplementalResult {
  readonly errors: readonly RunRequestFieldError[];
  readonly frozen: readonly FrozenSupplementalInput[];
}

/**
 * Supplemental inputs are addressed by position, because they have no port to
 * name them by — they are not part of the Pipeline's contract (FR-003), which is
 * exactly why they live in their own section of the composer.
 */
async function validateSupplemental(
  items: readonly SupplementalInput[],
  context: RunRequestValidationContext
): Promise<SupplementalResult> {
  const errors: RunRequestFieldError[] = [];
  const frozen: FrozenSupplementalInput[] = [];

  for (const [index, item] of items.entries()) {
    const field = `supplemental[${index}]`;

    if (item.kind === 'text' || item.kind === 'instruction') {
      frozen.push({ kind: item.kind, value: item.text });
      continue;
    }

    if (item.kind === 'prior-output') {
      const resolved = resolvePriorOutput(context.priorOutputs, item.reference);
      if (!resolved.ok) {
        errors.push(
          error(
            field,
            resolved.code,
            resolved.code === 'prior-run-not-found'
              ? 'The Run this reference points at no longer exists.'
              : 'That Run has no resolved output by this name.'
          )
        );
        continue;
      }
      // The resolved location is frozen alongside the reference that produced
      // it, so a later change to the source Run cannot retarget this one
      // (FR-028) and the provenance is still readable.
      frozen.push({ kind: item.kind, value: resolved.reference, reference: item.reference });
      continue;
    }

    const check =
      item.kind === 'url'
        ? validateUrlReference(item.url)
        : await checkLocalReference(item.kind, item.path, context);
    if (!check.ok) {
      errors.push(toFieldError(field, check));
      continue;
    }
    frozen.push({ kind: item.kind, value: item.kind === 'url' ? item.url : item.path });
  }

  return { errors, frozen };
}

function checkLocalReference(
  kind: 'local-file' | 'local-folder',
  candidate: string,
  context: RunRequestValidationContext
): Promise<LocalCheckResult> {
  return checkValue(kind === 'local-file' ? 'local-file' : 'local-folder', candidate, context);
}

/**
 * With no folder open there is no root to resolve a target against, so every
 * declared or requested output refuses rather than one global error standing in
 * for all of them — the operator sees it on the fields it applies to.
 */
function refuseOutputsWithoutRoot(
  request: RunRequest,
  ports: readonly { readonly portId: string }[]
): readonly RunRequestFieldError[] {
  const portIds = new Set<string>(ports.map((port) => port.portId));
  for (const output of request.outputs) portIds.add(output.portId);
  return [...portIds].map((portId) =>
    error(`outputs.${portId}`, 'no-workspace-root', messageFor(NO_WORKSPACE_ROOT))
  );
}

/**
 * The FR-030 freeze: the complete expanded Pipeline-plus-Phases definition, in
 * one object, produced by the same two helpers the drain path has always used —
 * so a plan-carrying Run and a legacy resolve-at-drain Run produce byte-identical
 * snapshots from the same catalog.
 *
 * Note what is *absent*: no fallback. `WorkflowRunFactory.resolvePipeline()` used
 * to substitute the built-in Pipeline for an unknown id and to drop a Phase the
 * catalog no longer had, which is exactly the fail-open behaviour FR-033 forbids;
 * feature 098 (T024/T025) made both a refusal there too. Here the Phase list is
 * whatever the caller resolved, and a Phase the catalog no longer has is simply
 * not in it — the definition freezes as it truly was.
 */
function freezePipeline(source: EffectivePipelineSource): WorkflowRunPipeline {
  return snapshotPipelineContract(
    source.definition,
    source.phases.map((phase) => snapshotPhaseDef(phase, source.defaultRunnerKind))
  );
}

/**
 * Validate `request` against the Pipeline snapshot in `context` and, on
 * success, produce the `ExecutionEnvelope` the enqueue path persists and the
 * execution path runs from.
 *
 * This is the only construction site of an envelope in the codebase (T257).
 * Asynchronous because the local-reference and output-target gates reach the
 * filesystem through their ports; a failure is always a returned
 * `{ ok: false }`, never a rejection.
 */
export async function validateRunRequest(
  request: RunRequest,
  context: RunRequestValidationContext
): Promise<ValidationOutcome> {
  // The freeze happens first, and everything below validates against it. A
  // request checked against the authored row and frozen from the snapshot could
  // be checked against ports the snapshot does not carry.
  const frozenPipeline = freezePipeline(context.pipeline);
  const inputPorts = frozenPipeline.inputs ?? [];
  const outputPorts = frozenPipeline.outputs ?? [];

  const contract = await validateContractInputs(request.inputs, inputPorts, context);
  const supplemental = await validateSupplemental(request.supplemental, context);
  const outputs =
    context.workspaceRoot === null
      ? { errors: refuseOutputsWithoutRoot(request, outputPorts), outputs: [] }
      : await validateOutputTargets({
          requested: request.outputs,
          ports: outputPorts,
          workspaceRoot: context.workspaceRoot,
          probe: context.outputProbe
        });

  const errors = [
    ...contract.errors,
    ...supplemental.errors,
    ...outputs.errors,
    ...validateInstructions(request.instructions),
    // FR-R3-057 — budgets before persistence. Placed with the other field
    // errors so a rejected request mutates nothing (FR-R3-001's envelope
    // discipline) and the operator sees every violation at once.
    ...validateBudgets(request)
  ];

  if (errors.length > 0) return { ok: false, errors };

  // The single envelope literal in `src/`. The lint gate anchors on this
  // object's `frozenAt` key, so moving or renaming it fails the build rather
  // than silently emptying the scan.
  return {
    ok: true,
    plan: {
      pipeline: frozenPipeline,
      inputs: contract.bindings,
      supplemental: supplemental.frozen,
      outputs: outputs.outputs,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      frozenAt: context.now,
      // Feature 102 (T036, FR-021, FR-027). Stamped, not resolved: whatever the
      // caller resolved is what the plan records, and an absent value records
      // absence rather than becoming `''` or a guess.
      ...(context.catalogVersion === undefined ? {} : { catalogVersion: context.catalogVersion })
    }
  };
}
