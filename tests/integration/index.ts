import * as path from 'path';
import * as fs from 'fs';
import { writeIntegrationHostResult } from './vscode-test-executable';

const HOST_TEST_SUFFIX = '.host.test.js';

/**
 * FR-R3-045 — run a named subset of the host leg.
 *
 * Set `SCHEGENT_INTEGRATION_FILTER` to a comma-separated list of substrings; a
 * host-test module runs when its filename contains any of them. Without it,
 * everything runs, which is what `ci` does and what any unattended invocation
 * gets.
 *
 * A filter term that matches nothing is a FAILURE, not an empty success — and
 * FR-R3-136 (T1527c) made that per-term rather than per-list, because a list is
 * where a typo hides: two terms, one of them stale, still selects modules, so the
 * launch looks like it ran what it was told to. That is the same vacuity
 * discipline the lint gates hold: a green result over a smaller set than the
 * caller named is the most expensive kind of wrong.
 */
const FILTER_ENV = 'SCHEGENT_INTEGRATION_FILTER';

/**
 * Exclude a named subset from THIS launch. Also a comma-separated list.
 *
 * The leg runs in several launches because some modules need a workspace shape
 * the others must not see: `runTest.ts` opens a single folder for the main pass,
 * a real multi-root `.code-workspace` for `multi-root`, and a copy of
 * `fixtures/untrusted-workspace/` twice over for the two trust legs — once with
 * Workspace Trust live, once with it disabled. Splitting by env keeps the module
 * list DISCOVERED here rather than written down in several places that drift.
 *
 * A stale exclusion is a FAILURE, not a no-op. If a term stops matching — a
 * rename, a typo — the module it named silently rejoins a pass whose workspace it
 * was moved out of, and what a contributor sees is a window reload with no
 * assertion output at all. Same discipline as the filter above: the harness must
 * not quietly run something other than what it was told to run.
 */
const EXCLUDE_ENV = 'SCHEGENT_INTEGRATION_EXCLUDE';

/** Split a list-valued selector env var into its non-empty terms. */
function terms(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * What this leg covers, and what it does not — recorded here because "run it if
 * you touched something integration covers" is not actionable when nobody knows
 * what it covers.
 *
 * The modules here need a LIVE extension host: activation ordering, the
 * dashboard and sidebar surfaces coming up, multi-root behaviour, the
 * `.gitignore` the audit log writes, raw-transcript output, the release-UI
 * qualification pass, and — FR-R3-136 — what an activation does and does not do
 * in a workspace the operator has not trusted.
 *
 * They do not all want the same workspace. `runTest.ts` launches this entry point
 * once per workspace shape: a single folder (the default pass), a real multi-root
 * `.code-workspace`, and a copy of `fixtures/untrusted-workspace/` opened twice —
 * once with Workspace Trust live and once with it disabled. The harness then
 * asserts the launches between them executed every discovered module, so a module
 * cannot fall through the split unnoticed.
 *
 * The other 146 files under `tests/integration/` are NOT this leg. They run in
 * `test:host` on every `ci:fast`, because `vitest.config.ts` includes
 * `tests/integration/**` and excludes only `*.host.test.ts`. The round-3 review
 * described "158 files / ~58k lines" as the least-run gate; 92% of them run on
 * every preflight, and this leg is the remaining 8%.
 */

export async function run(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const all = fs
    .readdirSync(testsRoot)
    .filter((f) => f.endsWith(HOST_TEST_SUFFIX))
    .sort();

  const filter = terms(process.env[FILTER_ENV]);
  const selected =
    filter.length > 0 ? all.filter((f) => filter.some((term) => f.includes(term))) : all;

  const exclude = terms(process.env[EXCLUDE_ENV]);
  const files =
    exclude.length > 0 ? selected.filter((f) => !exclude.some((term) => f.includes(term))) : selected;

  // Say what was selected and what was skipped, always. A subset run whose
  // output looks like a full run is a subset run somebody will cite as one.
  if (filter.length > 0) {
    console.log(
      `[integration] ${FILTER_ENV}=${JSON.stringify(filter.join(','))} selected ` +
        `${selected.length} of ${all.length} host-test module(s); skipped ` +
        `${all.length - selected.length}.`
    );
    for (const skipped of all.filter((f) => !selected.includes(f))) {
      console.log(`[integration]   skipped ${skipped}`);
    }
  }
  if (exclude.length > 0) {
    console.log(
      `[integration] ${EXCLUDE_ENV}=${JSON.stringify(exclude.join(','))} removed ` +
        `${selected.length - files.length} of the ${selected.length} selected module(s).`
    );
    for (const removed of selected.filter((f) => !files.includes(f))) {
      console.log(`[integration]   excluded ${removed}`);
    }
  }
  if (filter.length === 0 && exclude.length === 0) {
    console.log(`[integration] running all ${all.length} host-test module(s).`);
  }

  // Per TERM, not per list. A two-term exclusion where one term is stale still
  // removes something, so a list-level "removed nothing" check would pass while
  // the renamed module rejoined a pass whose workspace it was moved out of.
  const inertExclusions = exclude.filter((term) => !selected.some((f) => f.includes(term)));
  if (inertExclusions.length > 0) {
    throw new Error(
      `${EXCLUDE_ENV} term(s) ${JSON.stringify(inertExclusions.join(','))} removed none of the ` +
        `${selected.length} selected host-test module(s). An exclusion that excludes nothing is a ` +
        `stale exclusion, not a no-op: the module a term names is meant to run in a DIFFERENT ` +
        `workspace, so leaving it in this pass runs it against a shape it was deliberately moved ` +
        `out of. Discovered modules: ${all.join(', ')}`
    );
  }

  const inertFilters = filter.filter((term) => !all.some((f) => f.includes(term)));
  if (inertFilters.length > 0) {
    throw new Error(
      `${FILTER_ENV} term(s) ${JSON.stringify(inertFilters.join(','))} matched none of the ` +
        `${all.length} host-test module(s). A filter term that selects nothing is a failure, not a ` +
        `pass: a launch that executed less than it was told to must not be reportable as a launch ` +
        `that found nothing wrong. Discovered modules: ${all.join(', ')}`
    );
  }

  if (files.length === 0) {
    throw new Error(
      filter.length > 0
        ? `${FILTER_ENV}=${JSON.stringify(filter.join(','))} matched none of the ${all.length} ` +
          `host-test module(s). An empty selection is a failure, not a pass: a run that executed ` +
          `nothing must not be reportable as a run that found nothing wrong.`
        : `no ${HOST_TEST_SUFFIX} modules found under ${testsRoot}. The host leg resolving nothing ` +
          `means the compile step did not emit, not that there is nothing to run.`
    );
  }

  let failures = 0;
  let executed = 0;
  for (const f of files) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the VS Code integration runner loads suites by path at runtime; `import()` here would resolve against the compiled bundle rather than `testsRoot`.
      const mod = require(path.join(testsRoot, f));
      if (typeof mod.run === 'function') {
        executed += 1;
        await mod.run();
      }
    } catch (err) {
      failures += 1;
      console.error(`[integration] ${f} failed:`, err);
    }
  }
  writeIntegrationHostResult({
    schemaVersion: 1,
    pid: process.pid,
    executed,
    failures
  });
  if (failures > 0) {
    throw new Error(`${failures} integration test file(s) failed`);
  }
}
