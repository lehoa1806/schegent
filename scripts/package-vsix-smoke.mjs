#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inspectVsix } from './check-vsix-smoke.mjs';

const require = createRequire(import.meta.url);
const vscePath = require.resolve('@vscode/vsce/vsce');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`VSIX package command failed (${code ?? signal ?? 'unknown'})`));
    });
  });
}

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
