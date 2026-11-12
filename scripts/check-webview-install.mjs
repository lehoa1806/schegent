#!/usr/bin/env node
// Review gap GC-22 (2026-11-12) — say what to run when the webview dependencies are missing.
//
// `.npmrc` sets `ignore-scripts=true`, so the root `postinstall` that installs `webview-ui/` never
// runs: a clean clone needs a second, explicit install (CONTRIBUTING.md, "Install"). A contributor
// who stopped after the root `npm ci` reached a `vite` failure that did not mention installing.
//
// It runs as the first command of `build:webview`, not as a `prebuild:webview` hook:
// `ignore-scripts` disables npm's `pre`/`post` hooks as well, so a hook would never run.
//
// One filesystem check. Installed: silence, exit 0. Missing: one message naming the command,
// exit 1. It never installs: an install reaches the registry, and the build should not.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedAsScript } from './invoked-as-script.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The documented install for the webview package, as CONTRIBUTING.md states it. */
export const WEBVIEW_INSTALL_COMMAND = 'npm --prefix webview-ui ci';

/** A package the webview build cannot start without; its manifest marks an installed tree. */
const MARKER = join('webview-ui', 'node_modules', 'vite', 'package.json');

/** `null` when the webview dependencies are installed under `root`; otherwise what to run. */
export function webviewInstallProblem(root = ROOT) {
  if (existsSync(join(root, MARKER))) return null;
  return (
    `The webview dependencies are not installed (${MARKER} is missing). ` +
    'The root postinstall that would install them does not run, because .npmrc sets ' +
    `ignore-scripts=true. Run: ${WEBVIEW_INSTALL_COMMAND}`
  );
}

if (invokedAsScript(import.meta.url)) {
  const problem = webviewInstallProblem();
  if (problem !== null) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  }
}
