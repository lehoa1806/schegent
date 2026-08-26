// The seam gate: an authored Phase field that reaches the backend must actually
// arrive there.
//
// WHY THIS EXISTS. The feature-155 security review found the same defect three
// times in one change, wearing three different sets of clothes: a mechanism whose
// halves were each correct and never met. `capabilities` was FORWARDED but not
// ADMITTED, then ADMITTED but not AUTHORABLE, then ENFORCED but not OBSERVABLE.
// The first of those — `SEC`/S7 — is the one this gate is about: the refusal read
// `phaseDef.capabilities`, the adapter read `request.capabilities`, and nothing
// carried one to the other, so an ENFORCEABLE narrowed set silently ran with the
// unbounded argv while a narrower bound had been approved with the plan.
//
// Every test passed. Each half was driven against its own input and nothing drove
// one half into the other. The review found it by tracing one value from where it
// is written to where it takes effect, recorded that the trace was manual, and
// named the absence of this gate as the gap. This is that gap closed.
//
// WHAT IT CHECKS, and the two halves are different in kind:
//
//   1. COVERAGE (derived, so it cannot go stale). The field set is computed by
//      intersecting the catalog's authored fields with `InvocationRequest`'s own
//      declared fields, read from source. A field in that intersection with no
//      entry in `FORWARDED` fails, naming itself. So the next authored field that
//      shares a name with a request field is covered or the build stops — nobody
//      has to remember this file exists.
//
//   2. ARRIVAL (behavioural, not textual). Each covered field is set to a
//      DISTINCTIVE non-default value on a real `PhaseDefinition`, a real
//      `PhaseRunner` is driven, and the `InvocationRequest` the adapter actually
//      received is asserted. A text scan of the `invoke({...})` call site would
//      pass on a forward that reads the wrong object; this cannot.
//
// The rename pairs are listed separately because a name intersection cannot see
// them: `timeoutSeconds` becomes `timeoutMs`, and a gate that only intersected
// names would report full coverage over a seam with a hole in it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AUTHORED_PHASE_FIELDS } from '../../src/config/process-definition-validator';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../src/lib/logger';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import type { InvocationRequest } from '../../src/runner/invocation-result';

const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * `InvocationRequest`'s field names, read from the interface rather than
 * restated. A hand-kept copy is the thing this gate exists to distrust.
 */
function invocationRequestFields(): ReadonlySet<string> {
  const text = readFileSync(resolve(SRC, 'runner', 'invocation-result.ts'), 'utf8');
  const start = text.indexOf('export interface InvocationRequest');
  if (start < 0) throw new Error('InvocationRequest not found — this gate is reading the wrong file');
  const body = text.slice(start, text.indexOf('\n}', start));
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const match = /^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * A field the adapter reads under a DIFFERENT name than the author wrote. The
 * name intersection is blind to these by construction, so they are declared.
 */
const RENAMED: ReadonlyArray<{ authored: string; request: string }> = [
  { authored: 'timeoutSeconds', request: 'timeoutMs' }
];

/**
 * The distinctive value each covered field is driven with, and what must arrive.
 *
 * Values are deliberately NOT the defaults. A field dropped anywhere on the path
 * shows up as an absent or changed value rather than as a coincidentally-correct
 * one — the same discipline the exchange-format fixtures are held to.
 */
const FORWARDED: Readonly<Record<string, { authored: unknown; expected: unknown }>> = {
  model: { authored: 'opus', expected: 'opus' },
  effort: { authored: 'high', expected: 'high' },
  // The field S7 lost. A PROPER SUBSET, so a forward that substitutes the
  // default (every capability) is a changed value rather than a passing one.
  capabilities: {
    authored: ['workspace-write'],
    expected: { capabilities: ['workspace-write'], declaredAt: 'phase-definition' }
  },
  timeoutSeconds: { authored: 45, expected: 45_000 }
};

const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

function buffer(text: string): ZippedStreamBuffer {
  const b = new ZippedStreamBuffer();
  b.append(text);
  b.finalize();
  return b;
}

/** Drive a real PhaseRunner and return the request the adapter actually got. */
async function captureRequest(): Promise<InvocationRequest> {
  let seen: InvocationRequest | undefined;
  const fakeRunner = {
    invoke: vi.fn(async (request: InvocationRequest) => {
      seen = request;
      return {
        stdoutBuffer: buffer(CLEAN_STDOUT),
        stderrBuffer: buffer(''),
        exitCode: 0,
        killed: false,
        timedOut: false,
        durationMs: 10
      };
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  };
  const auditWriter = {
    append: vi.fn(async () => ({ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' })),
    appendRequired: vi.fn(async () => ({ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }))
  };
  const runner = new PhaseRunner(
    fakeRunner as never,
    new PromptBuilder(),
    auditWriter as never,
    new SanitizedLogger()
  );
  const phaseDef: Record<string, unknown> = {
    id: 'speckit-specify',
    name: 'Specify',
    version: 1,
    instruction: 'do the thing',
    runner: 'claude'
  };
  for (const [field, { authored }] of Object.entries(FORWARDED)) {
    phaseDef[field] = authored;
  }
  await runner.run({
    phase: 'speckit-specify' as never,
    iteration: 1,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: 'specs/001-mock',
    cliPath: 'claude',
    cwd: '/repo',
    timeoutMs: 5_000,
    runId: 'run-1',
    phaseDef: phaseDef as never
  } as never);
  if (seen === undefined) throw new Error('the adapter was never invoked — the harness is broken');
  return seen;
}

describe('the authoring -> invocation seam (feature 155 security review, S7)', () => {
  it('covers every authored field the request declares under the same name', () => {
    // Derived, not listed. A new authored field that shares a name with a request
    // field lands here with no edit to this file, and fails until it is covered.
    const shared = [...AUTHORED_PHASE_FIELDS].filter((field) => invocationRequestFields().has(field));
    const uncovered = shared.filter((field) => !(field in FORWARDED));
    expect(
      uncovered,
      `authored fields the InvocationRequest declares but this gate does not drive: ${uncovered.join(', ')}. ` +
        'Add each to FORWARDED with a distinctive non-default value.'
    ).toEqual([]);
  });

  it('covers every field the adapter reads under a different name', () => {
    const uncovered = RENAMED.filter(({ authored }) => !(authored in FORWARDED));
    expect(uncovered.map((pair) => pair.authored)).toEqual([]);
    for (const { authored, request } of RENAMED) {
      expect(AUTHORED_PHASE_FIELDS.has(authored), `${authored} is no longer authored`).toBe(true);
      expect(invocationRequestFields().has(request), `${request} is no longer a request field`).toBe(true);
    }
  });

  it('names at least the field the review found missing (sanity)', () => {
    // Without this, an empty or broken derivation above would report full
    // coverage over nothing at all.
    expect(Object.keys(FORWARDED)).toContain('capabilities');
    expect(invocationRequestFields().size).toBeGreaterThan(10);
  });

  it.each(Object.entries(FORWARDED))(
    'carries an authored %s from the phase definition to the adapter',
    async (field, { expected }) => {
      const request = await captureRequest();
      const key = RENAMED.find((pair) => pair.authored === field)?.request ?? field;
      expect(
        (request as unknown as Record<string, unknown>)[key],
        `${field} was authored on the phase and did not arrive at the adapter as ${key}`
      ).toEqual(expected);
    }
  );
});
