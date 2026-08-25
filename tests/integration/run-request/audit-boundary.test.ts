// Feature 087 (T065, US7, FR-047, SC-010) — the audit boundary for a composed
// submission.
//
// SC-010 is a zero: "0 audit events emitted by this feature contain
// business-document content, pasted input, full prompts, secrets, or absolute
// workspace paths." A zero is only worth asserting if the thing being counted
// was actually present upstream, so every operator-authored field of the
// request below carries a distinct sentinel — a pasted document, a file the
// operator picked, an instruction, a URL, a prior-output name, an output
// target, and a secret-shaped string. The submission is then driven through the
// real path (`validateRunRequest()` → `GuardedRunService.scheduleOrEnqueue()` →
// `QueueManager.enqueue()`), and every captured audit entry is serialized whole
// and searched for each sentinel.
//
// Serializing the whole entry, rather than checking named fields, is the point:
// a future payload field that carried content would be caught even though this
// test never heard of it. The same sweep looks for `harness.workspaceRoot`,
// which covers the absolute-path half of FR-047 — the frozen plan holds
// workspace-relative values (FR-020) and the audit holds neither.
//
// Two paths matter, and both are exercised:
//
//   The accepted path. Enqueue succeeds and feature 065's start-intent policy
//   emits its `idle-pending-entered` family. Those payloads are structured
//   (`queueId`, `transitionReason`, schedule fields) and carry nothing from the
//   request — asserted, not assumed.
//
//   The refused paths. `cmd-launch-pipeline` emits no audit event of its own,
//   so a request that fails validation produces no event at all. A request that
//   passes validation but meets a paused queue reaches `emitRejection`, whose
//   `reason` is a code (`queue-paused`), never the description.
//
// One free-form string can reach an audit payload on this path: the enqueue
// failure `reason`. It is routed through `logger.sanitize` before the append,
// and the last case pins exactly that seam. This suite does not re-test the
// redaction set — `SECRET_PATTERNS` owns it, and forking that coverage here
// would be a second source of truth for what a secret looks like.

import { describe, expect, it } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { RunRequest } from '../../../src/contracts/run-request';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../src/services/run-request/run-request-validator';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';

const NOW = 1_700_000_000_000;

/**
 * Every operator-authored string the request can carry, each distinct enough
 * that a match in a serialized audit entry names the field that leaked.
 */
const SENTINEL = {
  /** Business-document content, pasted into a contract input. */
  document: 'ACQUISITION-MEMO-CONFIDENTIAL-Q3-NORTHWIND',
  /** A second paste, this time supplemental rather than contractual. */
  pastedText: 'PASTED-BOARD-MINUTES-2026-03-14',
  /** The full prompt the operator wrote for this session. */
  instructions: 'FULL-PROMPT-SUMMARIZE-THE-NORTHWIND-MEMO-FOR-THE-BOARD',
  /** A supplemental free-text instruction, separate from the prompt above. */
  instructionItem: 'SUPPLEMENTAL-INSTRUCTION-KEEP-IT-TO-ONE-PAGE',
  /** A path the operator picked, held workspace-relative in the plan. */
  filePath: 'briefs/northwind-memo.md',
  /** A folder the operator picked. */
  folderPath: 'briefs/attachments',
  /** An external reference. */
  url: 'https://internal.example.invalid/deal-room/northwind',
  /** A prior Run's named output, and the location that Run recorded for it. */
  priorOutputName: 'northwind-valuation',
  priorOutputReference: 'out/northwind-valuation.md',
  /** Where the operator asked for the result. */
  outputTarget: 'out/northwind-summary.md',
  /** Secret-shaped, and deliberately inside a value the operator pasted. */
  secret: 'sk-ant-api03-NORTHWIND-DEAL-ROOM-TOKEN'
} as const;

const COMPOSE: PhaseDef = {
  id: 'compose',
  name: 'Compose',
  version: 1,
  instruction: 'Compose the thing.',
};

const AUDITED_FLOW: PipelineDef = {
  id: 'audited-flow',
  name: 'Audited Flow',
  phases: ['compose'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'dossier', label: 'Dossier', type: 'local-file', required: true }
  ],
  outputs: [{ portId: 'summary', label: 'Summary', type: 'markdown' }]
};

function catalog(): PipelineCatalog {
  return buildCatalog(
    [COMPOSE],
    [AUDITED_FLOW],
    { claude: [], codex: [], agy: [] },
    'audited-flow'
  );
}

const SOURCE: EffectivePipelineSource = {
  definition: AUDITED_FLOW,
  phases: [COMPOSE],
  defaultRunnerKind: 'claude'
};

/** Accepting probes: nothing here is refused for a reason found on disk. */
const PORTS = {
  localInputs: {
    checkFile: async () => ({ ok: true }) as const,
    checkFolder: async () => ({ ok: true }) as const
  },
  outputProbe: { exists: async () => false },
  priorOutputs: {
    outputsFor: () => [
      {
        name: SENTINEL.priorOutputName,
        status: 'resolved' as const,
        reference: SENTINEL.priorOutputReference
      }
    ]
  }
};

/** Carries a sentinel in every field an operator can author. */
const LOADED: RunRequest = {
  pipelineId: 'audited-flow',
  inputs: [
    {
      portId: 'brief',
      type: 'text',
      value: `${SENTINEL.document}\ntoken=${SENTINEL.secret}`
    },
    { portId: 'dossier', type: 'local-file', value: SENTINEL.filePath }
  ],
  supplemental: [
    { kind: 'text', text: SENTINEL.pastedText },
    { kind: 'instruction', text: SENTINEL.instructionItem },
    { kind: 'local-folder', path: SENTINEL.folderPath },
    { kind: 'url', url: SENTINEL.url },
    {
      kind: 'prior-output',
      reference: { sourceRunId: 'run-earlier', outputName: SENTINEL.priorOutputName }
    }
  ],
  outputs: [{ portId: 'summary', target: SENTINEL.outputTarget }],
  instructions: SENTINEL.instructions
};

/** The required `dossier` port is unsupplied, so validation refuses. */
const REFUSED: RunRequest = {
  ...LOADED,
  inputs: LOADED.inputs.filter((input) => input.portId !== 'dossier')
};

/**
 * Validates and, if accepted, submits. Returns whether the submission was
 * accepted so a caller can pin the refusal alongside the audit assertion.
 */
async function submit(harness: Harness, request: RunRequest): Promise<boolean> {
  const outcome = await validateRunRequest(request, {
    pipeline: SOURCE,
    workspaceRoot: harness.workspaceRoot,
    now: NOW,
    ...PORTS
  });
  if (!outcome.ok) return false;
  await harness.service.scheduleOrEnqueue({
    // What `cmd-launch-pipeline` passes: the operator's own instruction text.
    description: outcome.plan.instructions ?? outcome.plan.pipeline.name,
    scheduledAt: NOW,
    via: 'webview',
    pipelineId: outcome.plan.pipeline.id,
    runPlan: outcome.plan
  });
  return true;
}

/** Every captured audit entry, serialized whole — payload fields included. */
function auditText(harness: Harness): string {
  return JSON.stringify(harness.audit.entries);
}

describe('no audit event carries what the operator composed (FR-047, SC-010)', () => {
  it('emits none of the sentinels for an accepted submission', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      expect(await submit(harness, LOADED)).toBe(true);

      const text = auditText(harness);
      for (const [field, sentinel] of Object.entries(SENTINEL)) {
        expect(text, `audit leaked the ${field} sentinel`).not.toContain(sentinel);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('emits no absolute workspace path', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await submit(harness, LOADED);

      expect(auditText(harness)).not.toContain(harness.workspaceRoot);
    } finally {
      harness.cleanup();
    }
  });

  it('did emit events, so the zeros above are a boundary and not an empty log', async () => {
    // Guard against the test passing because nothing ran. The start-intent
    // policy emits its idle-pending family on this path; if that ever stops,
    // this fails loudly rather than leaving the sweeps vacuously true.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await submit(harness, LOADED);

      expect(harness.audit.entries.length).toBeGreaterThan(0);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps schedule payloads structured — codes and identifiers only', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await submit(harness, LOADED);

      const entered = harness.audit.byType('idle-pending-entered');
      expect(entered.length).toBeGreaterThan(0);
      for (const entry of entered) {
        const payload = entry.payload as Record<string, unknown>;
        expect(payload.queueId).toBe('default');
        expect(typeof payload.transitionReason).toBe('string');
        expect(payload.occurredAt).toBe(NOW);
        // Nothing named after a request field may appear here.
        for (const key of ['description', 'instructions', 'inputs', 'supplemental', 'outputs', 'runPlan']) {
          expect(payload, `schedule payload carried ${key}`).not.toHaveProperty(key);
        }
      }
    } finally {
      harness.cleanup();
    }
  });
});

describe('a refused submission audits the refusal, never the content', () => {
  it('emits nothing at all when validation refuses', async () => {
    // The composer's command handler emits no audit event of its own, so a
    // request that never reaches the queue never reaches the audit log either.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      expect(await submit(harness, REFUSED)).toBe(false);

      expect(harness.audit.entries).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('records a code, not the description, when the queue is paused', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await harness.store.updateQueue((queue) => ({
        // FR-R3-011 — the pause is seeded on the single representation. Setting
        // the retired `paused` mirror here left the queue running, so the
        // submission was accepted and there was no refusal to audit.
        queue: { ...queue, queueLifecycle: 'operator-paused' as const, pauseSource: 'operator' as const },
        result: undefined
      }), 'default',
        unfencedCommit('test-fixture')
      );

      await submit(harness, LOADED);

      const text = auditText(harness);
      expect(text).toContain('queue-paused');
      for (const sentinel of Object.values(SENTINEL)) {
        expect(text).not.toContain(sentinel);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('sanitizes the one free-form string that can reach a payload', async () => {
    // The enqueue-failure `reason` is the only operator-adjacent free text on
    // this path. What is pinned is the seam — the string goes through
    // `logger.sanitize` before the append — not the redaction set itself, which
    // `SECRET_PATTERNS` owns and this suite must not fork.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      harness.logger.sanitize.mockImplementation(() => '[redacted]');
      const failing = new Error(`enqueue blew up on ${SENTINEL.secret}`);
      harness.queue.enqueue = async () => {
        throw failing;
      };

      await submit(harness, LOADED);

      const text = auditText(harness);
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(SENTINEL.secret);
    } finally {
      harness.cleanup();
    }
  });
});
