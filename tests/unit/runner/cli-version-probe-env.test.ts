import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { createCliVersionProbe } from '../../../src/runner/cli-version-probe';
import {
  REQUIRED_PROCESS_ENV_NAMES,
  resolveProcessEnvironmentPolicy,
  type ProcessEnvironmentPolicy
} from '../../../src/runner/spawn-env';

/**
 * FR-R4-F06 (FR-004, SC-002; T2; contract E, E4) -- the real default version probe
 * must build its child environment from the selected policy.
 *
 * Before this feature the probe called `execFile(cliPath, ['--version'], ...)` with
 * no `env`, so the child received the host's complete environment under EVERY mode,
 * the shipped allowlist default included. A `--version` run is a startup of the
 * operator-configured binary, and a binary the operator pointed at can read what it
 * is given. The oracle here is a fake `--version` executable that writes the sorted
 * NAMES of its environment to a file beside it: no value is ever recorded, printed
 * or asserted on (standing rule 12).
 *
 * The control is the third case. If explicit `inherit` did not deliver the synthetic
 * secret, the first two cases would pass for a reason that has nothing to do with the
 * policy, and this file would assert nothing.
 *
 * POSIX only: the fake CLI is an executable script with a shebang.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

/** Bounded wait for one real `--version` child (standing rule 11). */
const PROBE_TEST_TIMEOUT_MS = 10_000;

const ALLOWLIST_DEFAULT: ProcessEnvironmentPolicy = resolveProcessEnvironmentPolicy({
  inheritEnvironment: true,
  mode: 'allowlist',
  allowlist: []
});

posixOnly('the real version probe obeys the environment policy (T2)', () => {
  let dir: string;
  let secretName: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-version-probe-'));
    secretName = `SCHEGENT_TEST_SECRET_${randomBytes(6).toString('hex').toUpperCase()}`;
    process.env[secretName] = randomBytes(12).toString('hex');
  });

  afterEach(async () => {
    delete process.env[secretName];
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * Writes an executable script that records its own environment NAMES and prints a
   * version line. The shebang names the running Node by absolute path, because the
   * minimal policy forwards no `PATH` for `/usr/bin/env` to search.
   */
  async function writeFakeCli(): Promise<{ cliPath: string; namesPath: string }> {
    const cliPath = path.join(dir, 'fake-cli');
    const namesPath = path.join(dir, 'env-names.json');
    const body = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(namesPath)}, JSON.stringify(Object.keys(process.env).sort()));`,
      "process.stdout.write('fake-cli 9.9.9\\n');"
    ].join('\n');
    await fs.writeFile(cliPath, body, { mode: 0o700 });
    return { cliPath, namesPath };
  }

  async function recordedNames(namesPath: string): Promise<readonly string[]> {
    return JSON.parse(await fs.readFile(namesPath, 'utf8')) as string[];
  }

  /**
   * The names the operating system and the Node runtime put into a child that was
   * handed NO environment at all. macOS adds `__CF_USER_TEXT_ENCODING` to every
   * process, so a check that every name came from the policy would fail on a clean
   * policy. Measuring this baseline on the same machine, with the same fake CLI, is
   * what lets the cases below say "nothing beyond the policy" without a hard-coded
   * allowance for one platform.
   */
  async function platformAddedNames(cliPath: string, namesPath: string): Promise<readonly string[]> {
    await promisify(execFile)(cliPath, [], { env: {}, timeout: PROBE_TEST_TIMEOUT_MS });
    return recordedNames(namesPath);
  }

  it(
    'forwards no ambient name beyond the bootstrap set under the shipped allowlist default',
    async () => {
      const { cliPath, namesPath } = await writeFakeCli();
      const platformAdded = new Set(await platformAddedNames(cliPath, namesPath));
      const probe = createCliVersionProbe({ environmentPolicy: () => ALLOWLIST_DEFAULT });

      const version = await probe.observe(cliPath);

      expect(version).toBe('9.9.9');
      const names = await recordedNames(namesPath);
      expect(names).not.toContain(secretName);
      const permitted = new Set(REQUIRED_PROCESS_ENV_NAMES);
      const stray = names.filter(
        (name) => !permitted.has(name) && !name.startsWith('LC_') && !platformAdded.has(name)
      );
      expect(stray).toEqual([]);
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    'forwards the overlay only under the minimal policy',
    async () => {
      const { cliPath, namesPath } = await writeFakeCli();
      const platformAdded = [...(await platformAddedNames(cliPath, namesPath))].sort();
      const minimal = resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'minimal',
        allowlist: []
      });
      const probe = createCliVersionProbe({ environmentPolicy: () => minimal });

      const version = await probe.observe(cliPath);

      expect(version).toBe('9.9.9');
      // The probe adds no overlay, so the child sees exactly what a child handed an empty
      // environment sees: nothing from the host, bootstrap names included.
      expect(await recordedNames(namesPath)).toEqual(platformAdded);
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    'control: forwards the synthetic secret under explicit inherit',
    async () => {
      const { cliPath, namesPath } = await writeFakeCli();
      const inherit = resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'inherit',
        allowlist: []
      });
      const probe = createCliVersionProbe({ environmentPolicy: () => inherit });

      const version = await probe.observe(cliPath);

      expect(version).toBe('9.9.9');
      expect(await recordedNames(namesPath)).toContain(secretName);
    },
    PROBE_TEST_TIMEOUT_MS
  );
});
