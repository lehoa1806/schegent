// Feature 112 (FR-002, SC-003): no two npm scripts may share a body.
//
// The defect this exists to prevent: `webview-ui`'s `lint` and `typecheck` were
// byte-identical — both `svelte-check --tsconfig ./tsconfig.json` — so the webview
// "lint" gate was a second type check, and the tree went unlinted while every gate
// reported green. A duplicated body is how a gate stops testing what its name says
// without anybody having to remove it.
//
// An alias is exempt: a script whose body is exactly `npm run <other>` is declaring
// a second name for one gate on purpose, which is the opposite of the defect.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MANIFESTS = [
  resolve(REPO_ROOT, 'package.json'),
  resolve(REPO_ROOT, 'webview-ui', 'package.json')
];

const ALIAS = /^npm run [\w:-]+$/;

function readScripts(manifestPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts;
  return scripts ?? {};
}

describe('Feature 112 npm script bodies are distinct', () => {
  for (const manifestPath of MANIFESTS) {
    const label = relative(REPO_ROOT, manifestPath);

    it(`${label} declares no two non-alias scripts with the same body`, () => {
      const byBody = new Map<string, string[]>();
      for (const [name, body] of Object.entries(readScripts(manifestPath))) {
        const normalised = body.trim();
        if (ALIAS.test(normalised)) continue;
        byBody.set(normalised, [...(byBody.get(normalised) ?? []), name]);
      }

      const duplicates = [...byBody.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([body, names]) => `${names.join(' + ')} both run: ${body}`);

      expect(
        duplicates,
        `${label} has scripts sharing a body; one of them is not testing what its ` +
          `name says:\n  ${duplicates.join('\n  ')}`
      ).toEqual([]);
    });

    it(`${label} declares at least one script, so this gate is not vacuous`, () => {
      expect(Object.keys(readScripts(manifestPath)).length).toBeGreaterThan(0);
    });
  }
});
