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

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML
} from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ImportPlan,
  ImportPlanRow,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import * as SERIALIZER from '../../../src/services/process-yaml/yaml-serializer';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
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

/**
 * The revision every stored-layer read below reports.
 *
 * Feature 099 (T496f, FR-042, FR-044) — a distinctive sentinel rather than a
 * plausible-looking digest, because it is host-derived installation state that
 * the store computes and the operator never wrote. It is exactly the class of
 * value this file exists to keep out of an exported document, and a sentinel is
 * what lets that be asserted by name instead of hoped for: see the value-leak
 * scan, which the key whitelist cannot make this claim for — a revision would
 * arrive as a bare value, under a key the schema already declares.
 */
const STORE_REVISION = 'rev-sentinel-8f3c2a';

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
      // Feature 099 (T496f, FR-042) — one stored layer with the revision it was
      // read at, where this carried a `{ user, workspace }` pair per catalog. The
      // preflight's presence rule is unchanged and is what `opts.phases` feeds: it
      // scans STORED rows at every status, never the effective catalog, so a held
      // id still produces a `skip` row below. Only the number of lists it scans
      // collapsed.
      readPhaseConfig: () => ({ rows: opts.phases ?? [], revision: STORE_REVISION }),
      readPipelineConfig: () => ({ rows: [], revision: STORE_REVISION }),
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
      // Model Catalog rows carry `backend`/`modelId`, not `name` — this fixture
      // is a Phase/Pipeline/Workflow package (FR-015 forbids a mixed document),
      // so the arm never fires here; it exists to keep the loop type-safe.
      if (row.resourceKind === 'modelCatalog') continue;
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
    expect(root.reason.dependency.kind).toBe('phase');
    expect(root.reason.dependency.resourceId).toHaveLength(CAPS.resourceId);
    expect(root.reason.dependency.resourceId.startsWith('absent-phase')).toBe(true);
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
  /**
   * Feature 086 T070 — the service directory is read rather than listed.
   *
   * 085 wrote out the eleven service modules that existed then, and 086 added four
   * more (`workflow-document`, `workflow-export-selection`, `workflow-export-closure`,
   * `package-reader`) which the list did not name. Nothing failed: a denylist scan
   * over a hand-maintained list of files cannot notice the file it was never given,
   * so the gap made this check quieter instead of louder. The two command modules
   * stay explicit because they live among two dozen unrelated handlers.
   */
  const PATH_MODULES = [
    ...readdirSync(resolve(REPO_ROOT, 'src/services/process-yaml'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `src/services/process-yaml/${name}`)
      .sort(),
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

// ---------------------------------------------------------------------------
// Feature 086 — FR-055, FR-053
// ---------------------------------------------------------------------------

describe('Feature 086 T051 — a capability-gated field is gated on presence, never contents (FR-055)', () => {
  // `retryCondition` is the one field on this path that becomes code somewhere
  // else. `repo/src/lib/retry-condition.ts` owns the grammar and evaluates it in
  // the sandbox at run time; to the exchange path it is inert text, checked for
  // presence and non-emptiness and carried byte-for-byte to the write whose own
  // validator owns it.
  //
  // Peeking at the expression here — to pre-check it, to normalize it, to decide
  // whether it "really" needs the capability — would put an evaluator on the
  // untrusted-document path, which is exactly the hard rule this pins.

  /**
   * A document whose Phase carries an expression the DSL would refuse outright.
   * The point is that nothing on this path can tell: the row is eligible, the
   * capability flag is raised, and the text arrives at the write unchanged.
   */
  const RETRY_EXPRESSION = 'exitCode == 2 && attempt < 3 || not_a_function(surely)';

  const RETRY_PACKAGE = packageDocument([
    'metadata:',
    '  id: retryer',
    '  name: Retryer',
    '  version: 1',
    'spec:',
    '  phaseIds:',
    '    - flaky',
    'included:',
    '  phases:',
    '    - metadata:',
    '        phaseId: flaky',
    '        name: Flaky',
    '        version: 1',
    '      spec:',
    '        instruction: Try again.',
    `        retryCondition: ${RETRY_EXPRESSION}`
  ]);

  /** Every module the document's bytes actually pass through on this path. */
  const EXCHANGE_PATH = [
    'src/services/process-yaml/yaml-scanner.ts',
    'src/services/process-yaml/yaml-parser.ts',
    'src/services/process-yaml/yaml-serializer.ts',
    'src/services/process-yaml/scalar-style.ts',
    'src/services/process-yaml/phase-yaml-validator.ts',
    'src/services/process-yaml/phase-yaml-mapper.ts',
    'src/services/process-yaml/pipeline-document.ts',
    'src/services/process-yaml/workflow-document.ts',
    'src/services/process-yaml/package-reader.ts',
    'src/services/process-yaml/package-resolver.ts',
    'src/services/process-yaml/import-planner.ts',
    'src/ui/sidebar/commands/cmd-preflight-process-yaml.ts'
  ] as const;

  function declarations(relativePath: string): string {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '\n')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('carries the expression to the write byte-for-byte', async () => {
    const plan = await planFor({ text: RETRY_PACKAGE });
    const row = rowFor(plan, 'flaky');
    expect(row.outcome).toBe('import');
    if (row.outcome !== 'import') throw new Error('unreachable');
    if (row.resourceKind === 'modelCatalog') throw new Error('unreachable');

    const definition = row.definition as { readonly retryCondition?: string };
    // Not merely equal after trimming, quoting, or whitespace collapse. Identical.
    expect(definition.retryCondition).toBe(RETRY_EXPRESSION);
  });

  it('raises the capability flag from presence alone, whatever the contents', async () => {
    const flagFor = async (retryCondition: string | null): Promise<boolean | undefined> => {
      const plan = await planFor({
        text: packageDocument([
          'metadata:',
          '  id: retryer',
          '  name: Retryer',
          '  version: 1',
          'spec:',
          '  phaseIds:',
          '    - flaky',
          'included:',
          '  phases:',
          '    - metadata:',
          '        phaseId: flaky',
          '        name: Flaky',
          '        version: 1',
          '      spec:',
          '        instruction: Try again.',
          ...(retryCondition === null ? [] : [`        retryCondition: ${retryCondition}`])
        ])
      });
      const row = rowFor(plan, 'flaky');
      // The flag is a Phase-row field and only a Phase-row field — a Pipeline or
      // Workflow row has no `retryCondition` to gate — so the narrowing is on
      // the kind as well as the outcome, not a cast past it.
      if (row.outcome !== 'import' || row.resourceKind !== 'phase') {
        throw new Error('unreachable');
      }
      return row.requiresRetryConditionCapability;
    };

    // A well-formed expression, a nonsense one, and one that is only the word
    // `false` — all raise it, because the gate is keyed on the field existing.
    // `false` is the interesting case: an implementation that evaluated the
    // expression could conclude the retry never fires and drop the gate.
    expect(await flagFor('exitCode != 0')).toBe(true);
    expect(await flagFor(RETRY_EXPRESSION)).toBe(true);
    expect(await flagFor('false')).toBe(true);
    // Absent is the only thing that lowers it.
    expect(await flagFor(null)).toBe(false);
  });

  it('refuses an empty expression on presence-and-non-emptiness alone', async () => {
    // The only two things this path is allowed to know about the field. The defect
    // names non-emptiness, not a grammar — no parse was attempted to produce it.
    const plan = await planFor({
      text: packageDocument([
        'metadata:',
        '  id: retryer',
        '  name: Retryer',
        '  version: 1',
        'spec:',
        '  phaseIds:',
        '    - flaky',
        'included:',
        '  phases:',
        '    - metadata:',
        '        phaseId: flaky',
        '        name: Flaky',
        '        version: 1',
        '      spec:',
        '        instruction: Try again.',
        '        retryCondition: "   "'
      ])
    });

    const invalid = plan.rows.filter((row) => row.outcome === 'invalid');
    expect(invalid).toHaveLength(1);
    const defects = (invalid[0] as { readonly defects: readonly { readonly field: string; readonly code: string }[] })
      .defects;
    expect(defects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'retryCondition', code: 'non-empty-required' })
      ])
    );
  });

  for (const source of EXCHANGE_PATH) {
    it(`${source} never reaches the DSL evaluator`, () => {
      const text = declarations(source);
      expect(text.length).toBeGreaterThan(100);
      // The evaluator, its module, and the shapes a hand-rolled second copy would
      // take. `retryCondition` itself may of course be named — carrying a field
      // requires naming it; what must not appear is anything that reads it.
      for (const construct of [
        'retry-condition',
        'evaluateRetryCondition',
        'parseRetryCondition',
        'normalizeRetryCondition',
        'compileRetryCondition'
      ]) {
        expect(text).not.toContain(construct);
      }
    });
  }

  it('detects a reach into the evaluator if one were introduced', () => {
    // Negative control: without it, a typo above would make every scan vacuous.
    const planted = "import { evaluateRetryCondition } from '../../lib/retry-condition';";
    expect(planted).toContain('evaluateRetryCondition');
    expect(planted).toContain('retry-condition');
  });
});

describe('Feature 086 T051 — importing infers no execution behavior (FR-053)', () => {
  // A package describes a graph. It does not describe a run, and reading one must
  // not start, schedule, queue, or pre-resolve anything — the operator imports a
  // definition and decides separately whether to run it.

  const RUNNABLE_PACKAGE = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    '  id: ship-it-flow',
    '  name: Ship It Flow',
    '  version: 1',
    'spec:',
    '  nodes:',
    '    - nodeId: draft',
    '      pipelineId: spec-authoring',
    '  startNodeIds:',
    '    - draft',
    'included:',
    '  pipelines:',
    '    - metadata:',
    '        id: spec-authoring',
    '        name: Spec Authoring',
    '        version: 1',
    '      spec:',
    '        phaseIds:',
    '          - specify',
    '  phases:',
    '    - metadata:',
    '        phaseId: specify',
    '        name: Specify',
    '        version: 1',
    '      spec:',
    '        instruction: Write the spec.',
    ''
  ].join('\n');

  /** Fields and calls that would mean a run had been inferred. */
  const EXECUTION = [
    'WorkflowRun',
    'enqueue',
    'queueRemover',
    'startRun',
    'scheduledStartAt',
    'idle-pending',
    'AutoDrainCoordinator',
    'runner',
    'spawn',
    'execFile'
  ] as const;

  function declarations(relativePath: string): string {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '\n')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('produces a plan carrying no run, status, or schedule for any node', async () => {
    const plan = await planFor({ text: RUNNABLE_PACKAGE });
    expect(plan.counts).toEqual({ import: 3, skip: 0, blocked: 0, invalid: 0 });

    // Structural rather than field-by-field: any execution-shaped key anywhere in
    // the plan, at any depth, fails — including inside a carried definition.
    const serialized = JSON.stringify(plan);
    for (const construct of ['WorkflowRun', 'scheduledStartAt', 'queueLifecycle', 'runId', 'startedAt']) {
      expect(serialized).not.toContain(construct);
    }
    // `startNodeIds` is authored graph data and is expected to survive; it says
    // where a run WOULD begin, not that one has.
    expect(serialized).toContain('startNodeIds');
  });

  for (const source of [
    'src/services/process-yaml/workflow-document.ts',
    'src/services/process-yaml/package-reader.ts',
    'src/services/process-yaml/package-resolver.ts',
    'src/services/process-yaml/import-planner.ts'
  ] as const) {
    it(`${source} names no execution primitive`, () => {
      const text = declarations(source);
      expect(text.length).toBeGreaterThan(100);
      expect(EXECUTION.filter((construct) => text.includes(construct))).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Feature 086 — FR-024, FR-059, FR-060, SC-019
// ---------------------------------------------------------------------------

// Feature 086 T070 — what a Workflow document is allowed to contain, in both
// directions.
//
// A Workflow package is the widest payload this feature produces: three catalog
// levels in one file, exported from live installation state and read back into
// another one. So it is the strongest place to state the containment property —
// the document carries the DEFINITION and nothing else. No session data, no run
// history, no secret or credential, no host-owned policy, no trust decision, and
// no filesystem location (FR-024, FR-060, SC-019); nothing in it becomes code;
// and no step of the path reaches the network (FR-059).
//
// The primary assertion is a WHITELIST, not a denylist. A denylist of leak-shaped
// names can only catch the leaks someone thought of, and the widest of the three
// kinds is exactly where an unimagined one would land. Pinning the document's key
// vocabulary to the schema's own keys makes every absence above follow by
// construction: a session id cannot appear under a name nobody predicted, because
// no name outside the schema may appear at all. The denylist below it is a second
// opinion over the VALUES, where a whitelist has nothing to say.
describe('Feature 086 T070 — a Workflow document carries the definition and nothing else', () => {
  const HYGIENE_PHASES = Object.freeze([
    { phaseId: 'draft', name: 'Draft', version: 1, instruction: 'Run Draft.' },
    { phaseId: 'review', name: 'Review', version: 1, instruction: 'Run Review.' }
  ]);

  const HYGIENE_PIPELINES = Object.freeze([
    {
      pipelineId: 'spec-authoring',
      name: 'Spec Authoring',
      version: 1,
      phaseIds: Object.freeze(['draft']),
      inputs: Object.freeze([{ portId: 'brief', label: 'Brief', type: 'text' }]),
      outputs: Object.freeze([{ portId: 'spec-document', label: 'Spec', type: 'markdown' }]),
      bindings: Object.freeze([]),
      recommendedNext: Object.freeze([])
    },
    {
      pipelineId: 'spec-review',
      name: 'Spec Review',
      version: 1,
      phaseIds: Object.freeze(['review']),
      inputs: Object.freeze([{ portId: 'spec', label: 'Spec', type: 'text' }]),
      outputs: Object.freeze([{ portId: 'verdict', label: 'Verdict', type: 'markdown' }]),
      bindings: Object.freeze([]),
      recommendedNext: Object.freeze([])
    }
  ]);

  /** Every optional a Workflow has, so the widest document is the one under test. */
  const HYGIENE_WORKFLOW = Object.freeze({
    workflowId: 'ship-it-flow',
    name: 'Ship It Flow',
    description: 'Draft, then review.',
    version: 4,
    nodes: Object.freeze([
      { nodeId: 'draft', pipelineId: 'spec-authoring', label: 'Draft the spec' },
      { nodeId: 'review', pipelineId: 'spec-review' }
    ]),
    connections: Object.freeze([
      {
        from: { nodeId: 'draft', portId: 'spec-document' },
        to: { nodeId: 'review', portId: 'spec' },
        condition: {
          left: { source: 'node-status', nodeId: 'draft' },
          operator: 'in',
          right: Object.freeze(['completed', 'failed'])
        },
        priority: 10,
        isDefault: false
      }
    ]),
    startNodeIds: Object.freeze(['draft'])
  });

  /**
   * The schema's own vocabulary, read from the serializer that declares it rather
   * than restated here. `yaml-serializer.ts` exports one `*_KEY_ORDER` per mapping
   * the three kinds admit, and those orders ARE the schema — a hand-copied list
   * beside them would drift, and drift in the direction that makes this scan pass.
   *
   * The set widening when a `*_KEY_ORDER` gains a key is correct: adding one is a
   * deliberate edit to the emitted format, gated by the round-trip suites and the
   * grammar freeze. What must not be possible is a key reaching the document
   * WITHOUT such an edit, and that is what the subset check below rejects. The
   * companion test then runs the leak denylist over these names too, so widening
   * the schema cannot be the way a leak becomes legal.
   */
  const SCHEMA_KEYS: ReadonlySet<string> = new Set<string>(
    Object.entries(SERIALIZER)
      .filter(([name]) => name.endsWith('_KEY_ORDER'))
      .flatMap(([, order]) => order as readonly string[])
  );

  /**
   * Value-shaped leaks, which a key whitelist cannot see. Matched
   * case-insensitively as substrings against the whole document, so
   * `SESSION_ID`, `sessionId`, and `session-id` are all caught.
   */
  const LEAK_WORDS = [
    // Session and run history.
    'session',
    'runid',
    'transcript',
    'startedat',
    'completedat',
    'lastrun',
    'occurredat',
    // Secrets and credentials.
    'token',
    'apikey',
    'api_key',
    'secret',
    'password',
    'credential',
    'authorization',
    'bearer',
    'sk-ant',
    // Host-owned policy and trust state.
    'trust',
    'permission',
    'allowedtools',
    'dangerously',
    'settings',
    'schegent.',
    // Filesystem location.
    'path',
    'fspath',
    'workspacefolder',
    'workspaceroot',
    'directory',
    'dirname',
    'filename',
    '://',
    '/users/'
  ] as const;

  /** Constructs that would mean the document had become code somewhere. */
  const CODE_CONSTRUCTS = [
    'function',
    '=>',
    'require(',
    'eval(',
    'new Function',
    '${',
    '<script',
    '{@html',
    'process.env'
  ] as const;

  interface ExportRun {
    readonly text: string;
    readonly fetchCalls: number;
  }

  /** The closure mode: the Workflow, its Pipelines, and their Phases in one file. */
  async function exportClosure(): Promise<ExportRun> {
    const acks: CommandAckMessage[] = [];
    const saved: string[] = [];
    let fetchCalls = 0;
    vi.stubGlobal('fetch', (...args: readonly unknown[]) => {
      fetchCalls += 1;
      throw new Error(`network reached: ${String(args[0])}`);
    });

    const ctx = {
      deps: {
        readWorkflowConfig: () => ({ rows: [HYGIENE_WORKFLOW], revision: STORE_REVISION }),
        readPipelineConfig: () => ({ rows: HYGIENE_PIPELINES, revision: STORE_REVISION }),
        readPhaseConfig: () => ({ rows: HYGIENE_PHASES, revision: STORE_REVISION }),
        saveProcessYamlDocument: async (request: { readonly text: string }) => {
          saved.push(request.text);
          return { outcome: 'saved' as const };
        },
        audit: { append: async () => undefined },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          sanitize: (value: string) => value
        }
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
    } as any;

    const command: ExportProcessYamlCommand = {
      type: CMD_EXPORT_PROCESS_YAML,
      correlationId: CORRELATION,
      payload: {
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        inclusion: 'include-closure'
      }
    };
    await exportHandler(ctx, command);
    expect(acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(saved).toHaveLength(1);
    return { text: saved[0]!, fetchCalls };
  }

  /** Every key the document writes, including the first key of a sequence item. */
  function documentKeys(text: string): readonly string[] {
    return [...text.matchAll(/^ *(?:- )?([A-Za-z][\w-]*):/gm)].map((match) => match[1]!);
  }

  it('writes no key outside the schema, at any depth (FR-024, FR-060, SC-019)', async () => {
    const { text } = await exportClosure();
    const keys = [...new Set(documentKeys(text))].sort();

    // Vacuity guard, on both halves: the extraction must reach all three levels,
    // and the derived vocabulary must have found the serializer's orders. Either
    // one empty would satisfy the subset check trivially.
    expect(keys).toContain('nodes');
    expect(keys).toContain('pipelines');
    expect(keys).toContain('instruction');
    expect(keys.length).toBeGreaterThan(15);
    expect(SCHEMA_KEYS.size).toBeGreaterThan(keys.length);

    expect(keys.filter((key) => !SCHEMA_KEYS.has(key))).toEqual([]);
  });

  it('detects an out-of-schema key if one were written', () => {
    // The negative control for the whitelist. A leak would arrive as a key like
    // this, and the point of the whitelist is that it does not need to have been
    // predicted by name.
    const planted = ['spec:', '  nodes:', '    - nodeId: draft', '      sessionId: abc123'].join(
      '\n'
    );
    expect(documentKeys(planted).filter((key) => !SCHEMA_KEYS.has(key))).toEqual(['sessionId']);
  });

  it('declares no leak-shaped key in the schema itself (FR-060, SC-019)', () => {
    // The whitelist above widens with the serializer, so the denylist runs over the
    // serializer's names as well. Widening the schema is then not a way to make a
    // session id or a path legal — it fails here instead.
    const offenders = [...SCHEMA_KEYS]
      .map((key) => key.toLowerCase())
      .filter((key) => LEAK_WORDS.some((word) => key.includes(word)));
    expect(offenders).toEqual([]);
  });

  it('leaks nothing through a value either (FR-024, FR-060)', async () => {
    const { text } = await exportClosure();
    const haystack = text.toLowerCase();
    expect(LEAK_WORDS.filter((word) => haystack.includes(word))).toEqual([]);
    // And the one installation-state value this path is handed by name. The list
    // above is a denylist of words someone thought of; the store revision is a
    // value the export reads on every run, so it is stated rather than left to a
    // word list that has no reason to contain it.
    expect(haystack).not.toContain(STORE_REVISION);
  });

  it('transports no executable extension code (FR-060)', async () => {
    const { text } = await exportClosure();
    expect(CODE_CONSTRUCTS.filter((construct) => text.includes(construct))).toEqual([]);
    // The negative control, so a typo in the list cannot make the scan vacuous.
    const planted = '        instruction: ${process.env.HOME}';
    expect(CODE_CONSTRUCTS.filter((construct) => planted.includes(construct))).toEqual([
      '${',
      'process.env'
    ]);
  });

  it('carries none of it back on the import side either (FR-024, SC-019)', async () => {
    // Same document, now read as untrusted input. The plan is what crosses to the
    // webview and what the commit writes, so the containment claim has to hold on
    // the payload and not only on the file.
    const { text } = await exportClosure();
    const plan = await planFor({ text });
    expect(plan.counts).toEqual({ import: 5, skip: 0, blocked: 0, invalid: 0 });

    const haystack = JSON.stringify(plan).toLowerCase();
    expect(LEAK_WORDS.filter((word) => haystack.includes(word))).toEqual([]);
    // `requiresRetryConditionCapability` is a request for the operator's consent,
    // not a record of it: the plan asks, and the trust decision stays host-side.
    // Asserted so the absence of every trust word above is not read as the flag
    // having gone missing.
    expect(haystack).toContain('requiresretryconditioncapability');
  });

  it('reaches the network on neither half of the path (FR-059)', async () => {
    // The static scan over `PATH_MODULES` above is a denylist of names; this is
    // the behavior, and it covers the export direction the earlier behavioral
    // check did not.
    const exported = await exportClosure();
    expect(exported.fetchCalls).toBe(0);

    const imported = await preflight({ text: exported.text });
    expect(imported.result.outcome).toBe('planned');
    expect(imported.fetchCalls).toBe(0);
  });
});
