// FR-R4-F15 (spec 243, contract L4; hard rule 66; FR-002, FR-009) — no queue decision can read a
// failure record.
//
// A failure record is diagnostic content for an operator to read. It holds the agent's own words and
// its own labels for them, and the spec is explicit that none of it may steer anything: not a halt, not
// a counter, not the cap, not a Run's or a row's status, not what the next iteration is told. Hard rule
// 66 forbids a stored halt and a second site deciding one. The cheapest way to keep that true is to
// keep the record out of every module that decides, and the one place that can be checked mechanically
// is the import graph: a module that cannot import the record cannot read it.
//
// WHAT IS SCANNED. Every non-test `.ts` file under `src/`, with comments removed, for a relative
// import, re-export, `require` or dynamic `import()` whose target is the record's service directory
// (`src/services/failure-record/`) or its shape module (`src/contracts/failure-record`). Type-only
// imports count: the allowed list below names what each importer may use the record for.
//
// WHAT IS ALLOWED. The modules of the service itself, the contract-side validator and wire types that
// are the record's own, the driver and the start-failure handler (to hand a failure to `record()`), the
// controller and the wiring files (to build it), the retention service (the pass), and the handler and
// router types that carry the read request. Anything else is a violation, and the five areas the spec
// names are called out by name in the failure message.
//
// NON-VACUITY. "No violation found" is exactly what an empty scan reports, so the gate is driven red by
// a fixture in which a queue module imports the answer module, and it asserts the real scan saw the
// importers it is about.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';

import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT = 'contract L4 (specs/243-retained-failure-diagnostics/contracts/docs-and-gates.md)';

/** A module that imports one of the record's modules, as `src/...` with forward slashes. */
const SERVICE_DIR = 'src/services/failure-record/';
const SHAPE_MODULE = 'src/contracts/failure-record.ts'.replace(/\.ts$/, '');

/** L4.1 — the files allowed to import the record, as exact paths or `*`-ended prefixes. */
const ALLOWED_IMPORTERS: ReadonlyArray<RegExp> = [
  /^src\/services\/failure-record\/[^/]+\.ts$/,
  /^src\/contracts\/sidebar-ipc\/failure-record\.ts$/,
  /^src\/contracts\/validators\/failure-record\.ts$/,
  /^src\/services\/run-driver\.ts$/,
  /^src\/controller\/unexpected-start-failure\.ts$/,
  /^src\/controller\/workflow-controller\.ts$/,
  /^src\/activation\/[^/]*-wiring\.ts$/,
  /^src\/services\/session-retention\/session-artifact-retention-service\.ts$/,
  /^src\/ui\/sidebar\/commands\/cmd-read-failure-record\.ts$/,
  /^src\/ui\/sidebar\/commands\/router-types\.ts$/
];

/** L4.2 — the places a decision is made. A violation here is named as such. */
const DECISION_SITES: ReadonlyArray<{ readonly match: RegExp; readonly name: string }> = [
  { match: /^src\/queue\//, name: 'src/queue/' },
  { match: /^src\/controller\/phase[^/]*\.ts$/, name: 'src/controller/phase*.ts' },
  { match: /^src\/controller\/fail-decision-cause\.ts$/, name: 'src/controller/fail-decision-cause.ts' },
  { match: /^src\/services\/auto-drain-coordinator\.ts$/, name: 'src/services/auto-drain-coordinator.ts' },
  { match: /^src\/metrics\//, name: 'src/metrics/' }
];

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

interface Violation {
  readonly file: string;
  readonly target: string;
  readonly message: string;
}

/** Comments removed, so an import named in prose is not an import. Strings are not parsed: imports are literal. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');
}

/** Every relative module specifier the file imports, re-exports, requires or loads dynamically. */
function relativeSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match.at(1);
      if (specifier !== undefined && specifier.startsWith('.')) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function targetOf(file: string, specifier: string): string | null {
  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.(?:js|ts)$/, '');
  if (resolved.startsWith(SERVICE_DIR) || resolved === SERVICE_DIR.slice(0, -1)) return resolved;
  if (resolved === SHAPE_MODULE) return resolved;
  return null;
}

/** L4.1, L4.2 — every import of the record by a file that is not allowed one. */
function findViolations(sources: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, text } of sources) {
    for (const specifier of relativeSpecifiers(stripComments(text))) {
      const target = targetOf(file, specifier);
      if (target === null || ALLOWED_IMPORTERS.some((allowed) => allowed.test(file))) continue;
      const site = DECISION_SITES.find((candidate) => candidate.match.test(file));
      violations.push({
        file,
        target,
        message:
          site === undefined
            ? `${file} imports ${target}, and is not one of the importers ${CONTRACT} allows`
            : `${file} imports ${target}; ${site.name} decides, and no decision may read a failure record (${CONTRACT})`
      });
    }
  }
  return violations;
}

/** The importers of the record as the scan sees them, with who they are. */
function importersOf(sources: readonly SourceFile[]): string[] {
  return sources
    .filter(({ file, text }) => relativeSpecifiers(stripComments(text)).some((specifier) => targetOf(file, specifier) !== null))
    .map(({ file }) => file)
    .sort();
}

function productionSources(): SourceFile[] {
  return filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] })
    .map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'))
    .filter((file) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(file) && !file.includes('/__tests__/') && !file.endsWith('.d.ts'))
    .map((file) => ({ file, text: readFileSync(resolve(REPO_ROOT, file), 'utf8') }));
}

describe('FR-R4-F15 L4 — no queue decision imports a failure record', () => {
  const sources = productionSources();

  it('control: the scan walked the tree and found the importers it is about', () => {
    expect(sources.length).toBeGreaterThan(300);
    const importers = importersOf(sources);
    expect(importers).toContain('src/services/run-driver.ts');
    expect(importers).toContain('src/controller/workflow-controller.ts');
    expect(importers).toContain('src/controller/unexpected-start-failure.ts');
    expect(importers).toContain('src/services/failure-record/record-builder.ts');
    expect(importers.length).toBeGreaterThanOrEqual(8);
  });

  it('every importer of the record is one L4.1 allows, and none is a decision site', () => {
    const violations = findViolations(sources);
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });

  it('control: no file in the five decision areas is among the importers', () => {
    const importers = importersOf(sources);
    for (const site of DECISION_SITES) {
      expect(importers.filter((file) => site.match.test(file)), site.name).toEqual([]);
    }
    // The decision files named by the spec exist, so an absent importer is not an absent file.
    for (const file of ['src/controller/fail-decision-cause.ts', 'src/services/auto-drain-coordinator.ts']) {
      expect(sources.map((source) => source.file)).toContain(file);
    }
  });
});

describe('the scan can fail (non-vacuity control, L4.3)', () => {
  it('reports a queue module that imports the answer module, naming the file and contract L4', () => {
    const planted: SourceFile = {
      file: 'src/queue/queue-manager.ts',
      text: "import { decideFailureRecordAnswer } from '../services/failure-record/failure-record-answer';\n"
    };
    const found = findViolations([planted]);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('src/queue/queue-manager.ts');
    expect(found[0]?.message).toContain('src/queue/queue-manager.ts');
    expect(found[0]?.message).toContain('contract L4');
    expect(found[0]?.message).toContain('src/queue/');
  });

  it('reports each of the five decision areas, and a module nobody listed', () => {
    const plant = (file: string, specifier: string): SourceFile => ({ file, text: `import type { T } from '${specifier}';` });
    const found = findViolations([
      plant('src/controller/phase-sequencer.ts', '../contracts/failure-record'),
      plant('src/controller/phase.ts', '../services/failure-record/record-builder'),
      plant('src/controller/fail-decision-cause.ts', '../contracts/failure-record'),
      plant('src/services/auto-drain-coordinator.ts', './failure-record/failure-record-store'),
      plant('src/metrics/metrics-rollup.ts', '../services/failure-record/failure-record-answer'),
      plant('src/services/history-recorder.ts', './failure-record/record-text')
    ]);
    expect(found.map((violation) => violation.file)).toEqual([
      'src/controller/phase-sequencer.ts',
      'src/controller/phase.ts',
      'src/controller/fail-decision-cause.ts',
      'src/services/auto-drain-coordinator.ts',
      'src/metrics/metrics-rollup.ts',
      'src/services/history-recorder.ts'
    ]);
    expect(found.filter((violation) => violation.message.includes('decides'))).toHaveLength(5);
    expect(found[5]?.message).toContain('not one of the importers');
  });

  it('sees a re-export, a bare side-effect import, a require and a dynamic import', () => {
    const text = [
      "export { buildFailureRecord } from '../services/failure-record/record-builder';",
      "import '../services/failure-record/record-text';",
      "const a = require('../services/failure-record/failure-record-store');",
      "const b = await import('../contracts/failure-record');"
    ].join('\n');
    expect(findViolations([{ file: 'src/queue/queue-halt-policy.ts', text }])).toHaveLength(4);
  });

  it('ignores an import that is only named in a comment', () => {
    const text = [
      "// import { x } from '../services/failure-record/record-builder';",
      "/* import { y } from '../contracts/failure-record'; */",
      '/**',
      " * See ../services/failure-record/failure-record-answer.",
      ' */',
      'export const z = 1;'
    ].join('\n');
    expect(findViolations([{ file: 'src/queue/task-transition-decision.ts', text }])).toEqual([]);
  });

  it('allows the importers L4.1 names, including a type-only import', () => {
    const allowed: SourceFile[] = [
      { file: 'src/services/run-driver.ts', text: "import type { FailureRecorder } from './failure-record/failure-record-service';" },
      { file: 'src/controller/workflow-controller.ts', text: "import { createFailureRecorder } from '../services/failure-record/failure-record-service';" },
      { file: 'src/activation/evidence-wiring.ts', text: "import { sweepFailureRecords } from '../services/failure-record/failure-record-retention';" },
      { file: 'src/contracts/validators/failure-record.ts', text: "import { FAILURE_RECORD_NAME } from '../failure-record';" },
      { file: 'src/services/failure-record/record-builder.ts', text: "import { boundSummary } from './record-text';" }
    ];
    expect(findViolations(allowed)).toEqual([]);
  });

  it('does not mistake a sibling path for the record', () => {
    const text = "import { x } from '../services/failure-notice';\nimport { y } from '../contracts/failure-cause';";
    expect(findViolations([{ file: 'src/queue/queue-registry.ts', text }])).toEqual([]);
  });
});
