import * as path from 'path';
import * as fs from 'fs';
import { writeIntegrationHostResult } from './vscode-test-executable';

const HOST_TEST_SUFFIX = '.host.test.js';

export async function run(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const files = fs
    .readdirSync(testsRoot)
    .filter((f) => f.endsWith(HOST_TEST_SUFFIX));

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
