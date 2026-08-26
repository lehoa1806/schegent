import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-101 (FR-028) — the debugger's `outFiles` names the directory the bundler writes.
 *
 * THE TRAP. `.vscode/launch.json` set `outFiles: ["${workspaceFolder}/out/**\/*.js"]` while the
 * extension host bundles to `dist/extension.js`. `out/` is the integration-test compile target
 * (`tsconfig.integration.json`). So F5 started the Extension Development Host, VS Code looked
 * for source maps under `out/`, and breakpoints set anywhere in `src/` never bound — with no
 * error, because nothing is wrong with looking in a directory that happens to contain other
 * JavaScript.
 *
 * WHY THIS IS A TEST AND NOT A ONE-LINE FIX. The two files are edited by different people for
 * different reasons: someone changing the bundle layout has no reason to open a launch
 * configuration. That is exactly the drift shape `FR-R3-101` is about, so the check reads BOTH
 * and compares — it does not hardcode `dist`.
 *
 * WHAT THIS CANNOT ESTABLISH (spec B4): that F5 actually hits a breakpoint. That needs an
 * interactive VS Code session, which this environment does not have. What it establishes is
 * that the *cause* of the trap is closed and pinned.
 */
const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** `launch.json` permits comments, so it is not `JSON.parse`-able as written. */
function outFileGlobs(): readonly string[] {
  const source = read('.vscode/launch.json');
  const match = /"outFiles"\s*:\s*\[([^\]]*)\]/.exec(source);
  expect(match, '.vscode/launch.json must declare outFiles').not.toBeNull();
  return [...(match as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** The directory `esbuild.config.mjs` actually writes the host bundle into. */
function bundleDir(): string {
  const source = read('esbuild.config.mjs');
  const match = /outfile:\s*'([^']+)'/.exec(source);
  expect(match, 'esbuild.config.mjs must declare an outfile').not.toBeNull();
  const outfile = (match as RegExpExecArray)[1];
  return outfile.split('/')[0] as string;
}

describe('FR-R3-101 — the debugger looks where the bundler writes', () => {
  it('every outFiles glob points at the bundler output directory', () => {
    const dir = bundleDir();
    const globs = outFileGlobs();
    expect(globs.length, 'outFiles must not be empty').toBeGreaterThan(0);
    for (const glob of globs) {
      expect(
        glob,
        `launch.json looks in "${glob}" but esbuild writes to "${dir}/". F5 breakpoints set ` +
          'in src/ will never bind, and nothing will say why.'
      ).toContain(`/${dir}/`);
    }
  });

  it('does NOT look in the integration-test compile target', () => {
    // The specific wrong answer this had. `out/` is populated by
    // `tsconfig.integration.json`, so it contains plausible JavaScript and plausible source
    // maps — which is why the misconfiguration presented as "breakpoints just do not work"
    // rather than as an error.
    const integration = JSON.parse(
      read('tsconfig.integration.json').replace(/^\s*\/\/.*$/gm, '')
    ) as { compilerOptions?: { outDir?: string } };
    const integrationDir = (integration.compilerOptions?.outDir ?? 'out').replace(/^\.\//, '');
    expect(integrationDir).not.toBe(bundleDir());
    for (const glob of outFileGlobs()) {
      expect(glob).not.toContain(`/${integrationDir}/`);
    }
  });

  it('the preLaunchTask situation is documented, since no tasks.json exists', () => {
    // `launch.json` names a `preLaunchTask` and there is no checked-in task file; VS Code
    // satisfies it from auto-detected npm tasks. That is worth one honest sentence rather than
    // a document claiming a task file or denying the launch file — both of which existed.
    const launch = read('.vscode/launch.json');
    if (!launch.includes('preLaunchTask')) return;
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('tasks.json');
    expect(contributing.toLowerCase()).toContain('auto-detect');
  });

  it('NON-VACUITY: a glob naming the wrong directory is detected', () => {
    const dir = bundleDir();
    expect(`\${workspaceFolder}/out/**/*.js`.includes(`/${dir}/`)).toBe(false);
    expect(`\${workspaceFolder}/${dir}/**/*.js`.includes(`/${dir}/`)).toBe(true);
  });
});
