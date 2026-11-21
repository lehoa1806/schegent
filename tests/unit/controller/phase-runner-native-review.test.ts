import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { phaseDefinitionToPhaseDef } from '../../../src/config/process-catalog';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { transition } from '../../../src/controller/phase';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { InvocationRequest, RawInvocationOutput } from '../../../src/runner/invocation-result';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { phaseDefinitionFromDocument } from '../../../src/services/process-yaml/phase-yaml-mapper';
import { buildR1, buildW1, commitFile, git, initRepo, makeRoot, writeFile } from '../../fixtures/review-scope-workspaces';
import { loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

function buffer(text: string): ZippedStreamBuffer {
  const stream = new ZippedStreamBuffer();
  stream.append(text);
  stream.finalize();
  return stream;
}

function rawOutput(text: string, exitCode = 0): RawInvocationOutput {
  return {
    stdoutBuffer: buffer(text),
    stderrBuffer: buffer(''),
    exitCode,
    killed: false,
    timedOut: false,
    sawTerminalResult: exitCode === 0,
    durationMs: 50
  } as RawInvocationOutput;
}

const example = loadExample();

function setup(
  cwd: string,
  kind: 'code' | 'security',
  respond: (request: InvocationRequest, auditBlock: string) => RawInvocationOutput,
  backend: BackendRunnerKind = 'claude'
) {
  const phase = `${backend}-${kind}-review`;
  const phaseDef = phaseDefinitionToPhaseDef(phaseDefinitionFromDocument(phaseOf(example, phase)));
  const clean = [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: review complete',
    `${kind}_review_findings: 0`,
    `${kind}_review_verified: 1`,
    '=== END AUDIT LOG ===',
    '[SCHEGENT_STATUS: CLEAR]'
  ].join('\n');
  const invoke = vi.fn(async (request: InvocationRequest) => respond(request, clean));
  const entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>> = [];
  const runner = new PhaseRunner(
    { invoke, cancelActive: () => false, hasActiveProcess: false } as unknown as BackendRunner,
    new PromptBuilder(),
    {
      append: async (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => {
        entries.push(entry);
        return { ...entry, id: `audit-${entries.length}`, timestamp: '2026-11-20T00:00:00Z' };
      }
    } as unknown as AuditLogWriter,
    new SanitizedLogger()
  );
  return {
    phase, phaseDef, invoke, entries,
    run: (iteration: number) => runner.run({
      phase, phaseDef, iteration, iterationCap: 3,
      featureDescription: 'Review a feature.', featureDir: 'specs/001-feature',
      cliPath: backend, cwd, timeoutMs: 5_000, maxDurationMs: 15_000, runId: 'run-1'
    })
  };
}

describe('PhaseRunner native review and repair', () => {
  it('passes a real review report into repair and loops on working-tree changes', async () => {
    const { root } = buildW1();
    const fixture = setup(root, 'code', (request, audit) => {
      if (request.review === undefined) {
        if (request.iteration === 1) writeFile(root, 'src/a.ts', 'export const fixed = true;\n');
        return rawOutput(audit);
      }
      return rawOutput(request.iteration === 1 ? 'Confirmed finding at src/a.ts:1.' : 'No findings.');
    });
    const first = await fixture.run(1);
    const review = fixture.invoke.mock.calls.at(0)?.[0];
    const repair = fixture.invoke.mock.calls.at(1)?.[0];
    expect(review?.prompt).toMatch(/^\/code-review --max-findings all /);
    expect(review?.prompt).toContain('src/new.ts');
    expect(review).toMatchObject({ cwd: root, review: { kind: 'code' } });
    expect(repair?.review).toBeUndefined();
    expect(repair?.prompt).toContain('Confirmed finding at src/a.ts:1.');
    expect(fixture.entries.map((entry) => entry.payload).filter((payload) => payload.operation === 'native-review'))
      .toHaveLength(1);

    const next = (output: typeof first, iteration: number) => transition({
      phase: fixture.phase, phaseDef: fixture.phaseDef, iteration, iterationCap: 3,
      outcome: output.outcome, metrics: 'auditEntry' in output.result ? output.result.auditEntry?.metrics ?? {} : {}
    });
    expect(next(first, 1)).toMatchObject({ kind: 'loop', nextIteration: 2 });
    expect(next(await fixture.run(2), 2)).toMatchObject({ kind: 'advance' });
    expect(fixture.invoke.mock.calls.map(([call]) => call.review?.kind)).toEqual(['code', undefined, 'code', undefined]);
  });

  it('rejects a failed native review before doing any repair', async () => {
    const { root } = buildW1();
    const fixture = setup(root, 'code', () => rawOutput('Review interrupted.', 2));
    await expect(fixture.run(1)).rejects.toThrow('The native reviewer returned no complete report.');
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing declared repository open even if the repair model claims the review is clear', async () => {
    const { root } = buildR1();
    const fixture = setup(root, 'security', (request, audit) => rawOutput(
      request.review === undefined ? audit : 'No findings in alpha.'
    ));
    const result = await fixture.run(1);
    const review = fixture.invoke.mock.calls.at(0)?.[0];
    const repair = fixture.invoke.mock.calls.at(1)?.[0];
    expect(review?.cwd).toBe(`${root}/alpha`);
    expect(review?.prompt).toMatch(/^Review the selected changes for security defects/);
    expect(repair?.prompt).toContain('"status":"unresolved:missing"');
    expect(result.result).toMatchObject({
      auditEntry: { metrics: { security_review_findings: 1, security_review_verified: 0 } }
    });
  });

  it('uses the Claude slash command for the origin base and a scoped turn for local changes', async () => {
    const root = makeRoot('claude-security');
    initRepo(root);
    git(root, ['remote', 'add', 'origin', root]);
    git(root, ['update-ref', 'refs/remotes/origin/develop', 'develop']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
    commitFile(root, 'src/a.ts', 'export const feature = true;\n');
    const fixture = setup(root, 'security', (request, audit) => rawOutput(
      request.review === undefined ? audit : 'No security findings.'
    ));
    await fixture.run(1);
    expect(fixture.invoke.mock.calls[0]?.[0].prompt).toMatch(/^\/security-review\n/);
    writeFile(root, 'src/b.ts', 'export const localChange = true;\n');
    await fixture.run(2);
    const localReview = fixture.invoke.mock.calls.at(2)?.[0];
    expect(localReview?.prompt).toMatch(/^Review the selected changes for security defects/);
    expect(localReview?.prompt).toContain('src/b.ts');
  });

  it.each(['code', 'security'] as const)('gives Agy a dedicated %s review turn', async (kind) => {
    const { root } = buildW1();
    const fixture = setup(root, kind, (request, audit) => rawOutput(
      request.review === undefined ? audit : 'Agy review complete.'
    ), 'agy');
    await fixture.run(1);
    const review = fixture.invoke.mock.calls.at(0)?.[0];
    const repair = fixture.invoke.mock.calls.at(1)?.[0];
    expect(review).toMatchObject({ cwd: root, cliPath: 'agy', review: { kind } });
    expect(review?.prompt).toMatch(/^Review the selected changes/);
    expect(repair?.review).toBeUndefined();
    expect(repair?.prompt).toContain('Agy review complete.');
  });
});
