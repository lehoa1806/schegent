import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * FR-R3-110 (FR-105, FR-106) — two compiler options adopted progressively, under a ratchet.
 *
 * WHY THEY ARE NOT SIMPLY TURNED ON. `noUncheckedIndexedAccess` produces **1,279** diagnostics
 * across this tree and `exactOptionalPropertyTypes` produces **142**. Turning either on in
 * `tsconfig.json` would break the build until every site was rewritten — and rewriting 1,279
 * sites in one change is precisely the bulk refactor FR-106 forbids and `AGENTS.md`'s work-style
 * rule bans as a drive-by. A diff that large has near-zero review value and non-zero risk.
 *
 * WHY THEY ARE NOT SIMPLY DEFERRED EITHER. The absence matters: core state is
 * `Record<queueId, …>` maps, and `noUncheckedIndexedAccess` is the option that makes
 * `map[id].field` a compile error instead of a runtime `undefined`. Part of the price is already
 * visible as the 342-entry `no-unnecessary-condition` lint baseline — checks the codebase writes
 * by hand because the compiler was not asked to.
 *
 * SO: MEASURED, PINNED, SHRINK-ONLY. This is `FR-R3-039`/`FR-R3-088`'s recorded mechanism applied
 * to a compiler flag. The count is absorbed, growth is refused, and the flag graduates into
 * `tsconfig.json` when its count reaches zero. Until then the ratchet IS the adoption: it makes
 * the debt visible, bounded, and one-directional.
 *
 * TWO-DIRECTIONAL means the number may fall without editing this file, and a fall past a margin
 * is REPORTED so the progress can be locked in. It may never rise.
 *
 * COST, and why it is measured in-process. Each flag needs a full type-check. An earlier draft
 * spawned `npx tsc`, and `lint-gates-are-hermetic.test.ts` refused it — correctly: `npx` is an
 * undeclared binary, and a lint gate that shells out to a resolver makes the hermetic tier depend
 * on something a documented setup may not have. This uses the TypeScript compiler API instead, so
 * there is no subprocess at all. That is both hermetic and faster.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The pinned counts, measured 2026-08-26 at the closing commit of feature 156.
 *
 * `src` and `tests` are counted together on purpose: a test that indexes a map without checking
 * is as capable of a false green as production code is of a crash, and splitting them would
 * invite fixing only the half that shows up in coverage.
 */
const RATCHET: ReadonlyArray<{
  readonly flag: 'noUncheckedIndexedAccess' | 'exactOptionalPropertyTypes';
  readonly total: number;
  readonly src: number;
  readonly why: string;
}> = [
  {
    flag: 'noUncheckedIndexedAccess',
    total: 1_279,
    src: 175,
    why:
      'core state is Record<queueId, …>; this flag is what turns map[id].field from a runtime ' +
      'undefined into a compile error. The 342-entry no-unnecessary-condition baseline is part ' +
      'of the price already being paid by hand'
  },
  {
    flag: 'exactOptionalPropertyTypes',
    total: 142,
    src: 71,
    why:
      'distinguishes an absent key from one explicitly set to undefined — which this codebase ' +
      'depends on in several places by convention (spawnIdentity, capabilities, ambientConfig ' +
      'all read "absent" differently from "undefined") and cannot currently express'
  }
];

/** How far below the pin a count may fall before the ratchet asks to be tightened. */
const SLACK_BEFORE_NAGGING = 25;

interface Measured {
  readonly total: number;
  readonly src: number;
  readonly byFile: ReadonlyMap<string, number>;
}

/**
 * Type-check the project with one extra option and count what it reports.
 *
 * In-process, through the compiler API: no subprocess, no `npx`, nothing outside `typescript`
 * itself. Only SEMANTIC diagnostics are counted — a syntactic error would be a broken tree rather
 * than strictness debt, and mixing the two would make the pin move for the wrong reason.
 */
function measure(option: 'noUncheckedIndexedAccess' | 'exactOptionalPropertyTypes'): Measured {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const readResult = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
  expect(readResult.error, 'tsconfig.json must parse').toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config as object,
    ts.sys,
    REPO_ROOT
  );
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    [option]: true,
    noEmit: true
  });

  const byFile = new Map<string, number>();
  let total = 0;
  let src = 0;
  for (const diagnostic of program.getSemanticDiagnostics()) {
    if (diagnostic.file === undefined) continue;
    const file = relative(REPO_ROOT, diagnostic.file.fileName).replaceAll('\\', '/');
    total += 1;
    if (file.startsWith('src/')) src += 1;
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  return { total, src, byFile };
}

/**
 * How long one measurement may take.
 *
 * This case creates a full TypeScript program over the whole tree, twice — once per flag — which
 * measured **12.5 s** standalone on the reference machine and exceeded the 30 s default when the
 * gate ran it under coverage instrumentation alongside 780 other files. That is COST, not a hang:
 * the alternative to paying it is a ratchet that measures nothing.
 *
 * Bounded rather than unbounded, so a genuinely wedged compiler still fails instead of holding the
 * gate open forever.
 */
const MEASURE_TIMEOUT_MS = 180_000;

describe('FR-R3-110 — compiler strictness is adopted under a ratchet', () => {
  it.each(RATCHET)('$flag has not grown past its pinned count', (entry) => {
    const measured = measure(entry.flag);

    // The floor: a tsc invocation that produced NOTHING would report zero and read as total
    // success. Zero is the goal, but it must be reached by fixing sites, not by failing to run.
    expect(
      measured.byFile.size,
      `${entry.flag} produced no diagnostics at all. Either the debt is genuinely gone — in ` +
        'which case turn the flag on in tsconfig.json and delete this entry — or tsc did not ' +
        'run. Check by hand before believing it.'
    ).toBeGreaterThan(0);

    expect(
      measured.total,
      `${entry.flag} now reports ${measured.total} diagnostics, over the pinned ${entry.total}. ` +
        `Why this flag matters: ${entry.why}. The baseline absorbs the existing count and ` +
        'refuses growth (FR-106 forbids a bulk refactor to satisfy it), so a NEW site must be ' +
        'written to satisfy the flag. The worst offenders, for orientation:\n' +
        [...measured.byFile.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([file, count]) => `  ${count.toString().padStart(4)}  ${file}`)
          .join('\n')
    ).toBeLessThanOrEqual(entry.total);

    // The `src` half separately: production code is where an unchecked index becomes a crash
    // rather than a false green, so it must not grow even if the total falls.
    expect(
      measured.src,
      `${entry.flag} reports ${measured.src} diagnostics in src/, over the pinned ${entry.src}. ` +
        'A falling total does not license growth in production code.'
    ).toBeLessThanOrEqual(entry.src);

    // The pinned figures were confirmed EQUAL to the API's measurement when this landed
    // (1279/175 and 142/71), not merely above it — a pin comfortably above the real count is a
    // ratchet that has stopped ratcheting.
    if (entry.total - measured.total >= SLACK_BEFORE_NAGGING) {
      console.log(
        `compiler-strictness-ratchet: ${entry.flag} is down to ${measured.total} from a pinned ` +
          `${entry.total} (${entry.total - measured.total} of slack). Lower the pin to lock it in.`
      );
    }
  }, MEASURE_TIMEOUT_MS);

  it('neither flag is silently enabled in a tsconfig, which would make the ratchet dead code', () => {
    // If a flag graduates into the build, this ratchet entry must be DELETED rather than left
    // measuring something the compiler already enforces — a gate whose subject moved is a gate
    // nobody reads.
    for (const config of ['tsconfig.json', 'tsconfig.tests.json', 'tsconfig.integration.json']) {
      const source = readFileSync(resolve(REPO_ROOT, config), 'utf8');
      for (const entry of RATCHET) {
        const option = entry.flag;
        const enabled = new RegExp(`"${option}"\\s*:\\s*true`).test(source);
        expect(
          enabled,
          `${config} enables ${option}, so its ratchet entry is measuring what the compiler ` +
            'already enforces. Delete the entry and let the build be the gate.'
        ).toBe(false);
      }
    }
  });

  it('every entry states why the flag is worth adopting', () => {
    // A ratchet on a flag nobody can justify is a number that will be raised the first time it
    // is inconvenient.
    for (const entry of RATCHET) {
      expect(entry.why.length, `${entry.flag} needs a real reason`).toBeGreaterThan(80);
    }
  });
});
