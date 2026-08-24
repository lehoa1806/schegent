// FR-R3-064 — a new route cannot reach a backend without a posture record.
//
// THE ARGUMENT
//
// The record is emitted at one place: `PhaseRunner.run`, right after the
// effective runner kind is resolved. That is defensible only while `PhaseRunner`
// really is the single funnel — so this gate enumerates every production call
// site that drives a `BackendRunner`, and every production construction of
// `PhaseRunner`, and fails on one it has not been told about.
//
// It is the FR-R3-056 reasoning applied one layer up. That item made
// `allowUncontained` a required option so `tsc` would enumerate every
// construction site; the equivalent here would be a required constructor
// parameter, and it is not available cheaply: 109 test harnesses construct
// `PhaseRunner` positionally, and requiring the parameter would pull all of them
// into the diff — a change big enough to hide the change it was made for. So the
// enumeration is a gate rather than a type, and this comment says so instead of
// letting a reader assume the compiler covers it.
//
// WHAT THIS GATE GUARANTEES
//
//   - every production `.invoke(` on a backend runner is the emission site, or a
//     listed exception carrying a reason;
//   - every production `new PhaseRunner(` passes a posture accessor, so the
//     emitter is never silently disabled in a shipped path;
//   - the emission site still contains the emission.
//
// WHAT IT DOES NOT GUARANTEE
//
//   - It matches `.invoke(` by NAME on the source text of `src/`. A backend
//     reached through a differently named method, or through a dynamically
//     resolved property, is not seen. That residual is real and is the reason
//     `backend-posture-routes.test.ts` resolves the four named routes
//     independently — two gates with different blind spots rather than one with a
//     hole.
//   - It proves a call site is ACCOUNTED FOR, not that its accounting is
//     correct. A wrong reason in the table below is a review failure, not a gate
//     failure. The reasons are written so that a reviewer can disagree with them.
//
// OBSERVED NON-VACUOUS, 2026-08-24, darwin/arm64 — see the observation block
// below the table.
//
// HERMETIC: `node:fs` only. `lint-gates-are-hermetic` allows `git`, `node`, `npm`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = 'src';
const EMISSION_SITE = 'src/controller/backend-posture-recorder.ts';
const FUNNEL = 'src/controller/phase-runner.ts';

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

function tsFilesUnder(relDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push(relative(REPO_ROOT, full).split('\\').join('/'));
      }
    }
  };
  walk(resolve(REPO_ROOT, relDir));
  return out.sort();
}

/**
 * Every production site that invokes something runner-shaped, and what accounts
 * for it. An entry is not permission to skip the record — it is a statement of
 * why this site is not a Run reaching a backend, or why it is already covered.
 */
const ACCOUNTED_INVOKE_SITES: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/controller/phase-runner.ts',
    why:
      'THE funnel. `postureRecorder.recordOnce` runs immediately before this call, in the same ' +
      'method, so nothing reaches a backend through here unrecorded. The recorder itself lives in ' +
      'controller/backend-posture-recorder.ts.'
  },
  {
    file: 'src/controller/session-compactor.ts',
    why:
      'Reached from inside PhaseRunner.run, for the same Run on the same backend kind, AFTER the ' +
      'posture record for that pair has already been written. A second record here would be the ' +
      'per-phase repetition the ledger exists to prevent.'
  },
  {
    file: 'src/watchdog/credit-watchdog.ts',
    why:
      'A window-level `/status` poll with no run id. FR-R3-064 records a posture per RUN; this has ' +
      'no Run to attribute one to, and inventing an id to satisfy a gate would put a fabricated ' +
      'identifier in the audit log. If credit polling ever becomes Run-scoped, it needs a record ' +
      'and this entry has to go.'
  },
  {
    file: 'src/runner/agy-cli.ts',
    why: 'Calls `lifecycle.invoke` on the internal process runner, not the BackendRunner facade.'
  },
  {
    file: 'src/runner/codex-cli.ts',
    why: 'Calls `lifecycle.invoke` on the internal process runner, not the BackendRunner facade.'
  }
];

/*
 * OBSERVED NON-VACUOUS, 2026-08-24, darwin/arm64.
 *
 * Two seeded regressions, each restored afterwards. Command in both cases:
 * `npx vitest run tests/lint/backend-posture-emission-funnel.test.ts`.
 *
 *   1. An unaccounted invoke site — appended a function calling `r.invoke({})` to
 *      `src/services/run-origin-resolver.ts`. Exit non-zero: 1 failed / 4 passed,
 *      naming the file.
 *   2. A production construction with the accessor stripped — removed
 *      `backendPostureAccessor` from the `new PhaseRunner(` argument list in
 *      `src/extension.ts`. Exit non-zero: 1 failed / 4 passed, naming
 *      `src/extension.ts`.
 *
 * Restored tree: 5 passed / 5. The second observation is the one that matters
 * most: it is the failure mode a required constructor parameter would have caught
 * for free, and this gate is what stands in for that.
 */
describe('backend posture emission funnel (FR-R3-064)', () => {
  it('every production invoke site is accounted for', () => {
    const accounted = new Set(ACCOUNTED_INVOKE_SITES.map((e) => e.file));
    const unaccounted = tsFilesUnder(SRC).filter(
      (file) => /\.invoke\(/.test(read(file)) && !accounted.has(file)
    );

    expect(
      unaccounted,
      `${unaccounted.join(', ')} invokes a runner and is not accounted for in ` +
        'ACCOUNTED_INVOKE_SITES. If it is a Run reaching a backend, it must reach it through ' +
        'PhaseRunner.run so the posture is recorded. If it is not, add an entry saying why — and ' +
        'the reason has to be one a reviewer could disagree with.'
    ).toEqual([]);
  });

  it('no accounted entry outlives its call site', () => {
    // An enumeration that keeps entries for files that no longer invoke anything
    // is an enumeration nobody has read against the tree.
    const stale = ACCOUNTED_INVOKE_SITES.filter((entry) => !/\.invoke\(/.test(read(entry.file)));
    expect(
      stale.map((e) => e.file),
      `${stale.map((e) => e.file).join(', ')} no longer invokes a runner; remove the entry`
    ).toEqual([]);
  });

  it('every accounted entry carries a reason', () => {
    for (const entry of ACCOUNTED_INVOKE_SITES) {
      expect(entry.why.length, `${entry.file} has no recorded reason`).toBeGreaterThan(40);
    }
  });

  it('the funnel still calls the recorder, before phase-start', () => {
    const text = read(FUNNEL);
    const call = text.indexOf('await this.postureRecorder.recordOnce(');
    const phaseStart = text.indexOf("await this.appendAudit(inputs, 'phase-start'");
    expect(call).toBeGreaterThan(-1);
    expect(phaseStart).toBeGreaterThan(-1);
    expect(call).toBeLessThan(phaseStart);
  });

  it('the recorder still emits, through the required-evidence path', () => {
    const text = read(EMISSION_SITE);
    expect(text).toContain("eventType: 'backend-posture-admitted'");
    // Required, not best-effort: this is the throw that stops a Run proceeding
    // unrecorded. A plain append here would make the record optional in practice.
    expect(text).toContain('this.appendRequired(');
  });

  it('every production PhaseRunner construction passes a posture accessor', () => {
    // The parameter is optional in the signature and mandatory here. See the file
    // header for why the type system is not carrying this.
    const constructionSites = tsFilesUnder(SRC).filter((file) =>
      read(file).includes('new PhaseRunner(')
    );
    expect(constructionSites.length, 'no production PhaseRunner construction found').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of constructionSites) {
      const text = read(file);
      const start = text.indexOf('new PhaseRunner(');
      const end = text.indexOf(');', start);
      const args = text.slice(start, end);
      if (!/postureAccessor|PostureAccessor/.test(args)) missing.push(file);
    }
    expect(
      missing,
      `${missing.join(', ')} constructs PhaseRunner without a posture accessor. Without it the ` +
        'emitter is silent, because recording `false` for a posture it cannot read would be a lie. ' +
        'A shipped path that cannot record its posture is the defect FR-R3-064 exists to remove.'
    ).toEqual([]);
  });
});
