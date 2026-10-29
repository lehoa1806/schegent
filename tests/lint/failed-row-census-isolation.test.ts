// FR-R4-F16 (spec 244, contract L3; hard rules 66 and 67; FR-017) — no queue decision can read the
// failed-row census, and no file outside a named list can read `completionProvenance`.
//
// The census reports how failed rows were resolved. It is evidence for a person's decision, and it must
// never steer one: not a halt, not a counter, not a row's status, not what a queue starts next. Hard
// rule 66 forbids a stored halt and a second site deciding one. The cheapest way to keep that true is to
// keep the census out of every module that decides, and the field it reads (`completionProvenance`) out
// of every module that is not on a short list. Both are checkable mechanically: a module that cannot
// import the census cannot read it, and a module that is not named here cannot name the field.
//
// TWO HALVES.
//   L3.1 IMPORTERS. Every non-test `.ts` file under `src/`, with comments removed, is scanned for an
//   import, re-export, `require` or dynamic `import()` of `src/services/failed-row-census/`. Type-only
//   imports count. Two importers are allowed: the census's own modules and
//   `src/commands/report-failed-row-exits.ts`. That command module is in turn imported only by
//   `src/activation/ui-wiring.ts`. A violation in a decision area is named as a decision site.
//   L3.2 READERS OF THE FIELD. Every non-test `.ts` file under `src/` (`src/contracts/generated/`
//   excluded) whose text names the identifier `completionProvenance` has exactly one role in the table
//   below. Comments are read as well as code, because a search for a name must (hard rule 67), and the
//   search is for the identifier, never for the value `'operator-attested'`: the value is a string any
//   file may write, and a rule that matched it would be a rule about spelling.
//
// NON-VACUITY. "No violation found" is exactly what an empty scan reports. Each half is driven red by a
// fixture, and the real scan must find at least five files in L3.2 and every classified file still
// naming the identifier, so a rename cannot empty the scan into a pass.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';

import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT = 'contract L3 (specs/244-failed-row-exit-evidence/contracts/docs-and-gates.md)';

const CENSUS_DIR = 'src/services/failed-row-census/';
const COMMAND_MODULE = 'src/commands/report-failed-row-exits.ts'.replace(/\.ts$/, '');
const FIELD = /\bcompletionProvenance\b/;

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

interface Violation {
  readonly file: string;
  readonly message: string;
}

/** L3.1 — the places a decision is made. A violation here is named as such. */
const DECISION_SITES: ReadonlyArray<{ readonly match: RegExp; readonly name: string }> = [
  { match: /^src\/queue\//, name: 'src/queue/' },
  { match: /^src\/controller\/phase[^/]*\.ts$/, name: 'src/controller/phase*.ts' },
  { match: /^src\/controller\/fail-decision-cause\.ts$/, name: 'src/controller/fail-decision-cause.ts' },
  { match: /^src\/services\/auto-drain-coordinator\.ts$/, name: 'src/services/auto-drain-coordinator.ts' },
  { match: /^src\/metrics\//, name: 'src/metrics/' },
  { match: /^src\/audit\//, name: 'src/audit/' }
];

/** L3.1 — the files allowed to import the census, and the files allowed to import the command module. */
const ALLOWED_CENSUS_IMPORTERS: ReadonlyArray<RegExp> = [
  /^src\/services\/failed-row-census\/[^/]+\.ts$/,
  /^src\/commands\/report-failed-row-exits\.ts$/
];
const ALLOWED_COMMAND_IMPORTERS: ReadonlyArray<RegExp> = [/^src\/activation\/ui-wiring\.ts$/];

/** L3.2 — every file that names the identifier has exactly one of these roles. */
const FIELD_ROLES: ReadonlyArray<{ readonly role: string; readonly match: RegExp }> = [
  { role: 'declaration', match: /^src\/queue\/feature-request\.ts$/ },
  { role: 'attest writer and removal carrier', match: /^src\/queue\/queue-manager\.ts$/ },
  {
    role: 'removal carrier',
    match: /^src\/(?:controller\/task-deletion|ui\/sidebar\/commands\/(?:router-types|cmd-remove-queue-item))\.ts$/
  },
  { role: 'projection', match: /^src\/audit\/audit-payload\.ts$/ },
  { role: 'contract', match: /^src\/contracts\/audit-events\.ts$/ },
  { role: 'vocabulary', match: /^src\/contracts\/completion-provenance\.ts$/ },
  { role: 'census', match: /^src\/services\/failed-row-census\/[^/]+\.ts$/ }
];

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

function resolvedTarget(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.(?:js|ts)$/, '');
}

const isCensusTarget = (target: string): boolean =>
  target.startsWith(CENSUS_DIR) || target === CENSUS_DIR.slice(0, -1);

function siteOf(file: string): string | undefined {
  return DECISION_SITES.find((candidate) => candidate.match.test(file))?.name;
}

/** L3.1 — every import of the census, or of its command module, by a file that is not allowed one. */
function findImporterViolations(sources: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, text } of sources) {
    for (const specifier of relativeSpecifiers(stripComments(text))) {
      const target = resolvedTarget(file, specifier);
      const isCensus = isCensusTarget(target);
      const isCommand = target === COMMAND_MODULE;
      if (!isCensus && !isCommand) continue;
      const allowed = isCensus ? ALLOWED_CENSUS_IMPORTERS : ALLOWED_COMMAND_IMPORTERS;
      if (allowed.some((pattern) => pattern.test(file))) continue;
      const site = siteOf(file);
      violations.push({
        file,
        message:
          site === undefined
            ? `${file} imports ${target}, and is not one of the importers ${CONTRACT} allows`
            : `${file} imports ${target}; ${site} decides, and no decision may read the failed-row census (${CONTRACT})`
      });
    }
  }
  return violations;
}

/** The importers of the census as the scan sees them. */
function censusImportersOf(sources: readonly SourceFile[]): string[] {
  return sources
    .filter(({ file, text }) =>
      relativeSpecifiers(stripComments(text)).some((specifier) => isCensusTarget(resolvedTarget(file, specifier)))
    )
    .map(({ file }) => file)
    .sort();
}

/** The files that name the identifier. Comments are read: a search for a name must be. */
function filesNamingField(sources: readonly SourceFile[]): string[] {
  return sources.filter(({ text }) => FIELD.test(text)).map(({ file }) => file).sort();
}

function roleOf(file: string): string | undefined {
  return FIELD_ROLES.find((candidate) => candidate.match.test(file))?.role;
}

/** L3.2 — every file that names the field and has no role. */
function findFieldViolations(sources: readonly SourceFile[]): Violation[] {
  return sources
    .filter(({ file, text }) => FIELD.test(text) && roleOf(file) === undefined)
    .map(({ file }) => ({
      file,
      message: `${file} names completionProvenance and has no role in ${CONTRACT}; no queue decision may read the field`
    }));
}

function productionSources(): SourceFile[] {
  return filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] })
    .map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'))
    .filter(
      (file) =>
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(file) &&
        !file.includes('/__tests__/') &&
        !file.endsWith('.d.ts') &&
        !file.startsWith('src/contracts/generated/')
    )
    .map((file) => ({ file, text: readFileSync(resolve(REPO_ROOT, file), 'utf8') }));
}

describe('FR-R4-F16 L3 — no queue decision imports the failed-row census, and only named files read completionProvenance', () => {
  const sources = productionSources();

  describe('L3.1 — no decision imports the census', () => {

    it('control: the scan walked the tree and found the importers it is about', () => {
      expect(sources.length).toBeGreaterThan(300);
      const importers = censusImportersOf(sources);
      expect(importers).toContain('src/commands/report-failed-row-exits.ts');
      expect(importers).toContain('src/services/failed-row-census/failed-row-census.ts');
      expect(importers).toContain('src/services/failed-row-census/census-report.ts');
      expect(importers.length).toBeGreaterThanOrEqual(5);
    });

    it('every importer of the census is the census itself or its command, and none is a decision site', () => {
      const violations = findImporterViolations(sources);
      expect(violations.map((violation) => violation.message)).toEqual([]);
    });

    it('the command module is imported only by ui-wiring', () => {
      const importers = sources
        .filter(({ file, text }) =>
          relativeSpecifiers(stripComments(text)).some((specifier) => resolvedTarget(file, specifier) === COMMAND_MODULE)
        )
        .map(({ file }) => file);
      expect(importers).toEqual(['src/activation/ui-wiring.ts']);
    });

    it('control: no file in the decision areas is among the importers', () => {
      const importers = censusImportersOf(sources);
      for (const site of DECISION_SITES) {
        expect(importers.filter((file) => site.match.test(file)), site.name).toEqual([]);
      }
      // The decision files named by the contract exist, so an absent importer is not an absent file.
      for (const file of ['src/controller/fail-decision-cause.ts', 'src/services/auto-drain-coordinator.ts']) {
        expect(sources.map((source) => source.file)).toContain(file);
      }
    });
  });

  describe('L3.2 — the readers of completionProvenance are named', () => {
    const naming = filesNamingField(sources);

    it('control: the scan finds at least five files that name the identifier', () => {
      expect(naming.length).toBeGreaterThanOrEqual(5);
    });

    it('every file that names the identifier has a role, and none is a decision site', () => {
      const violations = findFieldViolations(sources);
      expect(violations.map((violation) => violation.message)).toEqual([]);
    });

    it('every classified file still names the identifier, so a rename cannot empty the scan into a pass', () => {
      const exact = [
        'src/queue/feature-request.ts',
        'src/queue/queue-manager.ts',
        'src/controller/task-deletion.ts',
        'src/ui/sidebar/commands/router-types.ts',
        'src/ui/sidebar/commands/cmd-remove-queue-item.ts',
        'src/audit/audit-payload.ts',
        'src/contracts/audit-events.ts',
        'src/contracts/completion-provenance.ts'
      ];
      for (const file of exact) {
        expect(roleOf(file), `${file} has a role`).toBeDefined();
        expect(naming, `${file} names the identifier`).toContain(file);
      }
      expect(naming.filter((file) => roleOf(file) === 'census').length).toBeGreaterThanOrEqual(1);
    });

    it('no decision area names the identifier', () => {
      for (const site of DECISION_SITES.filter((candidate) => candidate.name !== 'src/queue/' && candidate.name !== 'src/audit/')) {
        expect(naming.filter((file) => site.match.test(file)), site.name).toEqual([]);
      }
      // `src/queue/` holds the declaration and the writer; nothing else there may name it.
      expect(naming.filter((file) => file.startsWith('src/queue/'))).toEqual([
        'src/queue/feature-request.ts',
        'src/queue/queue-manager.ts'
      ]);
    });

    it('reads comments as well as code: a name that appears only in a comment is still a reader', () => {
      const commentOnly: SourceFile = {
        file: 'src/services/auto-drain-coordinator.ts',
        text: '// does not read completionProvenance\nexport const x = 1;\n'
      };
      expect(findFieldViolations([commentOnly])).toHaveLength(1);
    });

    it('searches the identifier and never the value', () => {
      const valueOnly: SourceFile = {
        file: 'src/services/auto-drain-coordinator.ts',
        text: "export const label = 'operator-attested';\n"
      };
      expect(findFieldViolations([valueOnly])).toEqual([]);
    });

    it('does not mistake a sibling name for the field', () => {
      const sibling: SourceFile = {
        file: 'src/services/auto-drain-coordinator.ts',
        text: 'import { isCompletionProvenance } from "../contracts/completion-provenance";\nconst COMPLETION_PROVENANCES = [];\n'
      };
      expect(findFieldViolations([sibling])).toEqual([]);
    });
  });
});

describe('the importer scan reads imports as the language writes them (L3.3)', () => {
  it('sees a re-export, a bare side-effect import, a require and a dynamic import', () => {
    const text = [
      "export { runFailedRowCensus } from '../services/failed-row-census/failed-row-census';",
      "import '../services/failed-row-census/census-report';",
      "const a = require('../services/failed-row-census/census-snapshot');",
      "const b = await import('../services/failed-row-census/census-log');"
    ].join('\n');
    expect(findImporterViolations([{ file: 'src/queue/queue-halt-policy.ts', text }])).toHaveLength(4);
  });

  it('ignores an import that is only named in a comment', () => {
    const text = [
      "// import { x } from '../services/failed-row-census/census-report';",
      "/* import { y } from '../services/failed-row-census/census-log'; */",
      'export const z = 1;'
    ].join('\n');
    expect(findImporterViolations([{ file: 'src/queue/task-transition-decision.ts', text }])).toEqual([]);
  });

  it('reports each decision area, and a module nobody listed', () => {
    const plant = (file: string, specifier: string): SourceFile => ({
      file,
      text: `import type { T } from '${specifier}';`
    });
    const found = findImporterViolations([
      plant('src/controller/phase-sequencer.ts', '../services/failed-row-census/census-model'),
      plant('src/controller/fail-decision-cause.ts', '../services/failed-row-census/census-model'),
      plant('src/services/auto-drain-coordinator.ts', './failed-row-census/census-model'),
      plant('src/metrics/metrics-rollup.ts', '../services/failed-row-census/census-model'),
      plant('src/audit/audit-payload.ts', '../services/failed-row-census/census-model'),
      plant('src/services/history-recorder.ts', './failed-row-census/census-model')
    ]);
    expect(found.map((violation) => violation.file)).toEqual([
      'src/controller/phase-sequencer.ts',
      'src/controller/fail-decision-cause.ts',
      'src/services/auto-drain-coordinator.ts',
      'src/metrics/metrics-rollup.ts',
      'src/audit/audit-payload.ts',
      'src/services/history-recorder.ts'
    ]);
    expect(found.filter((violation) => violation.message.includes('decides'))).toHaveLength(5);
    expect(found[5]?.message).toContain('not one of the importers');
  });

  it('reports a second importer of the command module', () => {
    const found = findImporterViolations([
      { file: 'src/activation/ui-wiring.ts', text: "import { run } from '../commands/report-failed-row-exits';" },
      { file: 'src/activation/stage2-teardown.ts', text: "import { run } from '../commands/report-failed-row-exits';" }
    ]);
    expect(found.map((violation) => violation.file)).toEqual(['src/activation/stage2-teardown.ts']);
  });

  it('allows the census and its command, including a type-only import', () => {
    const allowed: SourceFile[] = [
      {
        file: 'src/commands/report-failed-row-exits.ts',
        text: "import { runFailedRowCensus } from '../services/failed-row-census/failed-row-census';"
      },
      {
        file: 'src/services/failed-row-census/failed-row-census.ts',
        text: "import type { CensusLog } from './census-model';"
      }
    ];
    expect(findImporterViolations(allowed)).toEqual([]);
  });

  it('does not mistake a sibling path for the census', () => {
    const text = "import { x } from '../services/failure-record/record-builder';";
    expect(findImporterViolations([{ file: 'src/queue/queue-registry.ts', text }])).toEqual([]);
  });
});

describe('the scans can fail (non-vacuity controls, L3.3)', () => {
  it('reports a queue module that imports the census as a decision site, naming the file and contract L3', () => {
    const planted: SourceFile = {
      file: 'src/queue/queue-manager.ts',
      text: "import { runFailedRowCensus } from '../services/failed-row-census/failed-row-census';\n"
    };
    const found = findImporterViolations([planted]);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('src/queue/queue-manager.ts');
    expect(found[0]?.message).toContain('src/queue/queue-manager.ts');
    expect(found[0]?.message).toContain('contract L3');
    expect(found[0]?.message).toContain('src/queue/ decides');
  });

  it('reports a module that names the field and has no role, saying no queue decision may read it', () => {
    const planted: SourceFile = {
      file: 'src/services/auto-drain-coordinator.ts',
      text: 'const attested = row.completionProvenance !== undefined;\n'
    };
    const found = findFieldViolations([planted]);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('src/services/auto-drain-coordinator.ts');
    expect(found[0]?.message).toContain('no queue decision may read the field');
    expect(found[0]?.message).toContain('contract L3');
  });
});
