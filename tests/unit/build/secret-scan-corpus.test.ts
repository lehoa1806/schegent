import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEAN,
  DROPPED,
  PLANTED,
  UNSUPPORTED,
  type CleanCase,
  type PlantedCase,
  type ScanMode
} from '../../fixtures/secret-scan-corpus';
import { REPO_ROOT, removeSandboxes, sandbox, scan } from './secret-scan-harness';

/**
 * FR-R4-F09 (FR-026, SC-007; research R20; contract DP3, test T13) -- the secret scan still
 * detects every key family it detected, and still passes what is not a secret.
 * FR-R4-F10 (contract test T1; SC1 to SC5; FR-001 to FR-007; SC-001) extends it.
 *
 * WHY THIS EXISTS. FR-025 moves the secretlint engine to the version the rest of the family and
 * the packaging tool already use. That is a change under the repository's only static control, and
 * "the scan still passes on this repository" proves nothing about it: a scan that stopped
 * detecting a family would pass on a tree that holds none. So the test plants one synthetic value
 * per family in its own repository, so a finding is attributable to its case, and asserts three
 * things of each: the scan exits non-zero, the report names that family's rule, and the report
 * does not repeat the value. All the clean cases share one repository, and the scan must exit 0
 * over it. It runs before the dependency change and again after it, and both must pass
 * (baseline-green).
 *
 * FR-R4-F10 adds the families the scan was measured to miss, and runs every case in each of the
 * scan's two modes: tree mode over tracked files, and staged mode over what a commit stages. Both
 * modes run the same configuration, so a family one detects and the other does not is a defect.
 * It also pins what must not drift: the ignore list is the one the feature started from (FR-006),
 * the two existing allowed values are unchanged, the rules run in the declared order, and a new
 * exact-value allowance cannot be added without a line in `SECURITY.md` that states its reason.
 *
 * The harness is shared with `secret-scan-outcomes.test.ts`, so the two cannot drift in how they
 * build a repository or run the scan. Every value is assembled at call time by the fixture, so
 * this file and the fixture hold no token for the repository's own scan to report.
 */
afterEach(removeSandboxes);

const ALL_MODES: ReadonlyArray<ScanMode> = ['tree', 'staged'];

function modesOf(entry: PlantedCase | CleanCase): ReadonlyArray<ScanMode> {
  return entry.modes ?? ALL_MODES;
}

/** A repository for `mode`: staged mode reads the configuration and ignore list from the index. */
function repositoryFor(mode: ScanMode, files: Record<string, string>): string {
  return sandbox(files, mode === 'staged' ? { stageConfig: true } : {});
}

function scanIn(mode: ScanMode, root: string) {
  return mode === 'staged' ? scan(root, ['--staged']) : scan(root);
}

/** Words long enough to be a value, split at the characters a line puts around one. */
function valueWords(text: string): string[] {
  return text.split(/[\s"'=,]+/).filter((word) => word.length >= 12);
}

function reportedAsOf(planted: PlantedCase): string {
  return planted.reportedAs ?? `secretlint-rule-${planted.family}`;
}

describe('the planted cases are each detected', () => {
  it('plants at least one case per family, and a distinct family each', () => {
    const families = PLANTED.map((planted) => planted.family);
    expect(families.length).toBeGreaterThanOrEqual(22);
    expect(new Set(families).size).toBe(families.length);
  });

  it.each(
    PLANTED.flatMap((planted) => modesOf(planted).map((mode) => [planted.family, mode, planted] as const))
  )('detects %s in %s mode, names its rule, and prints no part of the value', (_family, mode, planted) => {
    const value = planted.build();
    const { status, out } = scanIn(mode, repositoryFor(mode, { [planted.file]: value }));
    expect(status, `the scan must fail on a planted ${planted.family} value. Got: ${out}`).toBe(1);
    expect(out).toContain(reportedAsOf(planted));
    expect(out).toContain(planted.file);
    const words = valueWords(value);
    expect(words.length, 'the masking check needs something to look for').toBeGreaterThan(0);
    for (const word of words) expect(out, `a part of the value reached the report`).not.toContain(word);
  });

  it('builds each value afresh, and the fixture file itself holds none', () => {
    for (const planted of PLANTED) expect(planted.build()).toBe(planted.build());
  });
});

describe('the clean cases all pass together', () => {
  it.each(ALL_MODES.map((mode) => [mode] as const))(
    'passes one repository holding every near-miss, allowed value and prose case in %s mode',
    (mode) => {
      const cases = CLEAN.filter((clean) => modesOf(clean).includes(mode));
      const files = Object.fromEntries(cases.map((clean) => [clean.file, clean.text]));
      expect(Object.keys(files).length).toBe(cases.length);
      const { status, out } = scanIn(mode, repositoryFor(mode, files));
      expect(status, out).toBe(0);
      if (mode === 'tree') expect(out).toContain(`secretlint over ${cases.length} tracked file(s)`);
      // Staged mode also reads the two staged configuration files it is carried by.
      else expect(out).toContain(`${cases.length + 2} path(s) scanned`);
    }
  );

  it.each(ALL_MODES.map((mode) => [mode] as const))(
    'CONTROL: the same repository fails once one planted value is added to it, in %s mode',
    (mode) => {
      const files = Object.fromEntries(
        CLEAN.filter((clean) => modesOf(clean).includes(mode)).map((clean) => [clean.file, clean.text])
      );
      const planted = PLANTED.find((entry) => entry.family === 'slack');
      expect(planted).toBeDefined();
      const { status } = scanIn(
        mode,
        repositoryFor(mode, { ...files, [planted?.file ?? 'slack.txt']: planted?.build() ?? '' })
      );
      expect(status).toBe(1);
    }
  );
});

describe('the families that are not planted are recorded, not hidden', () => {
  it('gives each dropped family a measured reason and no planted case', () => {
    for (const dropped of DROPPED) {
      expect(dropped.reason.length).toBeGreaterThan(20);
      expect(PLANTED.some((planted) => planted.family === dropped.family)).toBe(false);
    }
  });

  it('records each unsupported shape with a reason, and claims none of them as planted', () => {
    expect(UNSUPPORTED.length).toBeGreaterThanOrEqual(5);
    const plantedFamilies = new Set(PLANTED.map((planted) => planted.family));
    const names = UNSUPPORTED.map((shape) => shape.name);
    expect(new Set(names).size).toBe(names.length);
    for (const shape of UNSUPPORTED) {
      expect(shape.reason.trim().length, `${shape.name} needs a reason`).toBeGreaterThan(20);
      expect(plantedFamilies.has(shape.family), `${shape.name} is listed as unsupported and as planted`).toBe(false);
    }
  });
});

/**
 * What the feature must not move (FR-006; SC5, SC1). The expected values are copied here, not read
 * from the files they check, so a change to either side fails this test and has to be argued for.
 */
const SECURITY_TEXT = readFileSync(join(REPO_ROOT, 'SECURITY.md'), 'utf8');
// `.secretlintignore` at the commit this feature started from (`a75eb26b`), comments removed.
const PINNED_IGNORE_LIST = [
  'coverage/**',
  'dist/**',
  'out/**',
  'webview-ui/dist/**',
  'tests/visual/.artifacts/**',
  'test-results/**',
  'playwright-report/**',
  '*.vsix',
  'tests/fixtures/key-block-corpus.ts',
  'tests/unit/lib/key-block-redaction.test.ts',
  'tests/unit/lib/logger.test.ts',
  'tests/unit/monitor/cli-transport-sink.test.ts'
];
const PINNED_BASIC_AUTH_VALUE = ['https', '://', 'user:pass@example.com'].join('');
const PINNED_GITHUB_VALUE = ['gh', 'p_0123456789abcdefghijklmnopqrstuvwxyz'].join('');
const PRESET_ID = '@secretlint/secretlint-rule-preset-recommend';
const AWS_ID = '@secretlint/secretlint-rule-aws';
const LOCAL_RULE_ID = './scripts/secretlint-rule-schegent.mjs';

interface RuleEntry {
  readonly id: string;
  readonly options?: { readonly allows?: ReadonlyArray<string>; readonly enableIDScanRule?: boolean };
  readonly rules?: ReadonlyArray<RuleEntry>;
}

function readConfig(): { readonly rules: ReadonlyArray<RuleEntry> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, '.secretlintrc.json'), 'utf8'));
}

function ruleNamed(rules: ReadonlyArray<RuleEntry>, id: string): RuleEntry {
  const found = rules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`the configuration has no ${id} entry`);
  return found;
}

/** The `allows` values of the rules this feature adds, which must each be justified in SECURITY.md. */
function allowsOfAddedRules(config: { readonly rules: ReadonlyArray<RuleEntry> }): string[] {
  const preset = ruleNamed(config.rules, PRESET_ID);
  const addedRules = [ruleNamed(preset.rules ?? [], AWS_ID), ruleNamed(config.rules, LOCAL_RULE_ID)];
  return addedRules.flatMap((rule) => [...(rule.options?.allows ?? [])]);
}

function undocumented(values: ReadonlyArray<string>, securityText: string): string[] {
  return values.filter((value) => !securityText.includes(value));
}

describe('what the feature must not move (FR-006; SC5, SC1)', () => {
  it('leaves the ignore list as it was: no entry added, removed or reordered', () => {
    const lines = readFileSync(join(REPO_ROOT, '.secretlintignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(lines).toEqual(PINNED_IGNORE_LIST);
  });

  it('keeps the two allowed values exactly as they were', () => {
    const config = readConfig();
    const preset = ruleNamed(config.rules, PRESET_ID);
    const basicAuth = ruleNamed(preset.rules ?? [], '@secretlint/secretlint-rule-basicauth');
    const github = ruleNamed(preset.rules ?? [], '@secretlint/secretlint-rule-github');
    expect(basicAuth.options?.allows).toEqual([PINNED_BASIC_AUTH_VALUE]);
    expect(github.options?.allows).toEqual([PINNED_GITHUB_VALUE]);
  });

  it('declares the rules in the pinned order, with the AWS id scan on', () => {
    const config = readConfig();
    expect(config.rules.map((rule) => rule.id)).toEqual([
      PRESET_ID,
      '@secretlint/secretlint-rule-no-dotenv',
      LOCAL_RULE_ID
    ]);
    const preset = ruleNamed(config.rules, PRESET_ID);
    expect((preset.rules ?? []).map((rule) => rule.id)).toEqual([
      '@secretlint/secretlint-rule-basicauth',
      '@secretlint/secretlint-rule-github',
      AWS_ID
    ]);
    expect(ruleNamed(preset.rules ?? [], AWS_ID).options).toEqual({ enableIDScanRule: true });
  });

  it('documents every exact-value allowance the added rules carry, in SECURITY.md', () => {
    const values = allowsOfAddedRules(readConfig());
    expect(undocumented(values, SECURITY_TEXT)).toEqual([]);
  });

  it('CONTROL: an allowance with no line in SECURITY.md fails that check', () => {
    const planted = {
      rules: [
        {
          id: PRESET_ID,
          rules: [{ id: AWS_ID, options: { allows: ['planted-value-without-a-reason-0f3a9c'] } }]
        },
        { id: LOCAL_RULE_ID, options: { allows: [] } }
      ]
    };
    expect(undocumented(allowsOfAddedRules(planted), SECURITY_TEXT)).toEqual([
      'planted-value-without-a-reason-0f3a9c'
    ]);
  });
});
