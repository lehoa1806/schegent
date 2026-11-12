// Review gap GC-22 (2026-11-12) — a clean clone that skips the webview install is told what to run.
//
// WHAT THIS PINS:
//   - `.npmrc` sets `ignore-scripts=true`, so the root `postinstall` that installs `webview-ui/`
//     never runs, and a contributor who stops after `npm ci` reached a `vite` failure that did
//     not mention installing. The preflight names the missing install and the command;
//   - it runs inside `build:webview` itself: `ignore-scripts` disables npm's `pre` hooks too, so a
//     `prebuild:webview` script would never run either;
//   - an installed tree is silent.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

async function loadPreflight() {
  return import('../../../scripts/check-webview-install.mjs');
}

let preflight: Awaited<ReturnType<typeof loadPreflight>>;
const created: string[] = [];

beforeAll(async () => {
  preflight = await loadPreflight();
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(withVite: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'gc22-'));
  created.push(root);
  mkdirSync(join(root, 'webview-ui'), { recursive: true });
  if (withVite) {
    mkdirSync(join(root, 'webview-ui', 'node_modules', 'vite'), { recursive: true });
    writeFileSync(join(root, 'webview-ui', 'node_modules', 'vite', 'package.json'), '{"name":"vite"}');
  }
  return root;
}

describe('GC-22 — the webview install preflight', () => {
  it('reports nothing when the webview dependencies are installed', () => {
    expect(preflight.webviewInstallProblem(tree(true))).toBeNull();
  });

  it('names the missing install and the command that fixes it', () => {
    const problem = preflight.webviewInstallProblem(tree(false));

    expect(problem).toContain('webview-ui');
    expect(problem).toContain('ignore-scripts');
    expect(problem).toContain(preflight.WEBVIEW_INSTALL_COMMAND);
  });

  it('names the documented install command', () => {
    expect(preflight.WEBVIEW_INSTALL_COMMAND).toBe('npm --prefix webview-ui ci');
  });

  it('runs first in build:webview, chained so a failure stops the build', () => {
    const scripts = new Map(Object.entries((JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts));

    expect(scripts.get('build:webview')).toBe('node scripts/check-webview-install.mjs && npm --prefix webview-ui run build');
  });
});
