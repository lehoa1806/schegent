// FR-R4-F02 (spec 240, US1; contract U1 G3, U4 G13; hard rules 60 and 67) — one eligibility rule
// and one capacity ceiling for an unattended resume.
//
// Three things are proven by searching the source, and each search term is an IDENTIFIER, never a
// value (hard rule 67):
//
//   1. `decideUnattendedEligibility` is named by exactly two files besides the one that defines it:
//      the admission service's selection and the in-lease recheck of the resume admission (which
//      lives in `resume-pause-fields.ts` and runs from `SchegentWorkflowController.admitResume`). A
//      third caller is a third place that decides who may resume unattended, and the three will
//      drift.
//   2. `hasExecutionCapacity(` appears in `src` only at its definition (`queue-manager.ts`) and once
//      in `auto-drain-coordinator.ts`, inside `executionSlotFor`. Drain step 4 and an unattended
//      admission both ask that one method, so the ceiling is in one place (hard rule 60).
//   3. `controller.running` appears zero times in `auto-drain-coordinator.ts`: reintroducing "the
//      engine is busy, so wait" is the deleted drain step 4b.
//
// Comments are stripped before searching: the prose around these names is long and quotes them.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DECISION = 'decideUnattendedEligibility';
const DEFINITION = 'src/services/unattended-eligibility.ts';
const DECISION_CALLERS: readonly string[] = [
  'src/controller/resume-pause-fields.ts',
  'src/services/unattended-admission.ts'
];

const CAPACITY_CALL = 'hasExecutionCapacity(';
const CAPACITY_DEFINITION = 'src/queue/queue-manager.ts';
const COORDINATOR = 'src/services/auto-drain-coordinator.ts';
const SLOT_METHOD = 'executionSlotFor';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function collectSourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (path.extname(entry.name) !== '.ts') continue;
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

const root = process.cwd();
const sources = new Map<string, string>(
  collectSourceFiles(path.resolve(root, 'src'), []).map((file) => [
    path.relative(root, file),
    stripComments(fs.readFileSync(file, 'utf8'))
  ])
);

function filesContaining(term: string): string[] {
  return [...sources.entries()].filter(([, code]) => code.includes(term)).map(([file]) => file).sort();
}

function occurrences(code: string, term: string): number {
  return code.split(term).length - 1;
}

describe('FR-R4-F02 (contract U1 G3) — one eligibility decision for an unattended resume', () => {
  it('control: the scan reads the tree and finds the decision where it is defined', () => {
    expect(sources.size).toBeGreaterThan(200);
    expect(fs.existsSync(path.resolve(root, DEFINITION))).toBe(true);
    expect(filesContaining(DECISION)).toContain(DEFINITION);
  });

  it('is named by exactly the admission service and the controller, besides its definition', () => {
    const named = filesContaining(DECISION).filter((file) => file !== DEFINITION);
    expect(named).toEqual([...DECISION_CALLERS].sort());
  });
});

describe('FR-R4-F02 (contract U4 G13; hard rule 60) — one capacity ceiling', () => {
  it('control: the scan finds the definition in the queue manager', () => {
    expect(occurrences(sources.get(CAPACITY_DEFINITION) ?? '', CAPACITY_CALL)).toBeGreaterThanOrEqual(1);
  });

  it('names hasExecutionCapacity( only in the queue manager and once in the coordinator', () => {
    expect(filesContaining(CAPACITY_CALL)).toEqual([COORDINATOR, CAPACITY_DEFINITION].sort());
    expect(occurrences(sources.get(COORDINATOR) ?? '', CAPACITY_CALL)).toBe(1);
  });

  it('puts that one call inside executionSlotFor', () => {
    const code = sources.get(COORDINATOR) ?? '';
    const start = code.indexOf(`${SLOT_METHOD}(`);
    expect(start, `${SLOT_METHOD} is defined in the coordinator`).toBeGreaterThan(-1);
    const call = code.indexOf(CAPACITY_CALL);
    const methodHeader = code.lastIndexOf(`${SLOT_METHOD}(`, call);
    expect(methodHeader, 'the capacity call sits in the body that follows the method header').toBeGreaterThan(-1);
    const nextMember = code.slice(methodHeader + 1, call).search(/\n {2}(?:public|private|protected|async) /);
    expect(nextMember, 'no other member begins between the header and the call').toBe(-1);
  });

  it('never reads controller.running in the coordinator', () => {
    expect(occurrences(sources.get(COORDINATOR) ?? '', 'controller.running')).toBe(0);
  });
});
