import * as path from 'path';
import * as fs from 'fs';

const HOST_TEST_SUFFIX = '.host.test.js';

export async function run(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const files = fs
    .readdirSync(testsRoot)
    .filter((f) => f.endsWith(HOST_TEST_SUFFIX));

  let failures = 0;
  for (const f of files) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(path.join(testsRoot, f));
      if (typeof mod.run === 'function') {
        await mod.run();
      }
    } catch (err) {
      failures += 1;
      console.error(`[integration] ${f} failed:`, err);
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} integration test file(s) failed`);
  }
}
