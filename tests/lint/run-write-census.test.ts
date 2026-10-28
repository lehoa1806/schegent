// FR-R4-F01 (spec 239, US2, T022, research R3a, FR-008, FR-011) — the census of
// every whole-Run write.
//
// `WorkspaceStateStore.setRun` writes a WHOLE Run. That is right for creating a
// Run, removing one, replaying a journalled terminal outcome, migrating and
// resetting, and wrong for anything that reads a nonterminal Run outside the
// `KEYS.run` chain and writes back a subset of its fields: the write carries a
// snapshot, and whatever a concurrent writer put in the meantime is lost. Those
// go through `updateRun`, which patches the CURRENT Run inside the chain.
//
// This file makes the split countable, in the style of
// `tests/unit/state/unfenced-commit-inventory.test.ts`. Every `.setRun(` site in
// `src/` must be a row below, keyed by file and enclosing function (never by line
// number, which moves), with a class and a one-line reason. An unclassified site
// fails, and so does a row with no site, so adding a whole-Run write is a reviewed
// edit in two places. It also pins the closed label set `updateRun` accepts.
//
// There is no `reviewed-post-terminal` row: no site writes after a terminal state
// deliberately. A write that must would be added with its review recorded here.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RUN_UPDATE_LABELS } from '../../src/state/workspace-state';

const SRC = resolve(__dirname, '..', '..', 'src');

type SiteClass =
  | 'kept-whole: creation'
  | 'kept-whole: removal'
  | 'kept-whole: migration'
  | 'kept-whole: replay'
  | 'kept-whole: reset'
  | 'reviewed-post-terminal';

interface Row {
  readonly site: string;
  readonly class: SiteClass;
  readonly reason: string;
}

/** `file#Class.method`: the whole-Run writes that stay whole, and why. */
const KEPT_WHOLE: readonly Row[] = [
  {
    site: 'controller/workflow-controller.ts#SchegentWorkflowController.admitNew',
    class: 'kept-whole: creation',
    reason: 'writes a Run that did not exist a moment ago; there is no current Run to patch'
  },
  {
    site: 'queue/queue-manager.ts#QueueManager.clearRunSnapshots',
    class: 'kept-whole: removal',
    reason: 'removes the queue\'s entry (null); removal of an unknown id stays allowed'
  },
  {
    site: 'services/terminal-transition-coordinator.ts#TerminalTransitionCoordinator.projectInterrupted',
    class: 'kept-whole: replay',
    reason: 'writes the journalled terminal Run as it was; the intent, not a read, is its source'
  }
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** The nearest named function-like ancestor, as `Class.method`, `function` or `variable`. */
function enclosingFunction(node: ts.Node): string {
  for (let current = node.parent as ts.Node | undefined; current; current = current.parent as ts.Node | undefined) {
    if (ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current)) {
      const cls = current.parent;
      const owner = ts.isClassLike(cls) && cls.name ? `${cls.name.text}.` : '';
      const name = ts.isConstructorDeclaration(current) ? 'constructor' : current.name.getText();
      return `${owner}${name}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        return parent.name.getText();
      }
    }
  }
  return '<module>';
}

interface Call {
  readonly site: string;
  readonly call: ts.CallExpression;
}

/**
 * The receiver is the workspace state store: `store`, `this.store`, `deps.store`, `ctx.store`.
 * Another class may have a method of the same name (the sidebar's projector bookkeeping has an
 * `updateRun`), and a census of the store's writes must not read it.
 */
const STORE_RECEIVER = /(?:^|\.)store$/;

function callsTo(method: string): readonly Call[] {
  const found: Call[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === method &&
        STORE_RECEIVER.test(node.expression.expression.getText(source))
      ) {
        found.push({
          site: `${relative(SRC, file).split('\\').join('/')}#${enclosingFunction(node)}`,
          call: node
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const countBySite = (calls: readonly Call[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const { site } of calls) counts.set(site, (counts.get(site) ?? 0) + 1);
  return counts;
};

describe('the whole-Run write census (R3a)', () => {
  it('finds the control: the kept-whole rows are real sites', () => {
    // A scan that found nothing would pass every assertion below for the wrong reason.
    const sites = countBySite(callsTo('setRun'));
    expect(sites.size).toBeGreaterThan(0);
    for (const row of KEPT_WHOLE) expect(sites.has(row.site), row.site).toBe(true);
  });

  it('classifies every `setRun(` site in src, and leaves no row without a site', () => {
    const sites = countBySite(callsTo('setRun'));
    const classified = new Set(KEPT_WHOLE.map((row) => row.site));

    const unclassified = [...sites.keys()].filter((site) => !classified.has(site)).sort();
    const stale = [...classified].filter((site) => !sites.has(site)).sort();

    // An unclassified site is a whole-Run write nobody has reviewed. Convert it to
    // `updateRun` if it reads a nonterminal Run outside the chain and writes a
    // subset of its fields; otherwise add a row with its class and reason.
    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('gives each kept-whole row a class and a reason, once', () => {
    expect(new Set(KEPT_WHOLE.map((row) => row.site)).size).toBe(KEPT_WHOLE.length);
    for (const row of KEPT_WHOLE) {
      expect(row.reason.trim().length, row.site).toBeGreaterThan(0);
    }
  });

  it('keeps each kept-whole site to one write', () => {
    const sites = countBySite(callsTo('setRun'));
    for (const row of KEPT_WHOLE) expect(sites.get(row.site), row.site).toBe(1);
  });
});

describe('the field-update label set (contract C2)', () => {
  it('pins the closed label set exactly', () => {
    expect([...RUN_UPDATE_LABELS].sort()).toEqual(
      [
        'cancel',
        'clear-breakpoint',
        'credit-window',
        'disable',
        'driver-transition',
        'enable',
        'liveness',
        'manual-retry-override',
        'pause',
        'queue-pause',
        'queue-resume',
        'remove-phase',
        'restart',
        'resume',
        'resume-admission',
        'resume-prompt',
        'retry-decision',
        'set-breakpoint',
        'skip',
        'spawn-identity',
        'spend-pause'
      ].sort()
    );
  });

  it('has a label on every `updateRun(` call, drawn from the set when it is a literal', () => {
    const calls = callsTo('updateRun');
    expect(calls.length).toBeGreaterThan(0);
    const labels = new Set<string>(RUN_UPDATE_LABELS);
    const problems: string[] = [];
    for (const { site, call } of calls) {
      const update = call.arguments.at(1);
      if (update === undefined || !ts.isObjectLiteralExpression(update)) {
        problems.push(`${site}: the update argument is not an object literal`);
        continue;
      }
      const label = update.properties.find(
        (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText() === 'label'
      );
      if (label === undefined) {
        problems.push(`${site}: no \`label\``);
      } else if (ts.isPropertyAssignment(label) && ts.isStringLiteral(label.initializer)) {
        if (!labels.has(label.initializer.text)) {
          problems.push(`${site}: \`${label.initializer.text}\` is not a RunUpdateLabel`);
        }
      }
    }
    // A non-literal label (a shorthand or an identifier) is checked by the compiler
    // against `RunUpdateLabel`, which is the point of the closed union.
    expect(problems).toEqual([]);
  });
});
