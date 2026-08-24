import * as path from 'path';
import * as fs from 'fs';
import { writeIntegrationHostResult } from './vscode-test-executable';

const HOST_TEST_SUFFIX = '.host.test.js';

/**
 * FR-R3-045 — run a named subset of the host leg.
 *
 * Set `SCHEGENT_INTEGRATION_FILTER` to a substring; only host-test modules whose
 * filename contains it run. Without it, everything runs, which is what `ci` does
 * and what any unattended invocation gets.
 *
 * A filter that matches nothing is a FAILURE, not an empty success. That is the
 * same vacuity discipline the lint gates hold: a contributor citing "the
 * integration suite passed" after a typo in their filter would be citing a run
 * that executed nothing, and a green result over an empty set is the most
 * expensive kind of wrong.
 */
const FILTER_ENV = 'SCHEGENT_INTEGRATION_FILTER';

/**
 * Exclude a named subset from THIS launch.
 *
 * The leg runs in two launches because one module needs a workspace shape the
 * others must not see: `runTest.ts` opens a single folder for the main pass and
 * a real multi-root `.code-workspace` for `multi-root`. Splitting by env keeps
 * the module list DISCOVERED here rather than written down in two places that
 * drift.
 *
 * A stale exclusion is a FAILURE, not a no-op. If the name stops matching — a
 * rename, a typo — the excluded module silently rejoins a pass whose workspace
 * it was moved out of, and what a contributor sees is a window reload with no
 * assertion output at all. Same discipline as the filter above: the harness must
 * not quietly run something other than what it was told to run.
 */
const EXCLUDE_ENV = 'SCHEGENT_INTEGRATION_EXCLUDE';

/**
 * What this leg covers, and what it does not — recorded here because "run it if
 * you touched something integration covers" is not actionable when nobody knows
 * what it covers.
 *
 * The modules here need a LIVE extension host: activation ordering, the
 * dashboard and sidebar surfaces coming up, multi-root behaviour, the
 * `.gitignore` the audit log writes, raw-transcript output, and the release-UI
 * qualification pass.
 *
 * They do not all want the same workspace. `runTest.ts` launches this entry
 * point twice: once against a single folder (everything but `multi-root`), and
 * once against a real multi-root `.code-workspace` (`multi-root` alone). The
 * harness then asserts the two passes between them executed every discovered
 * module, so a module cannot fall through the split unnoticed.
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

  const filter = (process.env[FILTER_ENV] ?? '').trim();
  const selected = filter.length > 0 ? all.filter((f) => f.includes(filter)) : all;

  const exclude = (process.env[EXCLUDE_ENV] ?? '').trim();
  const files = exclude.length > 0 ? selected.filter((f) => !f.includes(exclude)) : selected;

  // Say what was selected and what was skipped, always. A subset run whose
  // output looks like a full run is a subset run somebody will cite as one.
  if (filter.length > 0) {
    console.log(
      `[integration] ${FILTER_ENV}=${JSON.stringify(filter)} selected ${selected.length} of ` +
        `${all.length} host-test module(s); skipped ${all.length - selected.length}.`
    );
    for (const skipped of all.filter((f) => !selected.includes(f))) {
      console.log(`[integration]   skipped ${skipped}`);
    }
  }
  if (exclude.length > 0) {
    console.log(
      `[integration] ${EXCLUDE_ENV}=${JSON.stringify(exclude)} removed ` +
        `${selected.length - files.length} of the ${selected.length} selected module(s).`
    );
    for (const removed of selected.filter((f) => !files.includes(f))) {
      console.log(`[integration]   excluded ${removed}`);
    }
  }
  if (filter.length === 0 && exclude.length === 0) {
    console.log(`[integration] running all ${all.length} host-test module(s).`);
  }

  if (exclude.length > 0 && files.length === selected.length) {
    throw new Error(
      `${EXCLUDE_ENV}=${JSON.stringify(exclude)} removed none of the ${selected.length} selected ` +
        `host-test module(s). An exclusion that excludes nothing is a stale exclusion, not a ` +
        `no-op: the module it names is meant to run in a DIFFERENT workspace, so leaving it in ` +
        `this pass runs it against a shape it was deliberately moved out of.`
    );
  }

  if (files.length === 0) {
    throw new Error(
      filter.length > 0
        ? `${FILTER_ENV}=${JSON.stringify(filter)} matched none of the ${all.length} host-test ` +
          `module(s). An empty selection is a failure, not a pass: a run that executed nothing ` +
          `must not be reportable as a run that found nothing wrong.`
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
