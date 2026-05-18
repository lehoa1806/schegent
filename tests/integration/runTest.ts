import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

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
    const specifyDir = path.join(extensionDevelopmentPath, '.specify');
    const createdSpecifyDir = !fs.existsSync(specifyDir);
    if (createdSpecifyDir) fs.mkdirSync(specifyDir, { recursive: true });
    try {
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [`--folder-uri=${folderUri(extensionDevelopmentPath)}`]
      });
    } finally {
      if (createdSpecifyDir) fs.rmSync(specifyDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
