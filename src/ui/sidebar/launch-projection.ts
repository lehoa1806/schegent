// Feature 102 (FR-R3-018) T010 — what Runs may start.
//
// Contract: `specs/102-runs-launch-surface/contracts/launch-projection.md`.
//
// **Nothing here re-resolves the store.** Every field is read out of a catalog
// projection the composer has already built: a Pipeline's ports are its declared
// ones, a Workflow's are `record.derivedInputs`, which `projectWorkflowCatalog`
// computed through `deriveWorkflowPorts` (FR-017, FR-018). A second derivation
// beside that one would be a second answer to "what will this ask me for", and
// the two would disagree the first time either moved.
//
// **The sort lives here, not in the component.** Both sections then order the
// same way by construction, and an unchanged catalog projects identically twice
// so the list does not reshuffle under the operator between renders (FR-001).
// Map iteration order is not a sort: it happens to be insertion order today and
// is no part of any contract the store offers.
//
// **The loading arm is the absence of the field**, not a fourth member of
// `LaunchSection` — the convention `phaseCatalog`, `pipelineCatalog`, and
// `workflowCatalog` already carry. Giving one fact two representations is how
// the two come to disagree about a host with no catalog wired at all.

import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../../contracts/backend-kinds';
import { isPipelineInputPortType } from '../../contracts/pipeline-definitions';
import type { PipelineInputPort } from '../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { WorkflowDerivedPort } from '../../contracts/workflow-definitions';
import { declaredCapabilitySet } from '../../contracts/phase-capabilities';
import type { CapabilityNotice } from '../../contracts/snapshot-projections';
import { effectiveRunnerKindForPhase } from '../../config/pipeline-snapshot';
import { describeCapabilityOutcome } from '../../services/capability-disclosure';
import { planCapabilityEnforcement } from '../../services/capability-enforcement-plan';
import { phaseDefinitionToPhaseDef } from '../../config/process-catalog';
import type {
  BuilderLifecycle,
  Launchable,
  LaunchablePort,
  LaunchProjection,
  LaunchSection,
  PhaseCatalogProjection,
  PipelineCatalogProjection,
  WorkflowCatalogProjection
} from './snapshot';

/**
 * The active version a record may be launched at, or nothing.
 *
 * The three inclusion conditions that concern the lifecycle, folded into one
 * answer because they produce one: the version id is both the gate and the
 * value. `draft` and a deactivated definition are the same case here — FR-002
 * calls both "has no active version" — and neither is an error.
 *
 * `''` is refused rather than carried. The store never issues it and
 * `BuilderLifecycle` documents absence instead, so a blank one arriving here is
 * a defect upstream; listing the entry anyway would put a run on the queue whose
 * recorded provenance is a version that does not exist (FR-027).
 */
function activeVersionOf(lifecycle: BuilderLifecycle | undefined): string | undefined {
  if (lifecycle === undefined) return undefined;
  if (lifecycle.state !== 'active' && lifecycle.state !== 'active-with-draft') return undefined;
  const versionId = lifecycle.activeVersionId;
  return versionId !== undefined && versionId !== '' ? versionId : undefined;
}

/**
 * One authored string off a record's `display`, if it is one.
 *
 * `display` is a free-form record of the authored scalars, already sanitized and
 * capped by the catalog projection. A field that is missing or is not a string
 * falls through to the validated definition, which carries the same text through
 * the same sanitizer — never to a placeholder, and never to the raw id.
 */
function displayText(
  display: Readonly<Record<string, unknown>>,
  field: string
): string | undefined {
  const value = display[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pipelinePort(port: PipelineInputPort): LaunchablePort {
  return Object.freeze({
    portId: port.portId,
    label: port.label,
    type: port.type,
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.description !== undefined ? { description: port.description } : {})
  });
}

/**
 * A Workflow's derived input ports, narrowed to the input types.
 *
 * `WorkflowDerivedPort` carries the input-or-output union because one shape
 * serves both derived lists; an entry in the *input* list always holds an input
 * type. Narrowing at this boundary rather than widening `LaunchablePort` keeps
 * the launch form from having to handle a type no input can have.
 *
 * No `required`. The derived shape does not carry it, and reconstructing one
 * here would be the second derivation this module exists to avoid (FR-018) —
 * absence reads as "not declared required", which is what the graph says.
 */
function workflowPorts(ports: readonly WorkflowDerivedPort[]): readonly LaunchablePort[] {
  const narrowed: LaunchablePort[] = [];
  for (const port of ports) {
    if (!isPipelineInputPortType(port.type)) continue;
    narrowed.push(
      Object.freeze({
        portId: port.portId,
        label: port.label,
        type: port.type,
        nodeId: port.nodeId
      })
    );
  }
  return Object.freeze(narrowed);
}

/**
 * Display name, case-insensitively, with the definition id as the tie-break.
 *
 * The tie-break is what makes the order total: the collator calls two names
 * equal for more reasons than identity, and two entries the sort considers
 * interchangeable would be free to swap between passes.
 */
function byDisplayName(left: Launchable, right: Launchable): number {
  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' });
  if (byName !== 0) return byName;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function entriesSection(entries: readonly Launchable[]): LaunchSection {
  return Object.freeze({ state: 'entries' as const, entries: Object.freeze(entries) });
}

/**
 * Which empty arm a section is in.
 *
 * The discriminator is whether the source projection held any records at all,
 * never the length of the entry list — three of the four states produce an empty
 * list, so the list cannot say which one this is. That conflation is the current
 * defect: `emptyCatalogGuidance(count)` takes a count, and a workspace whose
 * definitions all failed to resolve is told it has none.
 */
function emptySection(recordCount: number): LaunchSection {
  return recordCount === 0
    ? Object.freeze({ state: 'no-definitions' as const })
    : Object.freeze({ state: 'none-active' as const });
}

function sectionOf(entries: readonly Launchable[], recordCount: number): LaunchSection {
  return entries.length > 0 ? entriesSection(entries) : emptySection(recordCount);
}

/**
 * FR-R4-F06 (FR-007; contract D, D3) -- what the backend question is asked against.
 *
 * `phasesById` is the effective Phase catalog keyed by id, and `defaultRunner` is the
 * window's resolved default. Both come from the composer; neither is re-resolved here.
 */
interface BackendContext {
  readonly phasesById: ReadonlyMap<string, PhaseDefinition>;
  readonly defaultRunner: BackendRunnerKind;
}

/**
 * The backends a list of Phases would spawn, by the freeze's OWN function.
 *
 * `effectiveRunnerKindForPhase` is what `snapshotPhaseDef` applies when a Run is frozen,
 * so the notice and the Run cannot disagree: a Phase's pinned `runner` wins over the window
 * default, and a `sideEffects: git` Phase always runs on Claude. It is reused, not
 * restated. A Phase the catalog does not resolve contributes the window default, the
 * conservative answer: such a launch is refused at freeze anyway, and a notice that
 * named nothing would be the less safe error.
 */
function backendsOfPhases(
  phaseIds: readonly string[],
  context: BackendContext
): ReadonlySet<BackendRunnerKind> {
  const kinds = new Set<BackendRunnerKind>();
  for (const phaseId of phaseIds) {
    const definition = context.phasesById.get(phaseId);
    kinds.add(
      effectiveRunnerKindForPhase(
        definition === undefined ? undefined : phaseDefinitionToPhaseDef(definition),
        context.defaultRunner
      )
    );
  }
  return kinds;
}

/** Non-empty, unique and in `SUPPORTED_BACKENDS` order, so an unchanged catalog projects identically. */
function orderedBackends(
  kinds: ReadonlySet<BackendRunnerKind>,
  context: BackendContext
): readonly BackendRunnerKind[] {
  const present = kinds.size > 0 ? kinds : new Set<BackendRunnerKind>([context.defaultRunner]);
  return Object.freeze(SUPPORTED_BACKENDS.filter((kind) => present.has(kind)));
}

/**
 * FR-R4-F06 (FR-012; contract K, K6) -- what each Phase of a launchable that declares a capability set
 * would do, planned on THAT Phase's effective backend (the same one `backends` reports), worded by the host.
 *
 * A Phase that declares nothing yields nothing, and so does one whose restriction leaves nothing open
 * (`describeCapabilityOutcome` answers `null`). A Phase met twice is noted once. The planner is the one
 * the adapters spawn from, so the sentence describes the Run that would start and cannot drift from it.
 */
function capabilityNoticesOfPhases(
  phaseIds: readonly string[],
  context: BackendContext,
  seen: Set<string>
): readonly CapabilityNotice[] {
  const notices: CapabilityNotice[] = [];
  for (const phaseId of phaseIds) {
    if (seen.has(phaseId)) continue;
    const definition = context.phasesById.get(phaseId);
    if (definition?.capabilities === undefined) continue;
    seen.add(phaseId);
    const backend = effectiveRunnerKindForPhase(
      phaseDefinitionToPhaseDef(definition),
      context.defaultRunner
    );
    const plan = planCapabilityEnforcement(backend, declaredCapabilitySet(definition.capabilities));
    const text = describeCapabilityOutcome(plan, definition.name);
    if (text === null) continue;
    notices.push({
      phaseName: definition.name,
      backend,
      outcome: plan.outcome === 'refused' ? 'refused' : 'residual',
      text
    });
  }
  return notices;
}

function pipelineBackends(
  phaseIds: readonly string[],
  context: BackendContext
): ReadonlySet<BackendRunnerKind> {
  return backendsOfPhases(phaseIds, context);
}

function pipelineEntries(
  catalog: PipelineCatalogProjection,
  context: BackendContext
): readonly Launchable[] {
  const entries: Launchable[] = [];
  for (const record of catalog.records) {
    const activeVersionId = activeVersionOf(record.lifecycle);
    // A record with no resolved definition has no ports to offer and would be
    // refused at freeze anyway; the provenance table sources `inputs` from the
    // definition, so there is no entry to build without one.
    if (activeVersionId === undefined || record.definition === null) continue;
    const description = displayText(record.display, 'description') ?? record.definition.description;
    entries.push(
      Object.freeze({
        kind: 'pipeline' as const,
        id: record.pipelineId,
        name: displayText(record.display, 'name') ?? record.definition.name,
        ...(description !== undefined ? { description } : {}),
        activeVersionId,
        inputs: Object.freeze(record.definition.inputs.map(pipelinePort)),
        backends: orderedBackends(pipelineBackends(record.definition.phaseIds, context), context),
        capabilityNotices: Object.freeze(
          capabilityNoticesOfPhases(record.definition.phaseIds, context, new Set())
        )
      })
    );
  }
  return entries.sort(byDisplayName);
}

function workflowEntries(
  catalog: WorkflowCatalogProjection,
  effectivePipelineIds: ReadonlySet<string>,
  pipelinePhaseIds: ReadonlyMap<string, readonly string[]>,
  context: BackendContext
): readonly Launchable[] {
  const entries: Launchable[] = [];
  for (const record of catalog.records) {
    const activeVersionId = activeVersionOf(record.lifecycle);
    if (activeVersionId === undefined || record.definition === null) continue;
    // FR-005, checked rather than inferred. `deriveWorkflowPorts` contributes
    // nothing for an unknown node, so a Workflow with one unresolvable member
    // and no other unsatisfied ports is indistinguishable, by port list alone,
    // from one that needs no inputs.
    const resolvable = record.definition.nodes.every((node) =>
      effectivePipelineIds.has(node.pipelineId)
    );
    if (!resolvable) continue;
    const description = displayText(record.display, 'description') ?? record.definition.description;
    // FR-R4-F06 (D3) -- the union over the node Pipelines, each resolved through the
    // effective catalog the `resolvable` check above already required.
    const union = new Set<BackendRunnerKind>();
    const notices: CapabilityNotice[] = [];
    const notedPhases = new Set<string>();
    for (const node of record.definition.nodes) {
      const phaseIds = pipelinePhaseIds.get(node.pipelineId) ?? [];
      for (const kind of pipelineBackends(phaseIds, context)) union.add(kind);
      notices.push(...capabilityNoticesOfPhases(phaseIds, context, notedPhases));
    }
    entries.push(
      Object.freeze({
        kind: 'workflow' as const,
        id: record.workflowId,
        name: displayText(record.display, 'name') ?? record.definition.name,
        ...(description !== undefined ? { description } : {}),
        activeVersionId,
        inputs: workflowPorts(record.derivedInputs),
        startNodeIds: Object.freeze([...record.definition.startNodeIds]),
        backends: orderedBackends(union, context),
        capabilityNotices: Object.freeze(notices)
      })
    );
  }
  return entries.sort(byDisplayName);
}

/**
 * What Runs may start, from the catalog projections that already exist.
 *
 * Returns nothing while either source catalog is unresolved: the field's absence
 * is the loading state, and a projection built from one resolved catalog and one
 * missing would render a confident "no Workflows" for a host that has not looked
 * (FR-006).
 *
 * An errored source projection carries no records and so reads as
 * `no-definitions`. Explaining a resolution failure stays with the catalog
 * projection that holds the `error` field; this feature adds no arm for it.
 */
export function buildLaunchProjection(
  pipelineCatalog: PipelineCatalogProjection | undefined,
  workflowCatalog: WorkflowCatalogProjection | undefined,
  phaseCatalog?: PhaseCatalogProjection,
  defaultRunner: BackendRunnerKind = DEFAULT_BACKEND
): LaunchProjection | undefined {
  if (pipelineCatalog === undefined || workflowCatalog === undefined) return undefined;
  // The effective catalog is the set of Active versions (100 FR-007), which is
  // what a run can actually be frozen against — not the record list, which
  // includes rows that resolved to nothing.
  const effectivePipelineIds = new Set(
    pipelineCatalog.effective.map((definition) => definition.pipelineId)
  );
  // FR-R4-F06 (D3) -- the backends each entry would spawn, asked of the effective
  // catalogs and never of the store. An absent Phase catalog is the loading state, and
  // every Phase then contributes the window default.
  const context: BackendContext = {
    phasesById: new Map(
      (phaseCatalog?.effective ?? []).map((definition) => [definition.phaseId, definition])
    ),
    defaultRunner
  };
  const pipelinePhaseIds = new Map(
    pipelineCatalog.effective.map((definition) => [definition.pipelineId, definition.phaseIds])
  );
  return Object.freeze({
    pipelines: sectionOf(
      pipelineEntries(pipelineCatalog, context),
      pipelineCatalog.records.length
    ),
    workflows: sectionOf(
      workflowEntries(workflowCatalog, effectivePipelineIds, pipelinePhaseIds, context),
      workflowCatalog.records.length
    )
  });
}
