// Feature 112 (FR-012, SC-006) — type information still reaches inside a component.
//
// The webview's type-aware rules depend on a three-link chain: svelte-eslint-parser
// parses the component, delegates the script to `tseslint.parser`, and that binds to
// the webview's own TypeScript program. Break any link — a plugin major that changes
// how the delegated parser is configured, a `tsconfig.json` whose `include` stops
// covering `src`, a missing `extraFileExtensions: ['.svelte']` — and the failure mode
// is not an error. It is silence: the rules keep running, find nothing because they
// have no types to reason about, and every gate goes green over an unlinted tree.
// That is the exact shape of the defect this feature was opened to fix, where `lint`
// for this tree was a second type check and nothing linted it at all.
//
// So the assertion is positive, not an absence: a floating promise inside a
// rune-using component MUST be reported. `no-floating-promises` cannot fire without
// type information — there is no syntactic tell that `bump()` returns a promise — so
// its report is proof the program was reachable from inside `$state`/`$derived` code.
// The control case, the same component with `void` in front of the call, must report
// nothing: a gate that would pass on any input proves nothing about this one.
//
// The probe is linted at the path of a real component, with text supplied in place of
// the file's own, which is how an editor lints an unsaved buffer. Writing a temporary
// component into `webview-ui/src` instead would put a file with a deliberate defect
// into the tree while the rest of this suite runs in parallel over it.
import { readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_ROOT = resolve(REPO_ROOT, 'webview-ui');

/** The rule that can only fire with type information. */
const TYPE_AWARE_RULE = '@typescript-eslint/no-floating-promises';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage']);

/**
 * Any real component, found rather than named. The probe's text replaces this file's
 * content; only its path matters, and that path must be one the webview's TypeScript
 * project includes — which is the thing under test.
 */
function findComponent(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const found = findComponent(absolute);
      if (found !== null) return found;
      continue;
    }
    if (extname(absolute) === '.svelte') return absolute;
  }
  return null;
}

/** Runes, and a promise nothing handles. */
const FLOATING = `<script lang="ts">
  let count = $state(0);
  const doubled = $derived(count * 2);
  async function bump(): Promise<void> { count += 1; }
  function onClick(): void { bump(); }
</script>
<button onclick={onClick}>{count}/{doubled}</button>
`;

/** The same component with the discard made explicit. */
const HANDLED = FLOATING.replace('{ bump(); }', '{ void bump(); }');

let eslint: ESLint;
let probe: string;

beforeAll(async () => {
  // Computed specifier: the configuration is `.mjs` with no declaration file and this
  // tree does not set `allowJs`, so a literal one would fail `typecheck:tests` on the
  // import rather than on anything this gate is about.
  const specifier = pathToFileURL(resolve(REPO_ROOT, 'scripts', 'lint-config.mjs')).href;
  const config = (await import(specifier)) as {
    createWebviewConfig: () => Promise<unknown[]>;
  };

  const found = findComponent(resolve(WEBVIEW_ROOT, 'src'));
  expect(found, 'no .svelte file under webview-ui/src to probe').not.toBeNull();
  probe = found as string;

  eslint = new ESLint({
    cwd: WEBVIEW_ROOT,
    overrideConfigFile: true,
    overrideConfig: (await config.createWebviewConfig()) as ESLint.Options['overrideConfig']
  });
}, 60_000);

async function lint(text: string): Promise<ESLint.LintResult[]> {
  return eslint.lintText(text, { filePath: probe });
}

describe('Feature 112 type information reaches rune-using components', () => {
  it('reports a floating promise inside a component that uses runes', async () => {
    const messages = (await lint(FLOATING)).flatMap(result => result.messages);
    const fatal = messages.filter(message => message.fatal === true);
    expect(
      fatal.map(message => `${String(message.line)}: ${message.message}`),
      'the probe component did not parse, so this gate cannot say anything about types'
    ).toEqual([]);

    const floating = messages.filter(message => message.ruleId === TYPE_AWARE_RULE);
    expect(
      floating.length,
      `${TYPE_AWARE_RULE} reported nothing on a component that floats a promise. That ` +
        `rule cannot fire without type information, so the parser chain — ` +
        `svelte-eslint-parser to tseslint.parser to the webview's TypeScript program — ` +
        `is no longer delivering it. Every type-aware rule in this tree is now finding ` +
        `nothing for the same reason, silently.`
    ).toBeGreaterThan(0);
    expect(floating[0]?.severity, `${TYPE_AWARE_RULE} must be at error`).toBe(2);
  });

  it('reports nothing when the same component discards the promise explicitly', async () => {
    const messages = (await lint(HANDLED)).flatMap(result => result.messages);
    expect(
      messages.map(message => `${String(message.ruleId)} at ${String(message.line)}`),
      'the control case must be clean, or the assertion above is not evidence of anything'
    ).toEqual([]);
  });
});
