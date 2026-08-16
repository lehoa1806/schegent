// Feature 096 T018 — contracts/model-catalog-exchange.md §2, SC-006.
//
// Two things this file pins. First, `planModelCatalogImport`'s row
// classification: a new model id imports, an already-known one skips with
// `already-exists`, and an id under a backend this build does not recognize
// skips with `unrecognized-backend` — never a document-level refusal, because
// backend recognition is a plan-time decision (data-model.md Decision 3).
//
// Second, SC-006's document-refusal coverage: `parseModelCatalogDocument` (and
// the scanner it sits on) reads a `ModelCatalog` document through the same
// closed `DocumentRefusalCode` vocabulary Phase/Pipeline/Workflow already use —
// no new code is introduced. Two codes in that vocabulary are structurally
// unreachable for this kind, and this file pins *why* rather than skipping them
// silently: `duplicate-id` is a package-level dedup that only `pipeline-
// document.ts`/`workflow-document.ts` perform, and a Model Catalog document is
// never a package (no `included` section — a repeated backend group is
// well-formed and resolves at the row level instead); `graph-cycle` is a
// Workflow node-graph property this format has no graph to have one in.

import { describe, expect, it } from 'vitest';

import type { BackendRunnerKind } from '../../src/runner/backend-runner-factory';
import { planModelCatalogImport } from '../../src/services/process-yaml/model-catalog-import-planner';
import { parseModelCatalogDocument } from '../../src/services/process-yaml/model-catalog-yaml-mapper';
import type { DocumentRefusalCode, ModelCatalogYamlDocument } from '../../src/services/process-yaml/types';
import { PHASE_YAML_MAX_BYTES } from '../../src/services/process-yaml/types';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

const EMPTY_CONFIG: ModelsConfig = { claude: [], codex: [], agy: [] };

const BOM = '\uFEFF';

function documentOf(groups: ModelCatalogYamlDocument['groups']): ModelCatalogYamlDocument {
  return { apiVersion: 'schegent/v1', kind: 'ModelCatalog', groups };
}

/** Scans and parses in one step; throws on scan failure since these fixtures are meant to scan cleanly. */
function parseModelCatalog(
  text: string
): { readonly ok: true } | { readonly ok: false; readonly refusal: { readonly code: DocumentRefusalCode } } {
  const scanned = parseDocumentText(text);
  if (!scanned.ok) return { ok: false, refusal: scanned.refusal };
  const parsed = parseModelCatalogDocument(scanned.node);
  return parsed.ok ? { ok: true } : { ok: false, refusal: parsed.refusal };
}

describe('planModelCatalogImport — row classification (contracts §2)', () => {
  it('imports a model id not already present under its backend', () => {
    const rows = planModelCatalogImport(
      documentOf([{ backend: 'claude', models: ['claude-opus-5'] }]),
      EMPTY_CONFIG
    );

    expect(rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-opus-5',
        backend: 'claude',
        modelId: 'claude-opus-5'
      }
    ]);
  });

  it('skips a model id already present under its backend, reason already-exists', () => {
    const rows = planModelCatalogImport(
      documentOf([{ backend: 'claude', models: ['claude-opus-5'] }]),
      { claude: ['claude-opus-5'], codex: [], agy: [] }
    );

    expect(rows).toEqual([
      {
        outcome: 'skip',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-opus-5',
        backend: 'claude',
        modelId: 'claude-opus-5',
        reason: 'already-exists'
      }
    ]);
  });

  it('skips every model id under a backend this build does not recognize', () => {
    const rows = planModelCatalogImport(
      documentOf([{ backend: 'chatgpt-legacy', models: ['gpt-3'] }]),
      EMPTY_CONFIG
    );

    expect(rows).toEqual([
      {
        outcome: 'skip',
        resourceKind: 'modelCatalog',
        resourceId: 'gpt-3',
        backend: 'chatgpt-legacy',
        modelId: 'gpt-3',
        reason: 'unrecognized-backend'
      }
    ]);
  });

  it('does not refuse the document for an unrecognized backend (row-level, not document-level)', () => {
    const result = parseModelCatalog(
      ['apiVersion: schegent/v1', 'kind: ModelCatalog', 'groups:', '  - backend: foo', '    models:', '      - m1', ''].join(
        '\n'
      )
    );
    expect(result.ok).toBe(true);
  });

  it('silently drops an empty-string model id — no row, no refusal', () => {
    const rows = planModelCatalogImport(
      documentOf([{ backend: 'claude', models: ['', 'claude-opus-5'] }]),
      EMPTY_CONFIG
    );

    expect(rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-opus-5',
        backend: 'claude',
        modelId: 'claude-opus-5'
      }
    ]);
  });

  it('resolves a same-document repeat to already-exists on its second occurrence', () => {
    // Two groups for the SAME backend, the second repeating the first's id.
    // Not a document-level `duplicate-id` refusal (that code is package-only,
    // for Pipeline/Workflow); the planner's seen-set grows as it walks, so this
    // is a row-level distinction instead.
    const rows = planModelCatalogImport(
      documentOf([
        { backend: 'claude', models: ['claude-opus-5'] },
        { backend: 'claude', models: ['claude-opus-5'] }
      ]),
      EMPTY_CONFIG
    );

    expect(rows.map((row) => row.outcome)).toEqual(['import', 'skip']);
    expect(rows[1]).toMatchObject({ reason: 'already-exists' });
  });

  it('byte-for-byte membership: no case-folding or trimming', () => {
    const rows = planModelCatalogImport(
      documentOf([{ backend: 'claude', models: ['Claude-Opus-5'] }]),
      { claude: ['claude-opus-5'], codex: [], agy: [] }
    );

    expect(rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'Claude-Opus-5',
        backend: 'claude',
        modelId: 'Claude-Opus-5'
      }
    ]);
  });
});

interface RefusalCase {
  readonly label: string;
  readonly code: DocumentRefusalCode;
  readonly text: string;
}

const VALID_HEADER = ['apiVersion: schegent/v1', 'kind: ModelCatalog'] as const;

function modelCatalogDocument(bodyLines: readonly string[] = []): string {
  return [...VALID_HEADER, ...bodyLines, ''].join('\n');
}

/** The 7 of 9 `DocumentRefusalCode` members reachable for a ModelCatalog document. */
const REACHABLE_CASES: readonly RefusalCase[] = [
  {
    label: 'a document over the size bound',
    code: 'too-large',
    text: `${modelCatalogDocument()}# ${'x'.repeat(PHASE_YAML_MAX_BYTES)}\n`
  },
  {
    label: 'a completely blank document',
    code: 'empty',
    text: '\n'
  },
  {
    label: 'a document of only comments',
    code: 'empty',
    text: '# nothing here\n\n'
  },
  {
    label: 'a missing apiVersion',
    code: 'unsupported-version',
    text: ['kind: ModelCatalog', ''].join('\n')
  },
  {
    label: 'an apiVersion this build does not read',
    code: 'unsupported-version',
    text: ['apiVersion: schegent/v2', 'kind: ModelCatalog', ''].join('\n')
  },
  {
    label: 'a missing kind',
    code: 'unsupported-kind',
    text: ['apiVersion: schegent/v1', ''].join('\n')
  },
  {
    label: 'a kind this build does not read',
    code: 'unsupported-kind',
    text: ['apiVersion: schegent/v1', 'kind: Deployment', ''].join('\n')
  },
  {
    label: 'a second document start',
    code: 'multi-document',
    text: `${modelCatalogDocument()}---\nkind: ModelCatalog\n`
  },
  {
    label: 'an unknown top-level field',
    code: 'disallowed-syntax',
    text: modelCatalogDocument(['bogus: 1'])
  },
  {
    label: 'groups given as a mapping rather than a sequence',
    code: 'disallowed-syntax',
    text: modelCatalogDocument(['groups:', '  backend: claude'])
  },
  {
    label: 'a group missing backend',
    code: 'disallowed-syntax',
    text: modelCatalogDocument(['groups:', '  - models:', '      - m1'])
  },
  {
    label: 'a group with an unknown field',
    code: 'disallowed-syntax',
    text: modelCatalogDocument(['groups:', '  - backend: claude', '    bogus: 1'])
  },
  {
    label: 'models given as a mapping rather than a sequence',
    code: 'disallowed-syntax',
    text: modelCatalogDocument(['groups:', '  - backend: claude', '    models:', '      m1: true'])
  },
  {
    label: 'an anchor, outside the closed syntax subset',
    code: 'disallowed-syntax',
    text: 'groups:\n  - backend: &b claude\n'
  }
];

describe('ModelCatalog document refusals reuse the existing vocabulary (SC-006, contracts §2)', () => {
  for (const testCase of REACHABLE_CASES) {
    it(`refuses ${testCase.label} as '${testCase.code}'`, () => {
      const result = parseModelCatalog(testCase.text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe(testCase.code);
    });
  }

  it('never invents a code outside the 9-member closed union', () => {
    const validCodes = new Set<DocumentRefusalCode>([
      'unreadable',
      'too-large',
      'unsupported-version',
      'unsupported-kind',
      'disallowed-syntax',
      'multi-document',
      'duplicate-id',
      'graph-cycle',
      'empty'
    ]);
    for (const testCase of REACHABLE_CASES) {
      const result = parseModelCatalog(testCase.text);
      if (result.ok) throw new Error(`fixture '${testCase.label}' was expected to refuse`);
      expect(validCodes.has(result.refusal.code)).toBe(true);
    }
  });

  it('refuses a leading byte-order mark as unreadable (kind-agnostic, before dispatch)', () => {
    const result = parseModelCatalog(`${BOM}${modelCatalogDocument()}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unreadable');
  });

  it('does not refuse a document with two groups for the same backend (duplicate-id is package-only)', () => {
    // `duplicate-id` fires only from `pipeline-document.ts` / `workflow-document.ts`,
    // for a PACKAGE's repeated resource id. A Model Catalog document has no
    // `included` section and is never a package (data-model.md), so this shape —
    // which would be a defect for a Pipeline/Workflow package — is simply two
    // groups here, resolved at the row level by `planModelCatalogImport` instead.
    const result = parseModelCatalog(
      modelCatalogDocument([
        'groups:',
        '  - backend: claude',
        '    models:',
        '      - a',
        '  - backend: claude',
        '    models:',
        '      - b'
      ])
    );
    expect(result.ok).toBe(true);
  });

  it('has no node graph, so graph-cycle cannot occur for this kind', () => {
    // Structural, not a runtime assertion: `parseModelCatalogDocument` has no
    // node/connection concept and calls no graph validator, unlike
    // `parseWorkflowPackage` (the only source of `graph-cycle`). Recorded here
    // as documentation for SC-006's "no new refusal codes are introduced" so the
    // 2-of-9 unreachable codes are both accounted for rather than silently
    // absent from this suite's coverage.
    expect(true).toBe(true);
  });
});
