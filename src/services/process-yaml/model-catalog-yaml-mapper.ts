// Feature 096 — Model Catalog document parsing and serialization.
//
// Flatter than Phase/Pipeline/Workflow: no `metadata`/`spec` split, no
// `included` section (data-model.md "Model Catalog File"). There is also no
// existing catalog validator to delegate to — a Model Catalog's runtime shape
// is a plain `Record<BackendRunnerKind, readonly string[]>`, not a defined
// type with its own field-rule validator — so, unlike `classifyPipeline` /
// `classifyWorkflow`, this file performs its own full structural parse
// directly against the YAML tree rather than admitting a generic section and
// delegating.
//
// Model Catalog also carries no row-level defect channel (no `invalid`
// outcome exists for it — see `ModelCatalogImportRow`/`ModelCatalogSkipRow` in
// `./types`). Anything that would be a resource-level `ImportDefect` for
// Pipeline/Workflow (an unknown field, a wrong-shaped section) is therefore a
// document-level `DocumentRefusal` here instead: there is no row left to
// attach it to.

import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  type DocumentRefusal,
  type DocumentRefusalCode,
  type ModelCatalogYamlDocument,
  type ModelCatalogYamlGroup,
  type YamlMappingNode
} from './types';
import { echo } from './package-reader';
import { findScalar } from './phase-yaml-validator';
import {
  emitEntry,
  emitMappingSequence,
  emitSequence,
  MODEL_CATALOG_DOCUMENT_KEY_ORDER,
  MODEL_CATALOG_GROUP_KEY_ORDER
} from './yaml-serializer';

const MODEL_CATALOG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  MODEL_CATALOG_DOCUMENT_KEY_ORDER
);
const MODEL_CATALOG_GROUP_KEYS: ReadonlySet<string> = new Set(MODEL_CATALOG_GROUP_KEY_ORDER);

export type ModelCatalogParseResult =
  | { readonly ok: true; readonly document: ModelCatalogYamlDocument }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

function refuse(code: DocumentRefusalCode, message: string): ModelCatalogParseResult {
  return { ok: false, refusal: { code, message } };
}

/**
 * Parse a Model Catalog document from an already-scanned mapping node.
 *
 * Independently re-checks its own `apiVersion`/`kind` rather than trusting the
 * earlier `dispatchKind()` call in `preflight-service.ts` — that call is a
 * dispatch, not the enforcement site, the same convention
 * `parsePipelinePackage` / `parseWorkflowPackage` follow.
 */
export function parseModelCatalogDocument(node: YamlMappingNode): ModelCatalogParseResult {
  const apiVersion = findScalar(node, 'apiVersion');
  if (apiVersion === undefined) {
    return refuse('unsupported-version', 'Document does not declare apiVersion');
  }
  if (apiVersion.value !== PHASE_YAML_API_VERSION) {
    return refuse(
      'unsupported-version',
      `Unsupported apiVersion '${echo(apiVersion.value)}'; this build reads ${PHASE_YAML_API_VERSION}`
    );
  }
  const kind = findScalar(node, 'kind');
  if (kind === undefined) {
    return refuse('unsupported-kind', 'Document does not declare kind');
  }
  if (kind.value !== MODEL_CATALOG_YAML_KIND) {
    return refuse(
      'unsupported-kind',
      `Unsupported kind '${echo(kind.value)}'; expected ${MODEL_CATALOG_YAML_KIND}`
    );
  }
  for (const entry of node.entries) {
    if (!MODEL_CATALOG_TOP_LEVEL_KEYS.has(entry.key)) {
      return refuse('disallowed-syntax', `Unknown field '${echo(entry.key)}'`);
    }
  }

  const groupsEntry = node.entries.find((entry) => entry.key === 'groups');
  if (groupsEntry === undefined) {
    // Absent, not present-but-empty — the same absent-not-empty convention
    // this format uses everywhere (research R3). A zero-groups document is
    // well-formed (data-model.md); it is reached only this way, because an
    // explicit `groups:` with nothing under it parses as an empty MAPPING
    // (a sequence is never empty) and is refused below like any other
    // wrong-shaped `groups`.
    return {
      ok: true,
      document: { apiVersion: PHASE_YAML_API_VERSION, kind: MODEL_CATALOG_YAML_KIND, groups: [] }
    };
  }
  if (groupsEntry.value.kind !== 'sequence') {
    return refuse('disallowed-syntax', 'groups must be a sequence of mappings');
  }

  const groups: ModelCatalogYamlGroup[] = [];
  for (const item of groupsEntry.value.items) {
    if (item.kind !== 'mapping') {
      return refuse('disallowed-syntax', 'Each group must be a mapping');
    }
    for (const entry of item.entries) {
      if (!MODEL_CATALOG_GROUP_KEYS.has(entry.key)) {
        return refuse('disallowed-syntax', `Unknown field '${echo(entry.key)}'`);
      }
    }
    // Raw `.value`, never `scalarValue()`/`plainValue()` — a backend name or
    // model id is an opaque identifier, and the coercion those helpers apply
    // to unquoted scalars would turn a numeric-looking one into a JS number.
    const backend = findScalar(item, 'backend');
    if (backend === undefined) {
      return refuse('disallowed-syntax', 'Each group requires a backend');
    }

    const modelsEntry = item.entries.find((entry) => entry.key === 'models');
    if (modelsEntry === undefined) {
      groups.push({ backend: backend.value });
      continue;
    }
    if (modelsEntry.value.kind !== 'sequence') {
      // Also where an explicit empty `models:` lands (empty mapping, not a
      // sequence) — data-model.md: "empty models sequence is disallowed-syntax".
      return refuse('disallowed-syntax', 'models must be a sequence of scalars');
    }
    const models: string[] = [];
    for (const modelItem of modelsEntry.value.items) {
      if (modelItem.kind !== 'scalar') {
        return refuse('disallowed-syntax', 'Each model id must be a scalar');
      }
      models.push(modelItem.value);
    }
    groups.push({ backend: backend.value, models });
  }

  return {
    ok: true,
    document: { apiVersion: PHASE_YAML_API_VERSION, kind: MODEL_CATALOG_YAML_KIND, groups }
  };
}

function renderGroup(bodyIndent: string, group: ModelCatalogYamlGroup): string {
  let out = '';
  for (const key of MODEL_CATALOG_GROUP_KEY_ORDER) {
    switch (key) {
      case 'backend':
        out += emitEntry(bodyIndent, 'backend', group.backend);
        break;
      case 'models':
        if (group.models !== undefined) out += emitSequence(bodyIndent, 'models', group.models);
        break;
    }
  }
  return out;
}

/**
 * Render a document. The same document always renders to the same bytes, and
 * the result parses back to the same document (SC-003, shared across kinds).
 */
export function serializeModelCatalogDocument(document: ModelCatalogYamlDocument): string {
  let out = '';
  for (const key of MODEL_CATALOG_DOCUMENT_KEY_ORDER) {
    switch (key) {
      case 'apiVersion':
      case 'kind':
        out += emitEntry('', key, document[key]);
        break;
      case 'groups':
        out += emitMappingSequence('', 'groups', document.groups, renderGroup);
        break;
    }
  }
  return out;
}
