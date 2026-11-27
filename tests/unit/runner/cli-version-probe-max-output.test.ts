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

import {
  CLI_VERSION_MAX_OUTPUT_BYTES,
  createCliVersionProbe,
  normalizeCliVersion
} from '../../../src/runner/cli-version-probe';
import { waitForCondition } from '../../wait-for-condition';

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

  it(
    '16-15: settles near the hard deadline when a grandchild holds stdout open and tears down the process tree',
    async () => {
      const pidFile = path.join(dir, 'grandchild.pid');
      const cliPath = path.join(dir, 'pipe-holder-cli');
      const body = [
        `#!${process.execPath}`,
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        // Spawn a grandchild inheriting stdout/stderr and sleeping 30 s.
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        // Keep parent alive too so the hard deadline must terminate the whole group and close pipes.
        'setTimeout(() => {}, 30000);'
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      const timeoutMs = 400;
      const probe = createCliVersionProbe({ timeoutMs });
      const started = performance.now();
      const version = await probe.observe(cliPath);
      const elapsedMs = performance.now() - started;

      expect(version).toBeNull();
      // Must settle near the 400 ms deadline, nowhere near the grandchild's 30,000 ms sleep.
      expect(elapsedMs).toBeLessThan(3_000);

      // Verify the grandchild process is also torn down by process-group termination.
      const grandchildPidText = await fs.readFile(pidFile, 'utf8').catch(() => '');
      const grandchildPid = Number(grandchildPidText.trim());
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        const deadline = Date.now() + 2_000;
        let alive = true;
        while (Date.now() < deadline) {
          try {
            process.kill(grandchildPid, 0);
            await new Promise((r) => setTimeout(r, 25));
          } catch {
            alive = false;
            break;
          }
        }
        expect(alive).toBe(false);
      }
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    '16-15: settles promptly when the CLI exits while a grandchild still holds stdout open',
    async () => {
      const cliPath = path.join(dir, 'exit-with-pipe-holder-cli');
      const body = [
        `#!${process.execPath}`,
        "const { spawn } = require('node:child_process');",
        `spawn(${JSON.stringify(process.execPath)}, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] });`,
        "process.stdout.write('fake-cli 4.5.6\\n');",
        'process.exit(0);'
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      const probe = createCliVersionProbe({ timeoutMs: 2_000 });
      const started = performance.now();
      const version = await probe.observe(cliPath);
      const elapsedMs = performance.now() - started;

      expect(version).toBe('4.5.6');
      expect(elapsedMs).toBeLessThan(2_000);
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    'CR-B2 / SR-B7: escalates to SIGKILL for a SIGTERM-trapping pipe-holding grandchild after leader exits 0',
    async () => {
      const pidFile = path.join(dir, 'trapping-grandchild.pid');
      const cliPath = path.join(dir, 'exit-with-sigterm-trapping-grandchild');
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "fs.writeSync(3, 'ready');",
        'fs.closeSync(3);',
        'setTimeout(() => {}, 30000);'
      ].join('\n');
      const body = [
        `#!${process.execPath}`,
        "const { spawn } = require('node:child_process');",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 1, 2, 'pipe'] });`,
        'child.stdio[3].once(\'data\', () => {',
        "  process.stdout.write('fake-cli 4.5.6\\n');",
        '  process.exit(0);',
        '});'
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      let grandchildPid = 0;
      try {
        const probe = createCliVersionProbe({ timeoutMs: 2_000 });
        const version = await probe.observe(cliPath);
        expect(version).toBe('4.5.6');

        const pidText = await fs.readFile(pidFile, 'utf8');
        grandchildPid = Number(pidText.trim());
        expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

        await waitForCondition(
          () => {
            try {
              process.kill(grandchildPid, 0);
              return false;
            } catch {
              return true;
            }
          },
          {
            timeoutMs: 3_000,
            label: 'SIGTERM-trapping grandchild terminated by SIGKILL after leader exit 0'
          }
        );
      } finally {
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            /* already terminated */
          }
        }
      }
    },
    PROBE_TEST_TIMEOUT_MS
  );

  const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

  it(
    'CR-308-1: closes stderr and tears down a surviving same-group grandchild when stdout closes before leader exits 0',
    async () => {
      const pidFile = path.join(dir, 'stderr-holder.pid');
      const readyFile = path.join(dir, 'stderr-holder.ready');
      const grandchildPath = path.join(dir, 'stderr-holder.js');
      const cliPath = path.join(dir, 'close-stdout-before-exit-0');
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
        'setTimeout(() => {}, 30000);'
      ].join('\n');
      await fs.writeFile(grandchildPath, grandchildScript, { mode: 0o600 });

      // Grandchild holds stderr (fd 2) open, NOT stdout (fd 1); leader closes stdout via `exec 1>&-` before exiting 0.
      const body = [
        '#!/bin/sh',
        `${shQuote(process.execPath)} ${shQuote(grandchildPath)} </dev/null >/dev/null &`,
        'i=0',
        `while [ ! -f ${shQuote(readyFile)} ] && [ "$i" -lt 200 ]; do`,
        '  sleep 0.01',
        '  i=$((i + 1))',
        'done',
        "printf '2.1.246\\n'",
        'exec 1>&-',
        'sleep 0.05',
        'exit 0'
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      let grandchildPid = 0;
      try {
        const probe = createCliVersionProbe({ timeoutMs: 2_000 });
        const started = performance.now();
        const version = await probe.observe(cliPath);
        const elapsedMs = performance.now() - started;

        expect(version).toBe('2.1.246');
        expect(elapsedMs).toBeLessThan(2_000);

        const pidText = await fs.readFile(pidFile, 'utf8');
        grandchildPid = Number(pidText.trim());
        expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

        await waitForCondition(
          () => {
            try {
              process.kill(grandchildPid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          },
          {
            timeoutMs: 3_000,
            label: 'stderr-holding same-group grandchild torn down with ESRCH after stdout closed before exit 0'
          }
        );
      } finally {
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            /* already terminated */
          }
        }
      }
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    'CR-308-1: tears down a surviving same-group grandchild when stdout closes before leader exits non-zero',
    async () => {
      const pidFile = path.join(dir, 'nonzero-grandchild.pid');
      const readyFile = path.join(dir, 'nonzero-grandchild.ready');
      const grandchildPath = path.join(dir, 'nonzero-grandchild.js');
      const cliPath = path.join(dir, 'close-stdout-before-exit-1');
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
        'setTimeout(() => {}, 30000);'
      ].join('\n');
      await fs.writeFile(grandchildPath, grandchildScript, { mode: 0o600 });

      const body = [
        '#!/bin/sh',
        `${shQuote(process.execPath)} ${shQuote(grandchildPath)} </dev/null >/dev/null 2>/dev/null &`,
        'i=0',
        `while [ ! -f ${shQuote(readyFile)} ] && [ "$i" -lt 200 ]; do`,
        '  sleep 0.01',
        '  i=$((i + 1))',
        'done',
        'exec 1>&-',
        'sleep 0.05',
        'exit 1'
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      let grandchildPid = 0;
      try {
        const probe = createCliVersionProbe({ timeoutMs: 2_000 });
        const started = performance.now();
        const version = await probe.observe(cliPath);
        const elapsedMs = performance.now() - started;

        expect(version).toBeNull();
        expect(elapsedMs).toBeLessThan(2_000);

        const pidText = await fs.readFile(pidFile, 'utf8');
        grandchildPid = Number(pidText.trim());
        expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

        await waitForCondition(
          () => {
            try {
              process.kill(grandchildPid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          },
          {
            timeoutMs: 3_000,
            label: 'same-group grandchild torn down with ESRCH after stdout closed before non-zero exit'
          }
        );
      } finally {
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            /* already terminated */
          }
        }
      }
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it(
    '16-15: returns null and leaks zero raw secret/path text for unparseable stdout',
    async () => {
      const cliPath = path.join(dir, 'secret-banner-cli');
      const body = [
        `#!${process.execPath}`,
        "process.stdout.write('SECRET_TOKEN_XYZ installed at /Users/operator/bin\\n');"
      ].join('\n');
      await fs.writeFile(cliPath, body, { mode: 0o700 });

      const probe = createCliVersionProbe({ timeoutMs: 2_000 });
      await expect(probe.observe(cliPath)).resolves.toBeNull();
    },
    PROBE_TEST_TIMEOUT_MS
  );

  it('SR-308-1: normalizeCliVersion stays O(N) on 64 KiB digit runs without backtracking', () => {
    const digitsOnly = '1'.repeat(CLI_VERSION_MAX_OUTPUT_BYTES);
    const digitsWithTrailingDot = `${'9'.repeat(CLI_VERSION_MAX_OUTPUT_BYTES - 1)}.`;

    const startedAt = performance.now();
    expect(normalizeCliVersion(digitsOnly)).toBeNull();
    expect(normalizeCliVersion(digitsWithTrailingDot)).toBeNull();
    expect(normalizeCliVersion('codex-cli 0.163.2 (build 9)')).toBe('0.163.2');
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(200);
  });
});
