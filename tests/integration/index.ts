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
 * What this leg covers, and what it does not — recorded here because "run it if
 * you touched something integration covers" is not actionable when nobody knows
 * what it covers.
 *
 * The 12 modules here need a LIVE extension host: activation ordering, the
 * dashboard and sidebar surfaces coming up, multi-root behaviour, the
 * `.gitignore` the audit log writes, raw-transcript output, and the release-UI
 * qualification pass.
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
  const files = filter.length > 0 ? all.filter((f) => f.includes(filter)) : all;

  // Say what was selected and what was skipped, always. A subset run whose
  // output looks like a full run is a subset run somebody will cite as one.
  if (filter.length > 0) {
    console.log(
      `[integration] ${FILTER_ENV}=${JSON.stringify(filter)} selected ${files.length} of ` +
        `${all.length} host-test module(s); skipped ${all.length - files.length}.`
    );
    for (const skipped of all.filter((f) => !files.includes(f))) {
      console.log(`[integration]   skipped ${skipped}`);
    }
  } else {
    console.log(`[integration] running all ${all.length} host-test module(s).`);
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
