// FR-R3-200 — `invokedAsScript` answers true when Node was started on the module by any path
// to its file, and only then.
//
// The defect was a comparison of a module URL, which is percent-encoded and names the file with
// its symlinks resolved, with a start path that is neither. Started from a plain path the two
// agree, so a test that starts a script that way proves nothing about it. This one builds the
// fixture where both differences bite: a directory whose name holds a space and an accented
// letter, which a URL encodes, and a symlink to it, which a module URL resolves and a start path
// does not. Every start runs in a child process, because the answer depends on how Node was
// started and a test cannot restart the process it runs in.
//
// A script on the old comparison runs in the same fixture as a control. It must stay silent,
// which is the evidence that the fixture would have caught the defect.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The module under test, copied into the fixture so it is imported from there. */
const SHARED_MODULE = resolve(REPO_ROOT, 'scripts', 'invoked-as-script.mjs');

/** What a script prints when it believes it was started. */
const MARKER = 'entry ran';

/** A script on the shared function. */
const ENTRY = [
  "import { invokedAsScript } from './invoked-as-script.mjs';",
  `if (invokedAsScript(import.meta.url)) console.log('${MARKER}');`,
  ''
].join('\n');

/** The comparison the secret scan used to end with. */
const RAW_ENTRY =
  "if (import.meta.url === `file://${process.argv[1]}`) console.log('" + MARKER + "');\n";

/** A script that only imports the one above. */
const IMPORTER = "import './entry.mjs';\n";

/** A child still running after this is killed, so a hung start fails its case, not the run. */
const CHILD_TIMEOUT_MS = 30_000;

type Outcome = [status: number | null, stdout: string, stderr: string];

let root = '';
let dir = '';

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'invoked-as-script-'));
  dir = join(root, 'dir with space é');
  mkdirSync(dir);
  copyFileSync(SHARED_MODULE, join(dir, 'invoked-as-script.mjs'));
  writeFileSync(join(dir, 'entry.mjs'), ENTRY);
  writeFileSync(join(dir, 'raw-entry.mjs'), RAW_ENTRY);
  writeFileSync(join(dir, 'importer.mjs'), IMPORTER);
  symlinkSync(dir, join(root, 'linked'), 'dir');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runNode(args: readonly string[]): Outcome {
  const run = spawnSync('node', args, { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  return [run.status, run.stdout, run.stderr];
}

/**
 * Print `expression` from a module that has imported the function. `startArg` becomes
 * `process.argv[1]`, which is how a `-e` evaluation is given a start path; without one it has
 * none.
 */
function evaluate(expression: string, startArg?: string): Outcome {
  const sharedUrl = pathToFileURL(join(dir, 'invoked-as-script.mjs')).href;
  const code = [
    `import { invokedAsScript } from ${JSON.stringify(sharedUrl)};`,
    `console.log(${expression});`
  ].join('\n');
  const extra = startArg === undefined ? [] : [startArg];
  return runNode(['--input-type=module', '-e', code, ...extra]);
}

describe('invokedAsScript is true for a script started by any path to it, and false otherwise (FR-R3-200)', () => {
  it('builds a fixture where the module URL and the start path differ in both ways', () => {
    expect(realpathSync(dir)).toBe(dir);
    expect(pathToFileURL(dir).href).not.toBe(`file://${dir}`);
    expect(realpathSync(join(root, 'linked'))).toBe(dir);
  });

  it('answers true for a start on the module, by a path a URL encodes', () => {
    expect(runNode([join(dir, 'entry.mjs')])).toEqual([0, `${MARKER}\n`, '']);
  });

  it('answers true for a start through a symlinked directory', () => {
    expect(runNode([join(root, 'linked', 'entry.mjs')])).toEqual([0, `${MARKER}\n`, '']);
  });

  it('answers true for a start through a symlink that Node keeps in the module URL', () => {
    // `--preserve-symlinks-main` leaves the symlink in `import.meta.url`, so the answer is true
    // only if the URL is resolved as well as the start path.
    const start = ['--preserve-symlinks-main', join(root, 'linked', 'entry.mjs')];
    expect(runNode(start)).toEqual([0, `${MARKER}\n`, '']);
  });

  it('answers false when the module is only imported by the script that was started', () => {
    expect(runNode([join(dir, 'importer.mjs')])).toEqual([0, '', '']);
  });

  it('answers false when there is no start path', () => {
    const entryUrl = pathToFileURL(join(dir, 'entry.mjs')).href;
    expect(evaluate(`invokedAsScript(${JSON.stringify(entryUrl)})`)).toEqual([0, 'false\n', '']);
  });

  it('answers false, without throwing, when the start path cannot be resolved', () => {
    const entryUrl = pathToFileURL(join(dir, 'entry.mjs')).href;
    expect(
      evaluate(`invokedAsScript(${JSON.stringify(entryUrl)})`, join(dir, 'missing.mjs'))
    ).toEqual([0, 'false\n', '']);
  });

  it('answers false, without throwing, for a URL that names nothing or is not a file URL', () => {
    const urls = [
      pathToFileURL(join(dir, 'missing.mjs')).href,
      'data:text/javascript,0',
      pathToFileURL(join(dir, 'entry.mjs')).href
    ];
    const expression = `JSON.stringify(${JSON.stringify(urls)}.map(url => invokedAsScript(url)))`;
    expect(evaluate(expression, join(dir, 'entry.mjs'))).toEqual([0, '[false,false,true]\n', '']);
  });

  it('leaves the old comparison silent in this fixture, which is the defect', () => {
    expect(runNode([join(dir, 'raw-entry.mjs')])).toEqual([0, '', '']);
  });
});
