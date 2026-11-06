#!/usr/bin/env node
// FR-R4-F09 (FR-001; contract RP6) -- package the current build the way a release would, in a
// temporary directory, and inspect what came out.
//
// WHAT CHANGED. The smoke used to package whatever `schegent-sbom.cdx.json` an EARLIER run had left
// at the repository root, and it failed on a tracked-files-only checkout where there is none: the
// archive then lacked an entry the allowlist requires. It also never checked that the SBOM it
// packaged came from the build beside it. It now writes its own SBOM, from the module graphs the
// build just wrote, and compares that SBOM with the archive it packaged. Nothing here reads an
// SBOM, a graph or a VSIX from an earlier run.
//
// The mtime freshness check stays first, where it was designed to stop a stale smoke. It is not
// provenance: it says the output is newer than the sources, not which commit built it.
//
// `smokePackage` takes every step as a seam so the ORDER and the stopping are assertions about
// calls (`tests/unit/build/package-smoke.test.ts`); the real bindings are below, and run only when
// this file is started.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildOutputIsFresh } from './check-build-freshness.mjs';
import {
  STAGE_PACKAGING,
  assertSbomMatchesArchive,
  inspectVsixBytes
} from './check-vsix-smoke.mjs';
import { formatSbomCountsLine, writeSbom } from './generate-sbom.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';
import { formatNoticesLine, writeNotices } from './third-party-notices.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SMOKE_ARCHIVE = 'schegent-smoke.vsix';

/**
 * Package into a temporary directory and inspect the result, in a fixed order: freshness, the
 * SBOM, the notices, `vsce`, the archive inspection over the bytes read once, the SBOM-to-archive
 * comparison, and the removal of the temporary directory. A refusal at any step stops every later one, and
 * the directory is removed after a refusal at `vsce` or later, because it exists from then on.
 * When the removal itself fails, the refusal that stopped the run is the one reported.
 *
 * @param {{ assertFresh: () => void, writeSbom: () => void, writeNotices: () => void,
 *   makeTempDir: () => Promise<string>,
 *   runVsce: (outPath: string) => Promise<void>, readFile: (path: string) => Buffer,
 *   inspectVsixBytes: (bytes: Buffer, label: string) => void,
 *   assertSbomMatchesArchive: (bytes: Buffer, label: string) => unknown,
 *   removeDir: (path: string) => Promise<void> }} deps
 */
export async function smokePackage(deps) {
  // Before `vsce`, not after: packaging stale output either passes on content the current tree
  // never produced, or fails naming files nobody wrote (FR-019 of feature 106).
  deps.assertFresh();
  deps.writeSbom();
  // FR-R5-F21 (FR-025): the archive requires the notices, so the smoke writes its own, as it does
  // the SBOM, rather than packaging whatever an earlier run left.
  deps.writeNotices();

  const directory = await deps.makeTempDir();
  const vsixPath = join(directory, SMOKE_ARCHIVE);
  let refusal;
  try {
    await deps.runVsce(vsixPath);
    const bytes = deps.readFile(vsixPath);
    deps.inspectVsixBytes(bytes, vsixPath);
    deps.assertSbomMatchesArchive(bytes, vsixPath);
  } catch (error) {
    refusal = error;
  }
  try {
    await deps.removeDir(directory);
  } catch (cleanup) {
    // A failed cleanup must not hide why the smoke stopped; it is reported only when nothing else is.
    refusal ??= cleanup;
  }
  if (refusal !== undefined) throw refusal;
}

function runVsce(vscePath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vscePath, 'package', '--no-dependencies', '--out', outPath],
      { stdio: 'inherit', shell: false }
    );
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
        // Feature 106 (T589b, FR-006a, SC-022) -- `vsce` failing is not a packaged-content
        // violation. Without the stage, a reviewer reads this as the allowlist rejecting
        // something and opens the wrong file.
        reject(
          new Error(`${STAGE_PACKAGING} VSIX package command failed (${code ?? signal ?? 'unknown'})`)
        );
      }
    });
  });
}

if (invokedAsScript(import.meta.url)) {
  const vscePath = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');
  try {
    await smokePackage({
      assertFresh: () => assertBuildOutputIsFresh(),
      writeSbom: () => console.log(formatSbomCountsLine(writeSbom(REPO_ROOT).counts)),
      writeNotices: () => console.log(formatNoticesLine(writeNotices(REPO_ROOT))),
      makeTempDir: () => mkdtemp(join(tmpdir(), 'schegent-vsix-smoke-')),
      runVsce: (outPath) => runVsce(vscePath, outPath),
      readFile: (path) => readFileSync(path),
      inspectVsixBytes,
      assertSbomMatchesArchive,
      removeDir: (path) => rm(path, { recursive: true, force: true })
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
