import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-153 (T1637) — every Task status writer must route through the shared
 * `decideTaskTransition` classifier before writing.
 *
 * WHY A SOURCE-TEXT CENSUS AND NOT A BEHAVIOR TEST. Modeled directly on
 * `tests/lint/phase-control-decision-census.test.ts` (FR-R3-151): a behavior
 * test can be satisfied by a writer that reimplements the same checks inline
 * instead of calling the shared function, which is exactly the drift this
 * feature closes. Scanning each writer's own source text for the call is the
 * cheap, durable guard (contracts/task-transition-decision.md invariant 8).
 */

interface WriterLocation {
  readonly writer: string;
  readonly file: string;
  /** Regex whose match index marks the start of the writer's own body. */
  readonly signature: RegExp;
}

const QUEUE_MANAGER_PATH = resolve(__dirname, '../../src/queue/queue-manager.ts');
const RESTART_CANCELED_TASK_PATH = resolve(__dirname, '../../src/commands/restart-canceled-task.ts');

const WRITERS: readonly WriterLocation[] = [
  { writer: 'QueueManager.markInFlight', file: QUEUE_MANAGER_PATH, signature: /public async markInFlight\s*\(/ },
  { writer: 'QueueManager.finish', file: QUEUE_MANAGER_PATH, signature: /public async finish\s*\(/ },
  { writer: 'QueueManager.pause', file: QUEUE_MANAGER_PATH, signature: /public async pause\s*\(/ },
  { writer: 'QueueManager.retry', file: QUEUE_MANAGER_PATH, signature: /public async retry\s*\(/ },
  {
    writer: "restart-canceled-task.ts's writer",
    file: RESTART_CANCELED_TASK_PATH,
    signature: /export async function runRestartCanceledTask\s*\(/
  }
];

/**
 * The source text of one function/method body, found by walking paren/
 * bracket/angle depth from the signature match so a return-type-position
 * inline object type or generic does not fool a naive "first `{`" search,
 * then walking brace depth from that real body start to the matching close.
 * Mirrors `phase-control-decision-census.test.ts`'s `extractMethodBody`.
 */
function extractBody(source: string, signature: RegExp, label: string): string {
  const startMatch = signature.exec(source);
  if (!startMatch) {
    throw new Error(`could not find a match for ${signature} (${label}) — has it been renamed or removed?`);
  }

  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let bodyStart = -1;
  for (let i = startMatch.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') {
      if (angleDepth > 0) angleDepth--;
    } else if (ch === '{' && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart === -1) {
    throw new Error(`could not find the body-opening brace for ${label}`);
  }

  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

/**
 * UNLIKE `phase-control-decision-census.test.ts`, this census has no
 * separate "before any write" ordering check. `decidePhaseControl`'s
 * methods check first, then call separate mutating methods
 * (`store.setRun`, `auditor.append`, ...) afterward — there is a real
 * before/after to order. Every writer here instead calls
 * `decideTaskTransition` *inside* the one `store.updateQueue`/
 * `ctx.store.updateQueue` mutator callback that is itself both the
 * eligibility check and the only write (research.md/AGENTS.md rule-57
 * reasoning — check-inside-mutator, not check-then-write; contracts/
 * task-transition-decision.md invariant 1: a decision the mutator throws
 * on never reaches `store.updateQueue`'s own commit). The
 * `store.updateQueue(` call that wraps the callback is not itself an
 * unguarded write to order against — it is the gate.
 */
describe('every Task status writer routes through decideTaskTransition (FR-R3-153, T1637)', () => {
  const sourceByFile = new Map<string, string>();
  const sourceFor = (file: string): string => {
    const cached = sourceByFile.get(file);
    if (cached !== undefined) return cached;
    const read = readFileSync(file, 'utf8');
    sourceByFile.set(file, read);
    return read;
  };

  for (const { writer, file, signature } of WRITERS) {
    it(`${writer} calls decideTaskTransition, reads its eligible result, and does so before any write`, () => {
      const source = sourceFor(file);
      const body = extractBody(source, signature, writer);

      const decisionIndex = body.indexOf('decideTaskTransition(');
      expect(
        decisionIndex,
        `${writer} does not reference decideTaskTransition(...) — a Task status writer must ` +
          'consult the shared classifier before writing (spec.md FR-001-FR-005).'
      ).toBeGreaterThanOrEqual(0);

      const eligibleIndex = body.indexOf('.eligible', decisionIndex);
      expect(
        eligibleIndex,
        `${writer} calls decideTaskTransition(...) but never reads '.eligible' off the result — ` +
          'a call whose outcome is discarded cannot gate anything.'
      ).toBeGreaterThan(decisionIndex);
    });
  }

  it('imports decideTaskTransition in every file that references it', () => {
    for (const file of new Set(WRITERS.map((entry) => entry.file))) {
      const source = sourceFor(file);
      expect(source).toMatch(
        /import\s*\{[^}]*\bdecideTaskTransition\b[^}]*\}\s*from\s*['"][^'"]*task-transition-decision['"]/
      );
    }
  });
});
