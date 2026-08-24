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

const HOST_TEST_SUFFIX = '.host.test.js';

/**
 * The one module that needs a workspace the others must not see.
 *
 * `multi-root.host.test.ts` used to build its own multi-root workspace at
 * runtime by calling `updateWorkspaceFolders` on the single folder this harness
 * opened. On VS Code at the declared floor that transition RELOADS the window:
 * single-folder to multi-root means VS Code writes an untitled workspace and
 * restarts, the extension-test run is torn down mid-flight, and the leg reports
 * exit 1 with no assertion output at all — nothing that names the module or
 * points at the cause. Newer builds happen not to reload, which is why the
 * technique survived as long as it did.
 *
 * A real `.code-workspace` opened at launch needs no transition, so it works on
 * every host, and it exercises the activation-time multi-root surfaces the
 * mutation approach could never reach: the toast and the
 * `multi-root.warning-shown` audit event both fire at `activate()`, which had
 * already happened against a single folder by the time the old test ran.
 */
const MULTI_ROOT_MODULE = 'multi-root';

/** The tracked fixture that defines the multi-root pass's workspace shape. */
const MULTI_ROOT_FIXTURE = path.join('tests', 'integration', 'fixtures', 'multi-root.code-workspace');

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

// VS Code parses `--folder-uri=file://…` and `--file-uri=file://…` from its own
// argv after Electron has already loaded the main entry, so neither path is ever
// treated as a candidate Electron app. The single-folder pass attaches to the
// extension repo itself for `.git/` and `package.json`; the harness creates a
// temporary `.specify/` marker below so the `workspaceContains:.specify/`
// activation trigger is exercised even when the planning envelope lives one
// directory above `repo/`.
function toFileUri(p: string): string {
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

interface WorkspaceFixture {
  readonly folders?: readonly { readonly name?: string; readonly path: string }[];
}

/**
 * Materialize the tracked multi-root fixture into `into` and return the path of
 * the generated `.code-workspace`.
 *
 * The fixture is the source of the workspace's SHAPE — how many folders and what
 * they are called — but the run cannot open it in place. Activation writes
 * `.schegent/` into the canonical folder, and the fixture's folders are tracked,
 * so opening the checked-in workspace would dirty the working tree on every
 * integration run. Copying the shape into the harness temp directory keeps the
 * writes disposable while leaving one declared definition of the shape.
 */
function materializeMultiRootWorkspace(repoRoot: string, into: string): string {
  const templatePath = path.join(repoRoot, MULTI_ROOT_FIXTURE);
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as WorkspaceFixture;
  const declared = template.folders ?? [];
  if (declared.length < 2) {
    throw new Error(
      `${MULTI_ROOT_FIXTURE} declares ${declared.length} folder(s); the multi-root pass is ` +
        `meaningless below 2 — a single-folder workspace is what the other pass already opens.`
    );
  }
  fs.mkdirSync(into, { recursive: true });
  const folders = declared.map((folder) => {
    const basename = path.basename(folder.path);
    const absolute = path.join(into, basename);
    fs.mkdirSync(absolute, { recursive: true });
    return { name: folder.name ?? basename, path: absolute };
  });
  // `folders[0]` is the canonical folder. The `.specify/` marker makes the
  // extension activate through `workspaceContains:` the way a real workspace
  // does, so the activation-time multi-root surfaces fire before any test runs
  // rather than because a test poked `activate()`.
  fs.mkdirSync(path.join(folders[0]!.path, '.specify'), { recursive: true });
  const workspaceFile = path.join(into, path.basename(MULTI_ROOT_FIXTURE));
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders, settings: {} }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
  return workspaceFile;
}

interface PassOptions {
  /** Short name for logs and for this pass's private directories. */
  readonly label: string;
  readonly extensionDevelopmentPath: string;
  readonly extensionTestsPath: string;
  readonly vscodeExecutablePath: string;
  readonly harnessDirectory: string;
  /** Either `--folder-uri=…` or `--file-uri=…`, already formed. */
  readonly workspaceArg: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Run one launch of the host leg; returns how many modules it executed. */
async function runPass(options: PassOptions): Promise<number> {
  // Per-pass `user-data-dir`: a shared profile carries the previous launch's
  // window and workspace forward, so the second pass would reopen the first
  // pass's workspace and silently test the wrong shape.
  const passRoot = path.join(options.harnessDirectory, options.label);
  const resultDirectory = path.join(passRoot, 'results');
  const userDataDirectory = path.join(passRoot, 'user-data');
  const extensionsDirectory = path.join(passRoot, 'extensions');
  fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });

  console.log(`[integration] launch '${options.label}' with ${options.workspaceArg}`);
  await runTests({
    extensionDevelopmentPath: options.extensionDevelopmentPath,
    extensionTestsPath: options.extensionTestsPath,
    vscodeExecutablePath: options.vscodeExecutablePath,
    extensionTestsEnv: {
      [INTEGRATION_RESULT_DIR_ENV]: resultDirectory,
      ...options.env
    },
    launchArgs: [
      options.workspaceArg,
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
      '--disable-extensions',
      '--new-window'
    ]
  });
  return readSuccessfulIntegrationHostResult(resultDirectory).executed;
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

    // Counted here as well as in `index.ts` because the split is what this file
    // owns: two launches that each run a subset have to account for every
    // module between them, and only the caller can check that.
    const discovered = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(HOST_TEST_SUFFIX)).length;
    if (discovered === 0) {
      throw new Error(
        `no ${HOST_TEST_SUFFIX} modules found under ${__dirname}. The host leg resolving nothing ` +
          `means the compile step did not emit, not that there is nothing to run.`
      );
    }

    // macOS limits Unix-domain socket paths to 103 bytes. Its os.tmpdir()
    // lives under a long /var/folders path, so use the stable short temp root
    // on Unix. Windows has no Unix-socket path limit and keeps its native temp.
    const temporaryRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const harnessDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'sg-it-'));
    const specifyDir = path.join(extensionDevelopmentPath, '.specify');
    const createdSpecifyDir = !fs.existsSync(specifyDir);
    if (createdSpecifyDir) fs.mkdirSync(specifyDir, { recursive: true });
    try {
      const singleFolderExecuted = await runPass({
        label: 'single-folder',
        extensionDevelopmentPath,
        extensionTestsPath,
        vscodeExecutablePath,
        harnessDirectory,
        workspaceArg: `--folder-uri=${toFileUri(extensionDevelopmentPath)}`,
        env: { SCHEGENT_INTEGRATION_EXCLUDE: MULTI_ROOT_MODULE }
      });

      const multiRootWorkspace = materializeMultiRootWorkspace(
        extensionDevelopmentPath,
        path.join(harnessDirectory, 'multi-root', 'workspace')
      );
      const multiRootExecuted = await runPass({
        label: 'multi-root',
        extensionDevelopmentPath,
        extensionTestsPath,
        vscodeExecutablePath,
        harnessDirectory,
        workspaceArg: `--file-uri=${toFileUri(multiRootWorkspace)}`,
        env: { SCHEGENT_INTEGRATION_FILTER: MULTI_ROOT_MODULE }
      });

      // The split must be exhaustive. An exclusion and a filter that disagree
      // would drop a module from BOTH passes, and two green launches over 12 of
      // 13 modules is exactly the "passed" that means nothing.
      const executed = singleFolderExecuted + multiRootExecuted;
      if (executed !== discovered) {
        throw new Error(
          `the two launches executed ${executed} of ${discovered} discovered host-test module(s) ` +
            `(single-folder ${singleFolderExecuted}, multi-root ${multiRootExecuted}). The pass ` +
            `split has to account for every module: check ${MULTI_ROOT_MODULE} still names exactly ` +
            `the module the multi-root launch is for.`
        );
      }
      console.log(
        `Integration host completed ${executed} test modules across 2 launches ` +
          `(single-folder ${singleFolderExecuted}, multi-root ${multiRootExecuted}).`
      );
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
