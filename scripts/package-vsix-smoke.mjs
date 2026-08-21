#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inspectVsix, STAGE_PACKAGING } from './check-vsix-smoke.mjs';
import { assertBuildOutputIsFresh } from './check-build-freshness.mjs';

const require = createRequire(import.meta.url);
const vscePath = require.resolve('@vscode/vsce/vsce');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', (error) =>
      reject(
        new Error(`${STAGE_PACKAGING} could not spawn the VSIX package command: ${error.message}`, {
          cause: error
        })
      )
    );
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        // Feature 106 (T589b, FR-006a, SC-022) — `vsce` failing is not a
        // packaged-content violation. Without the stage, a reviewer reads this
        // as the allowlist rejecting something and opens the wrong file.
        reject(
          new Error(`${STAGE_PACKAGING} VSIX package command failed (${code ?? signal ?? 'unknown'})`)
        );
      }
    });
  });
}

// Before `vsce`, not after: packaging stale output either passes on content the
// current tree never produced, or fails naming files nobody wrote (FR-019).
assertBuildOutputIsFresh();

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'schegent-vsix-smoke-'));
const vsixPath = join(temporaryDirectory, 'schegent-smoke.vsix');
try {
  await run(process.execPath, [
    vscePath,
    'package',
    '--no-dependencies',
    '--out',
    vsixPath
  ]);
  inspectVsix(vsixPath);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
