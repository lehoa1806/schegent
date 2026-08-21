// Feature 112 (FR-026, plan D16) — the linter parses against the compiler that builds.
//
// `svelte` became a root devDependency because `eslint-plugin-svelte`'s recommended
// set loads rule modules that import the Svelte compiler, so linting the webview from
// the root needs `svelte` resolvable there. That created a second declaration of the
// same compiler in a repository that installs its two trees separately — root
// `npm install` and the `postinstall` that runs `npm --prefix webview-ui install`.
//
// Two declarations of one compiler drift silently and in the worst direction: the
// linter parses components with one version while `build:webview` compiles them with
// another. Nothing fails. The rules simply stop matching the syntax the app actually
// ships — new syntax parses as an error in the linter, or retired syntax stops being
// flagged — and the tree looks linted while the gate is reading a different language
// than the compiler.
//
// So the ranges must be byte-identical, which is what the comment on
// createWebviewConfig in scripts/lint-config.mjs promises, and a bump has to touch
// both manifests or fail here.
//
// Installed versions are checked at major granularity, not exactly. The two trees run
// their own `npm install` against the same caret range at different times, so
// 5.55.7 in one and 5.56.10 in the other is ordinary npm behaviour and not a defect.
// A major apart is a different language, and that is what this catches.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_ROOT = resolve(REPO_ROOT, 'webview-ui');

interface Manifest {
  readonly devDependencies?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly version?: string;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function declaredSvelte(manifestPath: string): string | undefined {
  const manifest = readManifest(manifestPath);
  return manifest.devDependencies?.svelte ?? manifest.dependencies?.svelte;
}

/**
 * The version a tree would actually load. A tree with no copy of its own resolves the
 * root's, in which case parity holds by construction.
 */
function installedSvelte(treeRoot: string): string {
  const own = resolve(treeRoot, 'node_modules', 'svelte', 'package.json');
  const path = existsSync(own)
    ? own
    : resolve(REPO_ROOT, 'node_modules', 'svelte', 'package.json');
  return readManifest(path).version ?? 'unknown';
}

function major(version: string): string {
  return version.replace(/^[^\d]*/, '').split('.')[0] ?? '';
}

const ROOT_MANIFEST = resolve(REPO_ROOT, 'package.json');
const WEBVIEW_MANIFEST = resolve(WEBVIEW_ROOT, 'package.json');

describe('Feature 112 svelte version parity', () => {
  it('both manifests declare svelte, so this gate is not vacuous', () => {
    expect(declaredSvelte(ROOT_MANIFEST), 'package.json declares no svelte').toBeDefined();
    expect(
      declaredSvelte(WEBVIEW_MANIFEST),
      'webview-ui/package.json declares no svelte'
    ).toBeDefined();
  });

  it('declares the same range in both manifests', () => {
    const root = declaredSvelte(ROOT_MANIFEST);
    const webview = declaredSvelte(WEBVIEW_MANIFEST);
    expect(
      root,
      `package.json declares svelte ${String(root)} and webview-ui/package.json ` +
        `declares ${String(webview)}. The root copy exists only so the linter can parse ` +
        `components; parsing them against a different compiler than build:webview uses ` +
        `is the whole failure this gate prevents. Bump both, or neither.`
    ).toBe(webview);
  });

  it('installs the same major in both trees', () => {
    const root = installedSvelte(REPO_ROOT);
    const webview = installedSvelte(WEBVIEW_ROOT);
    expect(
      major(root),
      `the linter would parse with svelte ${root} and the webview builds with ` +
        `${webview}. A major apart is a different component language: the rules stop ` +
        `matching the syntax the app ships, and nothing else reports it.`
    ).toBe(major(webview));
  });
});
