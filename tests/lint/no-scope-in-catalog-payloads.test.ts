/**
 * Feature 099 (T496c, FR-040, FR-043, SC-007) — no scope field, no `shadowed`
 * status, and no layer identifier survives anywhere in a catalog payload, on
 * either side of the webview boundary.
 *
 * `tests/lint/catalog-purity.test.ts` pins the same absence inside `src/catalog/`,
 * where it is easy: that directory is new code written after the tier was deleted.
 * The payload path is where the tier actually lived. Every record that reaches the
 * Builder used to carry a `scope`, every status union used to have a `shadowed`
 * arm, and the resolvers used to merge three layers into one list. The collapse
 * removed all of that — and a field removed from a type is not the same as a field
 * that cannot reach the wire, which is why this file checks both:
 *
 *   1. **Static.** The payload-carrying modules on both sides declare no scope
 *      field, no `shadowed` arm, and no layer identifier. Both sides, because the
 *      webview mirrors the host contract by hand: a field deleted on one side and
 *      left on the other is the exact drift the mirror is prone to, and the stale
 *      side is the one that keeps rendering a layer badge.
 *   2. **Runtime.** The real resolvers and the real projection composers are driven
 *      over stored bodies that *do* carry `scope`, `shadowed`, and layer keys, and
 *      the projected payload is swept key by key. This is the half that matters,
 *      because the store deliberately does not validate what it stores (FR-010):
 *      a body with a `scope` key is legal on disk, and the only thing standing
 *      between it and the wire is that the projection is built from an allowlist
 *      rather than by spreading the row. A change from allowlist to passthrough
 *      passes check 1 and fails here.
 *
 * The Workflow kind is why check 2 is not redundant. The Phase and Pipeline
 * validators reject an unknown authored field outright — a row carrying `scope`
 * comes back `invalid` with an `unknown-field` error — so for those two kinds the
 * tier is stopped a layer earlier than the projection. The Workflow validator does
 * not: a Workflow row carrying `scope: 'user'` resolves `effective`, and the
 * projection's allowlist is the *only* thing between that field and the webview.
 * That asymmetry is pre-existing and out of scope to change here; it is exactly the
 * condition this check is worth having for.
 *
 * Neither half asserts the word never appears in the repository. `scope` is an
 * ordinary English word — "out of scope", a telemetry scope, a config section —
 * and a lint that banned it outright would be worked around within a week.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { composePhaseCatalogProjection } from '../../src/ui/sidebar/phase-catalog-projection';
import { composePipelineCatalogProjection } from '../../src/ui/sidebar/pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from '../../src/ui/sidebar/workflow-catalog-projector';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Every module a catalog payload passes through between the store and the DOM.
 *
 * Host contracts, host resolvers, host projections, and then the webview's own
 * mirror of all three. Listed explicitly rather than globbed: this is the set the
 * tier lived in, and a new payload module joining it should be a deliberate line
 * in this list rather than something a glob quietly absorbs.
 */
const PAYLOAD_MODULES: readonly string[] = [
  'src/contracts/catalog-store.ts',
  'src/contracts/process-definitions.ts',
  'src/contracts/pipeline-definitions.ts',
  'src/contracts/workflow-definitions.ts',
  'src/config/process-catalog.ts',
  'src/config/pipeline-catalog.ts',
  'src/config/workflow-catalog.ts',
  'src/config/process-definition-validator.ts',
  'src/config/pipeline-definition-validator.ts',
  'src/config/workflow-definition-validator.ts',
  'src/catalog/snapshot-rows.ts',
  'src/ui/sidebar/phase-catalog-projection.ts',
  'src/ui/sidebar/pipeline-catalog-projection.ts',
  'src/ui/sidebar/workflow-catalog-projector.ts',
  'webview-ui/src/lib/snapshot-types.ts',
  'webview-ui/src/components/PipelineBuilderEditors/types.ts'
];

/**
 * The tier, in every form a payload could carry it.
 *
 * `scope` is matched as a *property or type name* — `scope:`, `.scope`, `Scope` in
 * an identifier — never as a bare word, so prose survives and a field does not.
 * The layer names are matched as quoted literals for the same reason: the string
 * `'user'` in a payload is a layer id; the word "user" in a sentence is not.
 */
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'a scope property', pattern: /(^|[^A-Za-z])scope\??\s*:/ },
  { label: 'a scope member access', pattern: /\.scope\b/ },
  { label: 'a scope type name', pattern: /\b[A-Za-z]*(?:DefinitionScope|ScopeLiteral|ScopeId)\b/ },
  { label: 'a shadowed status', pattern: /'shadowed'|"shadowed"|\bshadowed\s*:/ },
  { label: 'a precedence layer', pattern: /\bPhasePrecedence|\bPrecedenceLayer\b/ },
  { label: 'a presence scan order', pattern: /\bPRESENCE_SCAN_ORDER\b/ },
  { label: 'an override-allowing trust setting', pattern: /allow(?:Pipeline|Workflow)Overrides/ },
  // The three layer names as payload values. `'workspace'` is deliberately absent:
  // it is the workspace *root* vocabulary too, and it is banned as a layer by the
  // `DefinitionScope` and `scope:` patterns above wherever it would be one.
  { label: 'a layer id literal', pattern: /(['"])(?:built-in|builtin|user-scope)\1/ }
];

/**
 * The one `scope` in these modules that is not a definition scope.
 *
 * `AuditTailEntry.scope` says whether an audit event belongs to a task or to the
 * system. It predates the layer tier, outlives it, and shares nothing with it but
 * the word. Exempted by its declared type rather than by line number, so widening
 * that union to admit a layer name stops matching and the lint fires again.
 */
const AUDIT_SCOPE_DECLARATION = /scope:\s*'task'\s*\|\s*'system'/;

/** A line that is only a comment cannot put a field on the wire. */
function isProse(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * A payload with its validator errors removed.
 *
 * An error naming the field it rejected — `{field: 'scope', code: 'unknown-field'}`
 * — carries the string `'scope'` as a value, and that is the validator *refusing*
 * the tier, which is the opposite of carrying it. Sweeping error text for the
 * words it exists to report would make the check fire on the behaviour it wants.
 */
function withoutErrors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutErrors);
  if (value === null || typeof value !== 'object') return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'errors' || key === 'warnings' || key === 'error') continue;
    stripped[key] = withoutErrors(child);
  }
  return stripped;
}

/** Every key name anywhere in a JSON-serialisable value, however deeply nested. */
function keysOf(value: unknown, into: Set<string> = new Set()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

/** Every string *value* anywhere in a JSON-serialisable value. */
function stringsOf(value: unknown, into: Set<string> = new Set()): ReadonlySet<string> {
  if (typeof value === 'string') {
    into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) stringsOf(child, into);
  }
  return into;
}

const identity = (value: string): string => value;

/**
 * Stored bodies that carry the deleted tier in every place a body can carry it,
 * paired with a clean row of the same kind.
 *
 * These are legal on disk — the store stores what it is given (FR-010) — so this
 * is not a hypothetical: an operator importing YAML written against the old shape
 * puts exactly these keys into the store, and the question this file answers is
 * whether they come back out at the boundary. The clean row is there so both
 * status arms are represented in the swept payload; a check that only ever saw
 * `invalid` rows would miss a field that rides on a resolved definition.
 */
const PHASE_ROWS: readonly unknown[] = [
  { phaseId: 'implement', name: 'Implement', version: 1, instruction: 'Do the work' },
  {
    phaseId: 'tiered',
    name: 'Tiered',
    version: 1,
    instruction: 'Do the work',
    scope: 'user',
    shadowed: true,
    layer: 'built-in',
    precedence: 2,
    definitionScope: 'workspace'
  }
];

const PIPELINE_ROWS: readonly unknown[] = [
  {
    pipelineId: 'default',
    name: 'Default',
    version: 1,
    phaseIds: ['implement'],
    outputs: [{ portId: 'notes', label: 'Notes', type: 'markdown' }]
  },
  {
    pipelineId: 'tiered',
    name: 'Tiered',
    version: 1,
    phaseIds: ['implement'],
    scope: 'workspace',
    shadowedBy: 'user',
    layer: 'user'
  }
];

const WORKFLOW_ROWS: readonly unknown[] = [
  {
    workflowId: 'ship',
    name: 'Ship',
    version: 1,
    nodes: [{ nodeId: 'a', pipelineId: 'default' }],
    connections: [],
    startNodeIds: ['a']
  },
  // This one resolves `effective` despite the tier fields — see the header. It is
  // the sharpest case in the file: a live definition whose stored body carries a
  // scope, projected for the webview.
  {
    workflowId: 'tiered',
    name: 'Tiered',
    version: 1,
    nodes: [{ nodeId: 'a', pipelineId: 'default' }],
    connections: [],
    startNodeIds: ['a'],
    scope: 'user',
    shadowed: false,
    layer: 'built-in'
  }
];

/** The three boundary payloads, built by the code that really builds them. */
function projectEverything(): Readonly<Record<string, unknown>> {
  const phaseCatalog = resolvePhaseCatalog({ rows: PHASE_ROWS, revision: 'r1' });
  const pipelineCatalog = resolvePipelineCatalog({
    rows: PIPELINE_ROWS,
    revision: 'r1',
    phaseCatalog: phaseCatalog.effective
  });
  const workflowCatalog = resolveWorkflowCatalog({
    rows: WORKFLOW_ROWS,
    revision: 'r1',
    pipelineCatalog: {
      effective: pipelineCatalog.effective,
      records: pipelineCatalog.records
    }
  });

  return {
    phases: composePhaseCatalogProjection(phaseCatalog, {
      sanitize: identity,
      availableModels: { claude: ['claude-opus-5'] } as never,
      defaultRunnerKind: 'claude' as never
    }),
    pipelines: composePipelineCatalogProjection(() => pipelineCatalog, {
      sanitize: identity,
      availableModels: { claude: ['claude-opus-5'] },
      defaultRunnerKind: 'claude'
    }),
    workflows: composeWorkflowCatalogProjection(
      {
        getWorkflowCatalog: () => workflowCatalog,
        getPipelineCatalog: () => ({ effective: pipelineCatalog.effective })
      },
      identity
    )
  };
}

describe('catalog payloads carry no scope, no shadowed status, and no layer id (SC-007)', () => {
  it('scans both sides of the boundary', () => {
    // Vacuity guard. A renamed module would otherwise make every check below pass
    // by scanning nothing.
    for (const module of PAYLOAD_MODULES) {
      expect(
        readFileSync(resolve(REPO_ROOT, module), 'utf8').length,
        `${module} must exist and be non-empty`
      ).toBeGreaterThan(0);
    }
    expect(PAYLOAD_MODULES.filter((path) => path.startsWith('webview-ui/')).length).toBe(2);
  });

  it('declares none of them in any payload module', () => {
    const hits: string[] = [];
    for (const module of PAYLOAD_MODULES) {
      const lines = readFileSync(resolve(REPO_ROOT, module), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isProse(line) || AUDIT_SCOPE_DECLARATION.test(line)) return;
        for (const { label, pattern } of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) hits.push(`${module}:${index + 1} declares ${label}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('projects none of them, even from stored bodies that carry all of them', () => {
    const payloads = projectEverything();

    // The projections must have projected something, or the sweep is vacuous.
    for (const [kind, payload] of Object.entries(payloads)) {
      expect(payload, `${kind} must project`).toBeDefined();
      expect(
        (payload as { records: readonly unknown[] }).records.length,
        `${kind} must retain its source rows`
      ).toBe(2);
    }

    const keys = keysOf(payloads);
    // Vacuity guard on the walker itself: a `keysOf` that stopped descending
    // would report an empty set and pass every assertion below.
    expect([...keys]).toEqual(expect.arrayContaining(['status', 'definition', 'display', 'key']));

    for (const forbidden of [
      'scope',
      'definitionScope',
      'shadowed',
      'shadowedBy',
      'layer',
      'precedence'
    ]) {
      expect([...keys], `a payload carries the key '${forbidden}'`).not.toContain(forbidden);
    }

    // And no value is a layer name either: a `status` narrowed to two arms in the
    // type but still assigned `'shadowed'` would pass the key sweep.
    const values = stringsOf(withoutErrors(payloads));
    for (const forbidden of ['shadowed', 'built-in', 'builtin', 'user-scope']) {
      expect([...values], `a payload carries the value '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it('drops the tier from a definition that resolves with it (FR-043)', () => {
    // Narrow enough to name the case: `tiered` is a live Workflow whose stored
    // body carries `scope`, `shadowed`, and `layer`, and whose validator does not
    // reject them. It reaches the boundary resolved, and it reaches it clean.
    const workflows = projectEverything().workflows as {
      readonly records: readonly { readonly workflowId: string; readonly status: string }[];
      readonly effective: readonly Readonly<Record<string, unknown>>[];
    };

    const tiered = workflows.records.find((record) => record.workflowId === 'tiered');
    expect(tiered?.status).toBe('effective');
    expect(Object.keys(tiered ?? {})).not.toContain('scope');

    const projected = workflows.effective.find((definition) => definition.workflowId === 'tiered');
    expect(projected, 'the tiered Workflow must be effective').toBeDefined();
    for (const forbidden of ['scope', 'shadowed', 'layer']) {
      expect(Object.keys(projected ?? {})).not.toContain(forbidden);
    }
  });

  it('keeps every status in the two arms the collapse left (FR-040)', () => {
    // The complement of the sweep above: it proves `shadowed` is gone, this proves
    // something valid is there instead — a record whose status went missing would
    // satisfy "no shadowed" perfectly.
    const statuses = new Set<unknown>();
    for (const payload of Object.values(projectEverything())) {
      for (const record of (payload as { records: readonly { status: unknown }[] }).records) {
        statuses.add(record.status);
      }
    }
    expect([...statuses].sort()).toEqual(['effective', 'invalid']);
  });
});
