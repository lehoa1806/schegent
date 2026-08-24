import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import {
  findCompletionMarker,
  INTEGRATION_RESULT_DIR_ENV,
  readSuccessfulIntegrationHostResult,
  resolveDownloadedExecutable
} from './vscode-test-executable';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === 'schegent') return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate Schegent repo root from ${start}`);
}

// VS Code parses `--folder-uri=file://…` from its own argv after Electron has
// already loaded the main entry, so the workspace path is never treated as a
// candidate Electron app. We attach to the extension repo itself for `.git/`
// and `package.json`; the harness creates a temporary `.specify/` marker below
// so the `workspaceContains:.specify/` activation trigger is exercised even
// when the planning envelope lives one directory above `repo/`.
function folderUri(p: string): string {
  const abs = path.resolve(p).split(path.sep).join('/');
  const prefix = abs.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(abs);
}

/**
 * FR-R3-059 — the version this leg runs, read from `engines.vscode`.
 *
 * The harness used to pass no `version` at all, so `downloadAndUnzipVSCode`
 * defaulted to `'stable'` — whatever was current on the machine that day. The
 * manifest claimed a floor and the evidence exercised something else, and nothing
 * connected the two: that is the whole of H-08. No break was ever demonstrated on
 * the declared floor, and none could be, because the floor was never run.
 *
 * Derived rather than written down. A literal here would be correct on the day it
 * was typed and wrong at the next bump — the same hardcoded-fact defect the
 * floor claim itself was.
 */
function declaredVSCodeFloor(): string {
  // `findRepoRoot`, not a relative hop: this file runs COMPILED from
  // `out/tests/integration/`, so counting `..` from the source layout resolved to
  // `out/` and read a package.json that is not there. The harness already has a
  // function for finding the root; using it is what keeps the two in step.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(findRepoRoot(__dirname), 'package.json'), 'utf8')
  ) as { engines?: Record<string, string> };
  const range = manifest.engines?.vscode;
  if (!range) throw new Error('runTest: package.json declares no engines.vscode');
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) throw new Error(`runTest: unparseable engines.vscode ${JSON.stringify(range)}`);
  return match[0];
}

async function acquireVSCodeExecutable(extensionDevelopmentPath: string): Promise<string> {
  const version = declaredVSCodeFloor();
  console.log(`[integration] exercising the DECLARED FLOOR: VS Code ${version}`);
  const options = { extensionDevelopmentPath, version };
  let reportedPath = await downloadAndUnzipVSCode(options);
  let executable = resolveDownloadedExecutable(reportedPath);
  if (executable) return executable;

  // A completion marker without a runnable binary is a corrupt/partial cache.
  // Removing only the marker makes test-electron replace that exact cache on
  // the next acquisition without guessing or recursively deleting a path here.
  const marker = findCompletionMarker(reportedPath);
  if (marker) fs.rmSync(marker, { force: true });
  reportedPath = await downloadAndUnzipVSCode(options);
  executable = resolveDownloadedExecutable(reportedPath);
  if (!executable) {
    throw new Error(`VS Code test install has no runnable executable: ${reportedPath}`);
  }
  return executable;
}

async function main() {
  try {
    // CRITICAL: strip `ELECTRON_RUN_AS_NODE` from the env before spawning
    // VS Code. When the integration tests run from inside another
    // VS Code-family host (Cursor, Antigravity, the VS Code integrated
    // terminal itself), that host leaks `ELECTRON_RUN_AS_NODE=1` into the
    // shell. test-electron spawns the bundled
    // `Visual Studio Code.app/Contents/MacOS/Electron` with
    // `Object.assign({}, process.env, …)`, so the env var passes through
    // unless we delete it from `process.env` directly. With it set,
    // Electron demotes itself to plain `node`: argv[1] becomes a "script
    // to run", `vscode` is never injected, and the harness fails at
    // `require('vscode')` with a stack that looks like an extension-host
    // bug. It isn't.
    delete process.env.ELECTRON_RUN_AS_NODE;

    const extensionDevelopmentPath = findRepoRoot(__dirname);
    const extensionTestsPath = path.resolve(__dirname, './index');
    const vscodeExecutablePath = await acquireVSCodeExecutable(extensionDevelopmentPath);
    // macOS limits Unix-domain socket paths to 103 bytes. Its os.tmpdir()
    // lives under a long /var/folders path, so use the stable short temp root
    // on Unix. Windows has no Unix-socket path limit and keeps its native temp.
    const temporaryRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const harnessDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'sg-it-'));
    const resultDirectory = path.join(harnessDirectory, 'results');
    const userDataDirectory = path.join(harnessDirectory, 'user-data');
    const extensionsDirectory = path.join(harnessDirectory, 'extensions');
    fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
    const specifyDir = path.join(extensionDevelopmentPath, '.specify');
    const createdSpecifyDir = !fs.existsSync(specifyDir);
    if (createdSpecifyDir) fs.mkdirSync(specifyDir, { recursive: true });
    try {
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        vscodeExecutablePath,
        extensionTestsEnv: {
          [INTEGRATION_RESULT_DIR_ENV]: resultDirectory
        },
        launchArgs: [
          `--folder-uri=${folderUri(extensionDevelopmentPath)}`,
          `--user-data-dir=${userDataDirectory}`,
          `--extensions-dir=${extensionsDirectory}`,
          '--disable-extensions',
          '--new-window'
        ]
      });
      const result = readSuccessfulIntegrationHostResult(resultDirectory);
      console.log(`Integration host completed ${result.executed} test modules.`);
    } finally {
      if (createdSpecifyDir) fs.rmSync(specifyDir, { recursive: true, force: true });
      fs.rmSync(harnessDirectory, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
