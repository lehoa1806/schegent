// FR-R6-F09 T031 (NFR-002) -- the real `--version` probe reads a bounded amount of output.
//
// WHY. The probe's answer now decides admission: the version is part of the fingerprint a spawn
// is judged on. An executable that answers `--version` with an unbounded stream would make the
// host buffer all of it before deciding anything. Past `CLI_VERSION_MAX_OUTPUT_BYTES` the probe
// stops reading and the answer is `null`, which the admission check reads as unverified -- the
// refusing direction.
//
// The control is the second case: the same fake CLI under the limit answers its version, so the
// first case fails because of the size and nothing else.
//
// POSIX only: the fake CLI is an executable script with a shebang.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_VERSION_MAX_OUTPUT_BYTES, createCliVersionProbe } from '../../../src/runner/cli-version-probe';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

/** Bounded wait for one real `--version` child. */
const PROBE_TEST_TIMEOUT_MS = 10_000;

/** Well under Node's 1 MiB default, so only an explicit bound can refuse it. */
const OVER_LIMIT_BYTES = 256 * 1024;

posixOnly('the real version probe bounds its output (FR-R6-F09 NFR-002)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-version-bound-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fakeCli(totalBytes: number): Promise<string> {
    const cliPath = path.join(dir, 'fake-cli');
    const body = [
      `#!${process.execPath}`,
      "const line = 'fake-cli 9.9.9\\n';",
      `process.stdout.write(line + 'x'.repeat(${totalBytes} - line.length));`
    ].join('\n');
    await fs.writeFile(cliPath, body, { mode: 0o700 });
    return cliPath;
  }

  it('the bound is 64 KiB', () => {
    expect(CLI_VERSION_MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });

  it(
    'an answer past the bound reads as unobserved',
    async () => {
      const probe = createCliVersionProbe();
      await expect(probe.observe(await fakeCli(OVER_LIMIT_BYTES))).resolves.toBeNull();
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    'the same CLI under the bound answers its version (control)',
    async () => {
      const probe = createCliVersionProbe();
      await expect(probe.observe(await fakeCli(1024))).resolves.toBe('9.9.9');
    },
    PROBE_TEST_TIMEOUT_MS
  );
});
