import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import {
  findCompletionMarker,
  INTEGRATION_RESULT_DIR_ENV,
  INTEGRATION_USER_DATA_DIR_ENV,
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

/**
 * FR-R3-136 (T1527c, T1527d) — the two modules that need Workspace Trust to be a
 * live feature rather than a switched-off one.
 *
 * One fixture, two launches, one variable: whether VS Code's trust feature is
 * enabled. `trust-untrusted` opens a folder the profile has never trusted with the
 * feature ON, which is the only configuration in which `workspace.isTrusted` is
 * `false`; `trust-granted` opens a fresh copy of the same fixture with the feature
 * disabled, so every act the first launch must not perform is observed happening.
 * The second launch is not a bonus — it is what makes the first launch's list of
 * absences evidence of a refusal rather than of a broken harness.
 */
const UNTRUSTED_MODULE = 'trust-untrusted';
const TRUSTED_MODULE = 'trust-granted';

/** The tracked folder both trust launches open a private copy of. */
const UNTRUSTED_FIXTURE = path.join('tests', 'integration', 'fixtures', 'untrusted-workspace');

/**
 * The sentinel's filename inside the fixture, and the three settings it is
 * installed for.
 *
 * All three are `application`-scoped (FR-015), so USER scope is the only scope a
 * value of theirs can arrive in — which is exactly why the sentinel proves
 * something. A workspace-scoped sentinel would never be consulted and its silence
 * would mean nothing at all.
 */
const SENTINEL_SCRIPT = 'no-spawn-sentinel.sh';
const SENTINEL_SETTINGS = Object.freeze([
  'schegent.cli.path',
  'schegent.codex.path',
  'schegent.agy.path'
]);

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

interface TrustFixture {
  /** The folder the launch opens. */
  readonly workspaceDirectory: string;
  /** The sentinel, outside that folder. */
  readonly sentinelPath: string;
}

/**
 * Materialize the tracked untrusted-workspace fixture for one launch.
 *
 * Copied rather than opened for the same reason the multi-root shape is: an
 * activation writes `.schegent/` into the folder it is given, so opening the
 * tracked fixture would dirty the working tree on every integration run — and
 * here it would do worse than that, since the untrusted leg's whole claim is
 * about which files exist under `.schegent/` afterwards. A fixture carrying
 * yesterday's run's output could not decide that.
 *
 * The sentinel is deliberately lifted OUT of the copied folder. Its marker file
 * is written beside the script, and a marker inside the workspace would be a file
 * the extension appears to have written into the workspace — the exact thing the
 * leg's other assertions are counting. Outside, the two questions stay separate.
 *
 * The fixture's pieces are checked here rather than assumed. Each one is an
 * assertion in both legs, so a fixture quietly gutted to a bare directory would
 * turn a decisive pair of launches into two green launches that test nothing.
 */
function materializeTrustFixture(repoRoot: string, into: string): TrustFixture {
  const source = path.join(repoRoot, UNTRUSTED_FIXTURE);
  const required = [
    path.join('.specify', 'README.md'),
    path.join('.vscode', 'settings.json'),
    SENTINEL_SCRIPT
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(source, rel)));
  if (missing.length > 0) {
    throw new Error(
      `${UNTRUSTED_FIXTURE} is missing ${missing.join(', ')}. Every file in that fixture is an ` +
        `assertion in both trust launches — see its README — so a missing one is a launch that ` +
        `cannot decide what it claims to.`
    );
  }

  const workspaceDirectory = path.join(into, 'workspace');
  const sentinelDirectory = path.join(into, 'sentinel');
  fs.mkdirSync(sentinelDirectory, { recursive: true, mode: 0o700 });
  fs.cpSync(source, workspaceDirectory, { recursive: true });

  const sentinelPath = path.join(sentinelDirectory, SENTINEL_SCRIPT);
  fs.copyFileSync(path.join(workspaceDirectory, SENTINEL_SCRIPT), sentinelPath);
  fs.chmodSync(sentinelPath, 0o755);
  fs.rmSync(path.join(workspaceDirectory, SENTINEL_SCRIPT), { force: true });
  // The README documents the fixture for a reader; it is not workspace content
  // either launch needs, and leaving it out keeps the "what did the extension
  // write here" comparison to files that mean something.
  fs.rmSync(path.join(workspaceDirectory, 'README.md'), { force: true });

  return { workspaceDirectory, sentinelPath };
}

/**
 * The profile both trust launches start from.
 *
 * `startupPrompt`/`banner` at `never` because a modal asking a human whether to
 * trust the folder has no human to ask in a headless launch, and the answer this
 * leg needs is "nobody trusted it". The three sentinel settings are `application`
 * scope, so this file is the only place a value for them can come from.
 */
function trustPassUserSettings(sentinelPath: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'security.workspace.trust.untrustedFiles': 'open'
  };
  for (const key of SENTINEL_SETTINGS) settings[key] = sentinelPath;
  return settings;
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
  /**
   * `'disabled'` passes `--disable-workspace-trust`, which is what every host
   * launch did before FR-R3-136 and what the two pre-existing passes still do.
   * `'live'` omits it, so the profile's never-trusted folder opens UNTRUSTED.
   */
  readonly workspaceTrust: 'live' | 'disabled';
  /** Written to this pass's `User/settings.json` before launch. */
  readonly userSettings?: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Spawn one VS Code launch and resolve when it exits zero.
 *
 * WHY THIS IS NOT `runTests` FROM `@vscode/test-electron`. That helper appends
 * `--disable-workspace-trust` to every launch it makes, unconditionally, and
 * PREPENDS the caller's `launchArgs` — and VS Code parses argv with minimist,
 * where a declared boolean is last-wins. So a caller cannot switch the trust
 * feature back on: the helper's flag always arrives after anything the caller
 * says. The shipped workbench leaves no other route either, because
 * `isWorkspaceTrustEnabled()` short-circuits on `environmentService
 * .disableWorkspaceTrust`, and that getter is `!!this.args['disable-workspace
 * -trust']` and nothing else — no setting overrides it.
 *
 * The consequence is worth stating plainly: until this change every host-leg
 * assertion this repository has ever made was made in a window with Workspace
 * Trust switched OFF. That is a fine setting for the twelve modules that are not
 * about trust, and it is the one setting in which FR-R3-136's central claim cannot
 * be observed at all — `workspace.isTrusted` is unconditionally `true` there.
 *
 * So the argument vector is assembled here. It is the same list `runTests` builds
 * — the flags below are its flags — with the trust decision moved out of the
 * dependency and into the pass definition, where the rest of the workspace shape
 * already lives.
 */
function launchHost(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32';
    const child = cp.spawn(shell ? `"${executable}"` : executable, [...args], {
      env: { ...process.env, ...env },
      shell
    });
    // Unconditional: no `stdio` option is passed, so `spawn` returns a
    // `ChildProcessWithoutNullStreams` and both streams are there. An optional
    // chain here would read as "the host might have no output" and hide the real
    // case — a launch whose streams are gone is a launch that never started, and
    // `error` below is the event that reports it.
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    let settled = false;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (err) => settle(err));
    const onClosed = (code: number | null, signal: NodeJS.Signals | null): void => {
      console.log(`[integration] exit code: ${code ?? signal}`);
      settle(
        code === 0
          ? null
          : new Error(`VS Code exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
      );
    };
    child.on('close', onClosed);
    child.on('exit', onClosed);
  });
}

/** Run one launch of the host leg; returns how many modules it executed. */
async function runPass(options: PassOptions): Promise<number> {
  // Per-pass `user-data-dir`: a shared profile carries the previous launch's
  // window and workspace forward, so the second pass would reopen the first
  // pass's workspace and silently test the wrong shape. For the trust passes it
  // carries something further — a profile remembers which folders it has
  // trusted, so a shared one would trust the fixture on the first launch and the
  // untrusted pass would never see an untrusted window again.
  const passRoot = path.join(options.harnessDirectory, options.label);
  const resultDirectory = path.join(passRoot, 'results');
  const userDataDirectory = path.join(passRoot, 'user-data');
  const extensionsDirectory = path.join(passRoot, 'extensions');
  fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });

  if (options.userSettings) {
    const userDirectory = path.join(userDataDirectory, 'User');
    fs.mkdirSync(userDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(userDirectory, 'settings.json'),
      JSON.stringify(options.userSettings, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  console.log(
    `[integration] launch '${options.label}' with ${options.workspaceArg} ` +
      `(workspace trust ${options.workspaceTrust})`
  );
  await launchHost(
    options.vscodeExecutablePath,
    [
      options.workspaceArg,
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
      '--disable-extensions',
      '--new-window',
      // test-electron's own list, kept verbatim: sandbox and GPU-sandbox off for
      // CI containers, updates off so a launch cannot restart mid-run, and the
      // welcome/release-notes editors suppressed so the window opens on the
      // workspace rather than on a tab.
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      ...(options.workspaceTrust === 'disabled' ? ['--disable-workspace-trust'] : []),
      `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
      `--extensionTestsPath=${options.extensionTestsPath}`
    ],
    {
      [INTEGRATION_RESULT_DIR_ENV]: resultDirectory,
      // The `--user-data-dir` above, told to the leg running inside the window.
      // A host test cannot derive it: the flag is this function's private
      // decision, and `ConfigurationTarget.Global` is only checkable against the
      // file it lands in. See the constant's note in `vscode-test-executable.ts`.
      [INTEGRATION_USER_DATA_DIR_ENV]: userDataDirectory,
      ...options.env
    }
  );
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
    // owns: launches that each run a subset have to account for every module
    // between them, and only the caller can check that.
    const modules = fs.readdirSync(__dirname).filter((f) => f.endsWith(HOST_TEST_SUFFIX));
    const discovered = modules.length;
    if (discovered === 0) {
      throw new Error(
        `no ${HOST_TEST_SUFFIX} modules found under ${__dirname}. The host leg resolving nothing ` +
          `means the compile step did not emit, not that there is nothing to run.`
      );
    }

    // Each name that steers a launch must select exactly one module. The sum
    // check below catches a module that reaches no pass; this catches the other
    // half — a name that reaches TWO, which is what a rename produces when one
    // module's filename becomes a substring of another's. `trusted-workspace`
    // would have been such a name, since `untrusted-workspace` contains it, and
    // the launch built for one module would quietly have run both in the wrong
    // trust state.
    for (const name of [MULTI_ROOT_MODULE, UNTRUSTED_MODULE, TRUSTED_MODULE]) {
      const matched = modules.filter((f) => f.includes(name));
      if (matched.length !== 1) {
        throw new Error(
          `the pass name ${JSON.stringify(name)} matches ${matched.length} discovered host-test ` +
            `module(s) (${matched.join(', ') || 'none'}); it must match exactly one. Discovered: ` +
            `${modules.join(', ')}`
        );
      }
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
      const common = {
        extensionDevelopmentPath,
        extensionTestsPath,
        vscodeExecutablePath,
        harnessDirectory
      };
      const tally: { label: string; executed: number }[] = [];
      const record = async (options: PassOptions): Promise<void> => {
        tally.push({ label: options.label, executed: await runPass(options) });
      };

      await record({
        ...common,
        label: 'single-folder',
        workspaceArg: `--folder-uri=${toFileUri(extensionDevelopmentPath)}`,
        workspaceTrust: 'disabled',
        env: {
          SCHEGENT_INTEGRATION_EXCLUDE: [
            MULTI_ROOT_MODULE,
            UNTRUSTED_MODULE,
            TRUSTED_MODULE
          ].join(',')
        }
      });

      const multiRootWorkspace = materializeMultiRootWorkspace(
        extensionDevelopmentPath,
        path.join(harnessDirectory, 'multi-root', 'workspace')
      );
      await record({
        ...common,
        label: 'multi-root',
        workspaceArg: `--file-uri=${toFileUri(multiRootWorkspace)}`,
        workspaceTrust: 'disabled',
        env: { SCHEGENT_INTEGRATION_FILTER: MULTI_ROOT_MODULE }
      });

      // A private copy per launch, not one shared between them: the trusted
      // launch writes `.schegent/ownership/` into its workspace, and the whole
      // point of the untrusted launch is that its copy has none.
      const untrusted = materializeTrustFixture(
        extensionDevelopmentPath,
        path.join(harnessDirectory, 'trust-untrusted', 'fixture')
      );
      await record({
        ...common,
        label: 'trust-untrusted',
        workspaceArg: `--folder-uri=${toFileUri(untrusted.workspaceDirectory)}`,
        workspaceTrust: 'live',
        userSettings: trustPassUserSettings(untrusted.sentinelPath),
        env: { SCHEGENT_INTEGRATION_FILTER: UNTRUSTED_MODULE }
      });

      const granted = materializeTrustFixture(
        extensionDevelopmentPath,
        path.join(harnessDirectory, 'trust-granted', 'fixture')
      );
      await record({
        ...common,
        label: 'trust-granted',
        workspaceArg: `--folder-uri=${toFileUri(granted.workspaceDirectory)}`,
        workspaceTrust: 'disabled',
        userSettings: trustPassUserSettings(granted.sentinelPath),
        env: { SCHEGENT_INTEGRATION_FILTER: TRUSTED_MODULE }
      });

      // The split must be exhaustive. An exclusion and a filter that disagree
      // would drop a module from EVERY pass, and green launches over 14 of 15
      // modules is exactly the "passed" that means nothing.
      const executed = tally.reduce((sum, pass) => sum + pass.executed, 0);
      const breakdown = tally.map((pass) => `${pass.label} ${pass.executed}`).join(', ');
      if (executed !== discovered) {
        throw new Error(
          `the ${tally.length} launches executed ${executed} of ${discovered} discovered host-test ` +
            `module(s) (${breakdown}). The pass split has to account for every module: check the ` +
            `single-folder exclusion still names every module another launch is for.`
        );
      }
      console.log(
        `Integration host completed ${executed} test modules across ${tally.length} launches ` +
          `(${breakdown}).`
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
