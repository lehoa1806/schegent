// FR-R7-01 (SC-004, Hard Rule 67) — AST census of every `allowedStatuses` site in `repo/src/`.
//
// Every `updateRun` payload carries `allowedStatuses` as a concurrent-race precondition.
// This gate scans `repo/src/` by the property identifier `allowedStatuses` (never by status
// value literals) and requires every site to be classified below as either:
//   - `table-derived`: derives its status set from `run-transition-decision.ts` helpers
//     (`allowedSameStatusFor`, `allowedSourceStatusesFor`, `allowedSourceStatusesForTargets`);
//   - `narrowed`: intentionally narrows below the table with a documented one-line reason; or
//   - `delegated-helper`: forwards `allowedStatuses` from callers in the same file whose
//     callers derive from the table or document their narrowing.
//
// An added unlisted site, a stale row, or a `table-derived` row whose expression stops calling
// a transition-table helper turns this gate red.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(__dirname, '..', '..', 'src');
const FIXTURE_FILE = resolve(__dirname, 'fixtures', 'unlisted-allowed-statuses.fixture.ts');

const TABLE_HELPERS = new Set([
  'allowedSameStatusFor',
  'allowedSourceStatusesFor',
  'allowedSourceStatusesForTargets'
]);

type AllowedStatusesClass =
  | 'table-derived'
  | 'table-derived-with-live-narrowing'
  | 'narrowed'
  | 'delegated-helper';

interface CensusRow {
  readonly site: string;
  readonly classification: AllowedStatusesClass;
  readonly reason: string;
}

const CENSUS: readonly CensusRow[] = [
  {
    site: 'activation/phase-execution-wiring.ts#createLastRetryDecisionSink',
    classification: 'narrowed',
    reason: 'retry-decision projections ignore terminal Runs; driver terminal same-status writes are solely for spawnIdentity cleanup'
  },
  {
    site: 'activation/queue-lifecycle-boundary.ts#pauseNonTerminalRun',
    classification: 'table-derived',
    reason: 'derived via allowedSourceStatusesFor(\'paused\', \'operator\')'
  },
  {
    site: 'activation/run-safety-wiring.ts#pause',
    classification: 'table-derived',
    reason: 'derived via allowedSameStatusFor(\'watchdog\')'
  },
  {
    site: 'commands/cancel.ts#markCanceled',
    classification: 'narrowed',
    reason: 'operator cancel command acts on live Runs only and intentionally excludes failed Runs'
  },
  {
    site: 'controller/manual-retry-override.ts#applyManualRetryOverride',
    classification: 'table-derived',
    reason: 'derived via allowedSameStatusFor(\'operator\')'
  },
  {
    site: 'controller/phase-control-service.ts#PhaseControlService.patchRun',
    classification: 'delegated-helper',
    reason: 'seven controls pass OPERABLE = allowedSameStatusFor(\'operator\'); pauseActivePhase narrows to LIVE because pausing a failed Run is refused'
  },
  {
    site: 'controller/resume-pause-fields.ts#patchRunForResume',
    classification: 'table-derived',
    reason: 'derived via allowedSourceStatusesFor(\'running\', actor) on resume-prompt and allowedSourceStatusesFor(\'running\', \'operator\') on resume-admission so unattended eligibility rechecks reach patch'
  },
  {
    site: 'controller/run-liveness-recorder.ts#recordRunLiveness',
    classification: 'narrowed',
    reason: 'liveness heartbeats ignore terminal Runs; driver terminal same-status writes are solely for spawnIdentity cleanup'
  },
  {
    site: 'controller/task-deletion.ts#deleteTaskWithSessionCleanup',
    classification: 'narrowed',
    reason: 'task deletion cancels only live Runs because failed Runs have already ended execution'
  },
  {
    site: 'controller/workflow-controller.ts#SchegentWorkflowController.persistTransition',
    classification: 'narrowed',
    reason: 'driver transitions advance or settle live Runs only; terminal driver cells are reserved for post-exit spawnIdentity cleanup'
  },
  {
    site: 'controller/workflow-leaf-end.ts#persistCanceled',
    classification: 'narrowed',
    reason: 'workflow leaf cancellation settles live Runs only and intentionally excludes failed Runs'
  },
  {
    site: 'queue/queue-manager.ts#QueueManager.patchMatchingRun',
    classification: 'table-derived',
    reason: 'derived via allowedSameStatusFor(\'operator\')'
  },
  {
    site: 'state/spawn-identity-recorder.ts#write',
    classification: 'table-derived-with-live-narrowing',
    reason: 'clear-on-exit derives via allowedSameStatusFor(\'driver\'); recordSpawn narrows to LIVE_RUN_STATUSES because new spawns happen only on live Runs'
  },
  {
    site: 'watchdog/credit-watchdog.ts#CreditWatchdog.stampWindow',
    classification: 'narrowed',
    reason: 'credit polling windows exist strictly on paused Runs, narrower than watchdog same-status live set'
  }
];

interface AllowedStatusesSite {
  readonly site: string;
  readonly expressionText: string;
  readonly everyBranchCallsTableHelper: boolean;
  readonly isTableClearWithLiveRecord: boolean;
}

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function enclosingFunction(node: ts.Node): string {
  for (
    let current = node.parent as ts.Node | undefined;
    current;
    current = current.parent as ts.Node | undefined
  ) {
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

function isDirectTableHelperCall(node: ts.Expression): boolean {
  const unwrapped = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      isDirectTableHelperCall(unwrapped.whenTrue) &&
      isDirectTableHelperCall(unwrapped.whenFalse)
    );
  }
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    TABLE_HELPERS.has(unwrapped.expression.text)
  );
}

function isTableClearWithLiveRecordExpr(node: ts.Expression): boolean {
  const unwrapped = ts.isParenthesizedExpression(node) ? node.expression : node;
  return (
    ts.isConditionalExpression(unwrapped) &&
    isDirectTableHelperCall(unwrapped.whenTrue) &&
    ts.isIdentifier(unwrapped.whenFalse) &&
    unwrapped.whenFalse.text === 'LIVE_RUN_STATUSES'
  );
}

function scanAllowedStatusesInFile(filePath: string, root: string): readonly AllowedStatusesSite[] {
  return scanAllowedStatuses(filePath, root, readFileSync(filePath, 'utf8'));
}

function namesAllowedStatuses(name: ts.PropertyName): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === 'allowedStatuses';
  return ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression) && name.expression.text === 'allowedStatuses';
}

function scanAllowedStatuses(filePath: string, root: string, content: string): readonly AllowedStatusesSite[] {
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const found: AllowedStatusesSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      namesAllowedStatuses(node.name)
    ) {
      const expr = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      found.push({
        site: `${relative(root, filePath).split('\\').join('/')}#${enclosingFunction(node)}`,
        expressionText: expr.getText(source),
        everyBranchCallsTableHelper: isDirectTableHelperCall(expr),
        isTableClearWithLiveRecord: isTableClearWithLiveRecordExpr(expr)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scanAllowedStatusesUnder(root: string): readonly AllowedStatusesSite[] {
  const out: AllowedStatusesSite[] = [];
  for (const file of sourceFiles(root)) {
    out.push(...scanAllowedStatusesInFile(file, root));
  }
  return out;
}

function classifySites(discovered: readonly AllowedStatusesSite[], census: readonly CensusRow[]) {
  const classifiedSites = new Set(census.map((row) => row.site));
  const remainingSites = new Set(classifiedSites);
  const unlisted: string[] = [];
  const duplicates: string[] = [];
  for (const { site } of discovered) {
    if (!classifiedSites.has(site)) unlisted.push(site);
    else if (!remainingSites.delete(site)) duplicates.push(site);
  }
  return { unlisted: unlisted.sort(), stale: [...remainingSites].sort(), duplicates: duplicates.sort() };
}

describe('FR-R7-01 — Run allowedStatuses site census (SC-004)', () => {
  it('lists every allowedStatuses site in src/ with no unlisted or stale entries', () => {
    const discovered = scanAllowedStatusesUnder(SRC_ROOT);
    expect(discovered.length).toBeGreaterThan(0);

    const { unlisted, stale, duplicates } = classifySites(discovered, CENSUS);

    expect(unlisted, 'Unlisted allowedStatuses site(s) found in src/').toEqual([]);
    expect(stale, 'Stale census row(s) with no matching site in src/').toEqual([]);
    expect(duplicates, 'Multiple allowedStatuses sites covered by a single census row').toEqual([]);
  });

  it('verifies every table-derived row actually calls a transition-table helper and every row has a reason', () => {
    const discovered = scanAllowedStatusesUnder(SRC_ROOT);
    const bySite = new Map(discovered.map((d) => [d.site, d]));

    expect(new Set(CENSUS.map((r) => r.site)).size).toBe(CENSUS.length);
    for (const row of CENSUS) {
      expect(row.reason.trim().length, row.site).toBeGreaterThan(0);
      const site = bySite.get(row.site);
      if (row.classification === 'table-derived') {
        expect(
          site?.everyBranchCallsTableHelper,
          `${row.site} must derive every branch via a table helper`
        ).toBe(true);
      } else if (row.classification === 'table-derived-with-live-narrowing') {
        expect(
          site?.isTableClearWithLiveRecord,
          `${row.site} must derive clear branch via table helper and narrow record branch to LIVE_RUN_STATUSES`
        ).toBe(true);
      }
    }
  });

  it('verifies delegated-helper PhaseControlService.patchRun derives OPERABLE from the table and passes only OPERABLE or LIVE', () => {
    const phaseControlPath = resolve(SRC_ROOT, 'controller', 'phase-control-service.ts');
    const source = ts.createSourceFile(
      phaseControlPath,
      readFileSync(phaseControlPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    let operableDerived = false;
    const patchRunArgs: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'OPERABLE' &&
        node.initializer &&
        isDirectTableHelperCall(node.initializer)
      ) {
        operableDerived = true;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.name.text === 'patchRun'
      ) {
        const statusArg = node.arguments.at(3);
        patchRunArgs.push(statusArg ? statusArg.getText(source) : '<missing>');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(operableDerived, 'OPERABLE in phase-control-service.ts must derive from a table helper').toBe(
      true
    );
    expect(patchRunArgs.length).toBeGreaterThan(0);
    for (const arg of patchRunArgs) {
      expect(['OPERABLE', 'LIVE']).toContain(arg);
    }
  });

  it('negative control: flags an added unlisted allowedStatuses site from the fixture', () => {
    const fixtureSites = scanAllowedStatusesInFile(
      FIXTURE_FILE,
      resolve(__dirname, 'fixtures')
    );
    expect(fixtureSites.length).toBe(1);
    const { unlisted } = classifySites(fixtureSites, CENSUS);
    expect(unlisted).toEqual([
      'unlisted-allowed-statuses.fixture.ts#unlistedAllowedStatusesWriter'
    ]);
  });

  it('negative control: flags a second site in a classified function and recognizes literal property names', () => {
    const file = resolve(SRC_ROOT, 'controller', 'manual-retry-override.ts');
    const discovered = scanAllowedStatuses(file, SRC_ROOT, `
      function applyManualRetryOverride() {
        store.updateRun(queueId, { 'allowedStatuses': allowedSameStatusFor('operator') }, claim);
        store.updateRun(queueId, { ['allowedStatuses']: ['paused'] }, claim);
      }
    `);
    expect(discovered).toHaveLength(2);
    expect(classifySites(discovered, CENSUS).duplicates).toEqual([
      'controller/manual-retry-override.ts#applyManualRetryOverride'
    ]);
  });
});
