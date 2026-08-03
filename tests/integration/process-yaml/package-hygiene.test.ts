// Feature 085 T065 — what a package document is allowed to do to the operator's
// screen, and what the import path is allowed to reach (FR-049, FR-062, FR-063).
//
// The document is written by someone else. Every string on the preflight surface
// that came out of it is therefore hostile input with a rendering path, and this
// file pins the three properties that keep that safe:
//
//   FR-049 — sanitized and bounded. Every rendered field goes through the shared
//            redactor and is cut to its own cap, and where a list is cut the
//            untruncated count is reported next to it, so a truncated list reads
//            as truncated rather than as short.
//   FR-062 — presented, not interpreted. The surface writes document text as
//            text; no path turns it into markup or into code.
//   FR-063 — no network. Reading, parsing, validating, and planning a document
//            touch nothing off this machine.
//
// 084 pinned all three for a single Phase. A package widens the surface rather
// than changing it: more row shapes (`blocked` is first reachable here), a
// nested resource whose defects are its own, and a second catalog layer. So the
// assertions below are on the shapes a package adds, using the same expanding-
// sanitizer technique the shipped suite uses — a redactor that makes every value
// longer than its cap proves the cap without needing a document that is itself
// enormous.
//
// The `definition` field is the deliberate exception, and it is asserted as one:
// it is what the commit writes, so bounding it would silently truncate an
// instruction and rewrite what the operator agreed to import. Nothing renders
// it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  ImportPlanRow,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The caps `cmd-preflight-process-yaml.ts` declares, restated as expectations. */
const CAPS = {
  field: 32,
  code: 64,
  message: 512,
  resourceId: 64,
  name: 80,
  defects: 20
} as const;

const CORRELATION = 'package-hygiene-1';

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Pipeline', ...body, ''].join('\n');
}

/**
 * One package that reaches four of the five row shapes at once: the root
 * imports, one included Phase imports, one is already held so it skips, and one
 * is invalid. `blocked` needs a root whose reference resolves nowhere, so it has
 * its own document below.
 */
const MIXED_PACKAGE = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - held',
  '    - broken',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.',
  '    - metadata:',
  '        phaseId: held',
  '        name: Held',
  '        version: 4',
  '      spec:',
  '        instruction: Hold.',
  '    - metadata:',
  '        phaseId: broken',
  '        name: Broken',
  '        version: 1',
  '      spec:',
  '        instruction: Break.',
  // 25 keys no Phase declares, so the row is invalid with more defects than the
  // cap admits — the untruncated count is the only way to know that.
  ...Array.from({ length: 25 }, (_unused, index) => `        bogus${index}: x`)
]);

/** The root names a Phase nothing supplies, so the root row is `blocked`. */
const BLOCKED_PACKAGE = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - absent-phase',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.'
]);

/** Refused as a document, so the only rendered string is the refusal message. */
const REFUSED_PACKAGE = 'apiVersion: schegent/v1\nkind: Deployment\n';

const HELD_PHASE = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });

interface PreflightOptions {
  readonly text: string;
  readonly sanitize?: (value: string) => string;
  readonly phases?: readonly unknown[];
}

interface PreflightRun {
  readonly result: PreflightProcessYamlResult;
  readonly fetchCalls: number;
}

async function preflight(opts: PreflightOptions): Promise<PreflightRun> {
  const acks: CommandAckMessage[] = [];
  // FR-063 as an executable claim rather than only a text scan: the path runs
  // with a fetch that records every call, so an indirect reach shows up as a
  // count rather than as a name this file happened to think of.
  let fetchCalls = 0;
  vi.stubGlobal('fetch', (...args: readonly unknown[]) => {
    fetchCalls += 1;
    throw new Error(`network reached: ${String(args[0])}`);
  });

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: [], workspace: opts.phases ?? [] }),
      readPipelineConfig: () => ({ user: [], workspace: [] }),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(opts.text, 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: opts.sanitize ?? ((value: string) => value)
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { result: acks[0]!.result as PreflightProcessYamlResult, fetchCalls };
}

async function planFor(opts: PreflightOptions): Promise<ImportPlan> {
  const run = await preflight(opts);
  expect(run.result.outcome).toBe('planned');
  if (run.result.outcome !== 'planned') throw new Error('unreachable');
  return run.result.plan;
}

/** A redactor that both replaces and overruns, so one run proves both halves. */
const EXPANDING = (value: string): string => `${value.replaceAll('Ship', '[redacted]')}${'!'.repeat(600)}`;

function rowFor(plan: ImportPlan, resourceId: string): ImportPlanRow {
  const found = plan.rows.find(
    (row) => row.outcome !== 'invalid' && row.resourceId.startsWith(resourceId)
  );
  expect(found, `no row for ${resourceId}`).toBeDefined();
  return found!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// FR-049
// ---------------------------------------------------------------------------

describe('Feature 085 T065 — every rendered string is sanitized and bounded (FR-049)', () => {
  it('bounds the identity and name on every row shape a package produces', async () => {
    const plan = await planFor({
      text: MIXED_PACKAGE,
      sanitize: EXPANDING,
      phases: [HELD_PHASE]
    });

    // All four shapes from one document — the root is blocked because the third
    // Phase it references is the invalid one, so the document supplies a name it
    // cannot supply a definition for. If a shape stopped being produced the loop
    // below would silently assert nothing, so the set is pinned first.
    expect(new Set(plan.rows.map((row) => row.outcome))).toEqual(
      new Set(['import', 'skip', 'invalid', 'blocked'])
    );

    for (const row of plan.rows) {
      if (row.outcome === 'invalid') {
        if (row.resourceId !== null) {
          expect(row.resourceId).toHaveLength(CAPS.resourceId);
        }
        continue;
      }
      expect(row.resourceId, row.outcome).toHaveLength(CAPS.resourceId);
      if (row.outcome !== 'import') {
        expect(row.name, row.outcome).toHaveLength(CAPS.name);
      } else {
        expect(row.name).toHaveLength(CAPS.name);
      }
    }
  });

  it('bounds the blocked row and the Phase id its reason names', async () => {
    // `blocked` is the shape this feature adds, and its `reason` carries a
    // second document-supplied identifier — the one the root referenced and
    // nothing supplied. It is rendered, so it is bounded like the rest.
    const plan = await planFor({ text: BLOCKED_PACKAGE, sanitize: EXPANDING });
    const root = rowFor(plan, 'ship-it');
    expect(root.outcome).toBe('blocked');
    if (root.outcome !== 'blocked') return;

    expect(root.resourceId).toHaveLength(CAPS.resourceId);
    expect(root.name).toHaveLength(CAPS.name);
    expect(root.name.startsWith('[redacted] It')).toBe(true);
    expect(root.reason.phaseId).toHaveLength(CAPS.resourceId);
    expect(root.reason.phaseId.startsWith('absent-phase')).toBe(true);
    // The code is this build's own literal, not the document's, so it is not
    // sanitized into unrecognizability.
    expect(root.reason.code.length).toBeGreaterThan(0);
    expect(root.reason.code).not.toContain('!');
  });

  it('bounds each defect of an included Phase and reports the untruncated count', async () => {
    const plan = await planFor({ text: MIXED_PACKAGE, phases: [HELD_PHASE] });
    const invalid = plan.rows.find((row) => row.outcome === 'invalid');
    expect(invalid).toBeDefined();
    if (invalid?.outcome !== 'invalid') return;

    // The nested resource is the 085 shape: 084 pinned this for a document whose
    // only resource was the Phase itself.
    expect(invalid.resourceKind).toBe('phase');
    expect(invalid.defects).toHaveLength(CAPS.defects);
    expect(invalid.totalDefects).toBe(25);
    expect(invalid.totalDefects).toBeGreaterThan(invalid.defects.length);
    // Counts describe rows, so capping defects inside one does not desynchronize
    // them from the row list.
    const { counts, rows } = plan;
    expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
  });

  it('bounds every defect field, code, and message on a nested resource', async () => {
    const plan = await planFor({
      text: MIXED_PACKAGE,
      sanitize: EXPANDING,
      phases: [HELD_PHASE]
    });
    const invalid = plan.rows.find((row) => row.outcome === 'invalid');
    if (invalid?.outcome !== 'invalid') throw new Error('expected an invalid row');

    expect(invalid.defects.length).toBeGreaterThan(0);
    for (const defect of invalid.defects) {
      expect(defect.field).toHaveLength(CAPS.field);
      expect(defect.code).toHaveLength(CAPS.code);
      expect(defect.message).toHaveLength(CAPS.message);
    }
  });

  it('bounds a document refusal message', async () => {
    const run = await preflight({ text: REFUSED_PACKAGE, sanitize: EXPANDING });
    expect(run.result.outcome).toBe('refused');
    if (run.result.outcome !== 'refused') return;
    expect(run.result.refusal.message).toHaveLength(CAPS.message);
    // The code is a literal of this build's, chosen before the document was
    // read, so it is neither sanitized nor bounded away.
    expect(run.result.refusal.code).toBe('unsupported-kind');
  });

  it('leaves the carried definition of an included Phase untouched', async () => {
    // The exemption, asserted as one. `definition` is what the commit writes;
    // sanitizing it would rewrite what the operator agreed to, and the caps
    // above would truncate an instruction. Nothing renders it.
    const plan = await planFor({ text: MIXED_PACKAGE, sanitize: EXPANDING, phases: [HELD_PHASE] });
    const specify = plan.rows.find(
      (row) => row.outcome === 'import' && row.resourceKind === 'phase'
    );
    if (specify?.outcome !== 'import' || specify.resourceKind !== 'phase') {
      throw new Error('expected an imported Phase row');
    }

    expect(specify.definition.instruction).toBe('Write the spec.');
    expect(specify.definition.name).toBe('Specify');
    expect(specify.definition.phaseId).toBe('specify');
    // …while the rendered fields on the very same row went through the redactor.
    expect(specify.name).toHaveLength(CAPS.name);
  });
});

// ---------------------------------------------------------------------------
// FR-062
// ---------------------------------------------------------------------------

describe('Feature 085 T065 — document text is presented, not interpreted (FR-062)', () => {
  /** Every module that renders or composes what the document said. */
  const SURFACE = [
    'webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte',
    // T070 — the two tables are separate components, and they are where the
    // document's own strings are actually rendered. A split that moved the
    // rendering out of the scanned file without moving the scan with it would
    // have quietly emptied this test rather than failed it.
    'webview-ui/src/components/ProcessImport/ProcessImportPlanTable.svelte',
    'webview-ui/src/components/ProcessImport/ProcessImportResultsTable.svelte',
    'webview-ui/src/components/ProcessImport/ProcessExportButton.svelte',
    'webview-ui/src/components/ProcessImport/process-import-state.ts',
    'webview-ui/src/components/ProcessImport/process-exchange-entry.ts',
    'webview-ui/src/lib/process-yaml-ipc.ts'
  ] as const;

  /**
   * Constructs that turn a string into markup or into code. `{@html …}` is the
   * one that matters most here: it is a single token away from the ordinary
   * `{…}` the rows already use, and it would make a document's `name` a script
   * tag.
   */
  const INTERPRETERS = [
    '{@html',
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function(',
    'setTimeout("',
    "setTimeout('"
  ] as const;

  /** Declarations only — the prose below discusses several of these by name. */
  function declarations(relativePath: string): string {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '\n')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  for (const source of SURFACE) {
    it(`${source} interprets no document-supplied string`, () => {
      const text = declarations(source);
      expect(text.length).toBeGreaterThan(100);
      const offenders = INTERPRETERS.filter((construct) => text.includes(construct));
      expect(offenders).toEqual([]);
    });
  }

  it('renders the row reason through text interpolation', () => {
    // The positive half: the reason cell is where document-derived text is most
    // obviously operator-facing, and it is written as `{line}`. Without this the
    // denylist above would pass a file that stopped rendering anything at all.
    const text = declarations(
      'webview-ui/src/components/ProcessImport/ProcessImportPlanTable.svelte'
    );
    expect(text).toContain('{line}');
  });

  it('detects an interpreter if one were introduced', () => {
    // The negative control, without which a typo in the denylist would make
    // every assertion above vacuously true.
    const planted = '<td>{@html row.name}</td>';
    expect(INTERPRETERS.filter((construct) => planted.includes(construct))).toEqual(['{@html']);
  });
});

// ---------------------------------------------------------------------------
// FR-063
// ---------------------------------------------------------------------------

describe('Feature 085 T065 — no code path on this feature reaches the network (FR-063)', () => {
  const PATH_MODULES = [
    'src/services/process-yaml/yaml-scanner.ts',
    'src/services/process-yaml/yaml-parser.ts',
    'src/services/process-yaml/yaml-serializer.ts',
    'src/services/process-yaml/scalar-style.ts',
    'src/services/process-yaml/phase-yaml-validator.ts',
    'src/services/process-yaml/phase-yaml-mapper.ts',
    'src/services/process-yaml/pipeline-document.ts',
    'src/services/process-yaml/package-resolver.ts',
    'src/services/process-yaml/pipeline-export-selection.ts',
    'src/services/process-yaml/import-planner.ts',
    'src/services/process-yaml/types.ts',
    'src/ui/sidebar/commands/cmd-preflight-process-yaml.ts',
    'src/ui/sidebar/commands/cmd-export-process-yaml.ts'
  ] as const;

  const NETWORK = [
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'node:http',
    'node:https',
    'node:net',
    'node:dns',
    'node:tls',
    "'http'",
    "'https'",
    'axios',
    'undici',
    'node-fetch'
  ] as const;

  function declarations(relativePath: string): string {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '\n')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  for (const source of PATH_MODULES) {
    it(`${source} names no network primitive`, () => {
      const text = declarations(source);
      expect(text.length).toBeGreaterThan(100);
      expect(NETWORK.filter((primitive) => text.includes(primitive))).toEqual([]);
    });
  }

  it('plans a package without calling fetch, and refuses one without calling it either', async () => {
    // The scan is a denylist of names; this is the behavior. A reach through an
    // indirection the list does not spell would still be counted here.
    const planned = await preflight({ text: MIXED_PACKAGE, phases: [HELD_PHASE] });
    expect(planned.result.outcome).toBe('planned');
    expect(planned.fetchCalls).toBe(0);

    const refused = await preflight({ text: REFUSED_PACKAGE });
    expect(refused.result.outcome).toBe('refused');
    expect(refused.fetchCalls).toBe(0);
  });
});
