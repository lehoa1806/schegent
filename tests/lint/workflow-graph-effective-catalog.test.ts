// Feature 083 (US3, T043) — lint regression: every `validateWorkflowGraph(...)`
// call site under `src/` MUST pass the **effective** Pipeline catalog as its
// second argument, never a raw source layer, an unresolved row set, or a
// `readPipelineConfig()` result.
//
// Why a lint gate rather than a behavioral test: the defect this guards against
// is silent. Handing the validator a raw `user`/`workspace` layer still
// type-checks (both are `PipelineDefinition[]`-shaped at the call site) and
// still validates *something* — it just validates against a definition that
// higher-precedence resolution has already discarded. A Workflow would then be
// accepted on the strength of a Pipeline runtime will never resolve, which is
// exactly the failure US3 exists to prevent.
//
// This mirrors the CLAUDE.md hard rule pinning Pipeline bindings against the
// effective Phase catalog, and follows the scanning discipline of
// tests/lint/no-direct-first-workspace-folder.test.ts.
//
// To resolve a failure: resolve the catalog first
// (`resolvePipelineCatalog(...).effective`) and pass that, or pass a value
// whose name ends in `.effective`.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

/**
 * The second argument must be one of these. `pipelines.effective` /
 * `catalog.effective` are the resolved forms; a bare `effectivePipelines`
 * parameter is how the validator's own helpers thread it downward.
 */
const ACCEPTED_ARGUMENT = /^(?:[A-Za-z0-9_$.]*\.effective|effectivePipelines|effective)$/;

/** Reading configuration at a call site means the layer was never resolved. */
const RAW_LAYER_MARKERS = [
  'readPipelineConfig',
  '.user',
  '.workspace',
  '.records',
  'pipelineLayers'
] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (full.endsWith('.ts')) found.push(full);
  }
  return found;
}

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly secondArgument: string;
}

/**
 * Extracts the second argument of each call by balanced-paren scanning rather
 * than a regex, so a call spread over several lines is read correctly instead
 * of being silently skipped — a skipped call site is an unguarded one.
 */
function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of sourceFiles(SCAN_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file);
    let cursor = text.indexOf('validateWorkflowGraph(');
    while (cursor !== -1) {
      // Skip the declaration itself; only invocations are call sites.
      const precedingLineStart = text.lastIndexOf('\n', cursor) + 1;
      const preceding = text.slice(precedingLineStart, cursor);
      if (/(?:function|const|let|var)\s*$/.test(preceding) || /export\s+$/.test(preceding)) {
        cursor = text.indexOf('validateWorkflowGraph(', cursor + 1);
        continue;
      }

      const open = cursor + 'validateWorkflowGraph('.length;
      let depth = 1;
      let index = open;
      const args: string[] = [];
      let current = '';
      while (index < text.length && depth > 0) {
        const char = text[index];
        if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
        if (depth === 0) break;
        if (char === ',' && depth === 1) {
          args.push(current);
          current = '';
        } else {
          current += char;
        }
        index += 1;
      }
      args.push(current);

      if (args.length >= 2) {
        sites.push({
          file: rel,
          line: text.slice(0, cursor).split('\n').length,
          secondArgument: args[1].replace(/\/\/[^\n]*/g, '').trim()
        });
      }
      cursor = text.indexOf('validateWorkflowGraph(', index);
    }
  }
  return sites;
}

describe('Feature 083 T043 — validateWorkflowGraph takes only the effective Pipeline catalog', () => {
  it('finds the call sites it is meant to guard', () => {
    // Guards the scanner: a parser change that silently matched nothing would
    // turn every assertion below into a vacuous pass.
    const sites = callSites();
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((site) => site.file)).toContain(
      'src/ui/sidebar/commands/cmd-save-workflows.ts'
    );
    expect(sites.map((site) => site.file)).toContain('src/config/workflow-catalog.ts');
  });

  it('passes an effective catalog at every call site', () => {
    const offenders = callSites().filter((site) => !ACCEPTED_ARGUMENT.test(site.secondArgument));
    expect(
      offenders.map((site) => `${site.file}:${site.line} -> ${site.secondArgument}`),
      'each call must pass a `.effective` catalog; resolve the layers first'
    ).toEqual([]);
  });

  it.each([
    'pipelines.user',
    'pipelines.workspace',
    'catalog.records',
    'readPipelineConfig().workspace',
    'pipelineLayers',
    'rows',
    'effectivePhases'
  ])('rejects %s as a second argument', (argument) => {
    // Proves the matcher discriminates. A gate whose predicate accepts
    // everything passes forever and guards nothing.
    expect(ACCEPTED_ARGUMENT.test(argument)).toBe(false);
  });

  it.each(['pipelines.effective', 'catalog.effective', 'effectivePipelines', 'effective'])(
    'accepts %s as a second argument',
    (argument) => {
      expect(ACCEPTED_ARGUMENT.test(argument)).toBe(true);
    }
  );

  it('never passes a raw source layer or an unresolved row set', () => {
    const offenders = callSites().filter((site) =>
      RAW_LAYER_MARKERS.some((marker) => site.secondArgument.includes(marker))
    );
    expect(
      offenders.map((site) => `${site.file}:${site.line} -> ${site.secondArgument}`),
      'a raw layer bypasses precedence and validates against a discarded definition'
    ).toEqual([]);
  });
});
