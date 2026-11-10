// Feature 020 T015 — `projectStreamJsonlLine`: 5 accepted kinds,
// framing kinds dropped. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §4 +
// specs/020-phase-level-logs/research.md §4.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  MAX_AGY_STEP_TEXT_LENGTH,
  MAX_OPEN_AGY_STEPS,
  projectStreamJsonlLine
} from '../../../../src/services/phase-log/phase-log-display-projector';
import { readIterationManifest } from '../../../../src/services/phase-log/phase-log-reader';
import {
  PhaseLogTailSession,
  type LiveLogBatchItem
} from '../../../../src/services/phase-log/phase-log-tail-session';
import type {
  IterationManifest,
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from '../../../../src/services/phase-log/types';

describe('Feature 020 T015 — projectStreamJsonlLine', () => {
  it('projects assistant text content to assistant-text kind', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello world' }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('assistant-text');
    expect(e?.body.text).toBe('hello world');
  });

  it('projects assistant tool_use content to tool-use kind', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('tool-use');
    expect(e?.body.toolName).toBe('Read');
    expect(e?.body.toolInput).toContain('file_path');
  });

  it('projects user tool_result content to tool-result kind', () => {
    const line = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'file contents',
            is_error: false
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('tool-result');
    expect(e?.body.toolResult).toBe('file contents');
    expect(e?.body.isError).toBe(false);
  });

  it('flags tool-result entries with is_error === true', () => {
    const line = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'oops', is_error: true }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.isError).toBe(true);
  });

  it('projects system lines to system kind', () => {
    const line = {
      type: 'system',
      subtype: 'init',
      session_id: 's1'
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('system');
    expect(e?.body.systemSubtype).toBe('init');
  });

  it('projects result lines to result kind', () => {
    const line = {
      type: 'result',
      duration_ms: 1234,
      num_turns: 3,
      total_cost_usd: 0.0042
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('result');
    expect(e?.body.resultSummary).toBeTruthy();
  });

  it('returns null for framing kinds (message_start, message_stop, content_block_delta)', () => {
    expect(projectStreamJsonlLine({ type: 'message_start' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'message_stop' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_delta' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_start' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_stop' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'message_delta' })).toBeNull();
  });

  it('returns null for unknown types', () => {
    expect(projectStreamJsonlLine({ type: 'totally_unknown' })).toBeNull();
    expect(projectStreamJsonlLine({})).toBeNull();
    expect(projectStreamJsonlLine(null)).toBeNull();
  });
});

describe('Feature 029 — projectStreamJsonlLine populates toolArguments', () => {
  it('emits toolArguments as the original object for tool_use with scalar args', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/x', offset: 10 }
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toEqual({ file_path: '/x', offset: 10 });
    // Legacy toolInput string remains for backward compatibility.
    expect(e?.body.toolInput).toContain('file_path');
  });

  it('preserves multi-line content as a string value (not stringified twice)', () => {
    const content = 'line 1\nline 2\nline 3';
    const line = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/a.md', content }
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    const args = e?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args?.content).toBe(content);
  });

  it('elides values deeper than MAX_TOOL_ARGUMENT_DEPTH', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i++) {
      nested = { down: nested };
    }
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Custom', input: { tree: nested } }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    // The recursion starts at depth=0 on the wrapper `{ tree: ... }` and
    // returns `{ __elided: true }` as soon as depth >= 8. So the path
    // `tree.down × 7` is the first elision sentinel (1 key for `tree`
    // already consumed when we read `args.tree`; 7 more `down` hops
    // land us at depth 8).
    let cursor: unknown = (e?.body.toolArguments as Record<string, unknown>).tree;
    for (let i = 0; i < 7; i++) {
      cursor = (cursor as Record<string, unknown>).down;
    }
    expect(cursor).toEqual({ __elided: true });
  });

  it('wraps a bare-string tool input as { value }', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Custom', input: 'free form prompt' }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toEqual({ value: 'free form prompt' });
    expect(e?.body.toolInput).toBe('free form prompt');
  });

  it('omits toolArguments when input is undefined', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'NoArgs' }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toBeUndefined();
    expect(e?.body.toolInput).toBe('');
  });
});

// Feature 020 BUG-002 (T082, FR-012a, SC-011) — agy keys its lines `event`,
// not `type`, so the Claude projection dropped every one of them and an agy
// phase showed an empty feed. A one-shot read and a tail must agree, so these
// drive the reader and the tail session, not a single projection call.
//
// The fixture is synthetic: the six `step_type` values, `init` and `result`
// that BUG-002 counted in an agy 1.5.0 transcript, with invented values and no
// captured log content. Grouping fragments by `step_index` and closing a step
// on `DONE` or `ERROR` is inferred, not documented by agy; the SC-011 live
// check is what confirms it.
describe('Feature 020 BUG-002 — agy lines project by their shape', () => {
  const SELECTION: PhaseLogSelection = {
    queueId: 'q1',
    taskId: 'run-1',
    pipelineId: 'pipe-1',
    phaseId: 'phase-1',
    iterationN: 1
  };
  const CAPS = { perFieldBytes: 1024 * 1024, maxEntries: 1000 };
  const logger = new SanitizedLogger();
  const sanitize = (s: string): string => logger.sanitize(s);

  type KindAndBody = Pick<PhaseLogDisplayEntry, 'kind' | 'body'>;

  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-agy-'))
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function streamPath(): string {
    return path.join(
      workspaceRoot, '.schegent', 'sessions', 'run-1', 'diagnostics',
      'pipe-1', 'phase-1', 'iter-1', 'stream.jsonl'
    );
  }

  function serialize(lines: readonly object[]): string {
    return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  }

  async function writeStream(text: string): Promise<void> {
    await fs.mkdir(path.dirname(streamPath()), { recursive: true });
    await fs.writeFile(streamPath(), text);
  }

  async function readStream(): Promise<IterationManifest> {
    return readIterationManifest({
      workspaceRoot,
      selection: SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: CAPS,
      sanitize
    });
  }

  function step(
    stepIndex: number,
    stepType: string,
    state: 'ACTIVE' | 'DONE' | 'ERROR',
    fields: Readonly<Record<string, unknown>> = {}
  ): object {
    return {
      event: 'step_update',
      step_type: stepType,
      state,
      step_index: stepIndex,
      conversation_id: 'conversation-1',
      ...fields
    };
  }

  function kindAndBody(entries: readonly PhaseLogDisplayEntry[]): KindAndBody[] {
    return entries.map(({ kind, body }) => ({ kind, body }));
  }

  function withoutSeq(
    entries: readonly PhaseLogDisplayEntry[]
  ): Array<Omit<PhaseLogDisplayEntry, 'seq'>> {
    return entries.map(({ kind, ts, body, bodyTruncated }) => ({ kind, ts, body, bodyTruncated }));
  }

  const FIXTURE: readonly object[] = [
    { event: 'init', conversation_id: 'conversation-1', version: 'v-test' },
    step(0, 'user_input', 'ACTIVE', { text_delta: 'Write the ' }),
    step(0, 'user_input', 'DONE', { text_delta: 'plan.' }),
    step(1, 'system_message', 'DONE', { text_delta: 'Workspace opened.' }),
    step(2, 'agent_response', 'ACTIVE', { text_delta: 'Reading ' }),
    step(2, 'agent_response', 'ACTIVE', { text_delta: 'the spec ' }),
    step(2, 'agent_response', 'DONE', { text_delta: 'first.', usage: { output_tokens: 3 } }),
    step(3, 'tool', 'ACTIVE', { tool_name: 'read_file', tool_info: { path: 'spec.md' } }),
    step(3, 'tool', 'DONE', { tool_name: 'read_file', duration_seconds: 1 }),
    step(4, 'checkpoint', 'DONE', { text_delta: 'Saved a checkpoint.' }),
    step(5, 'error_message', 'ACTIVE', { text_delta: 'Rate limit ' }),
    step(5, 'error_message', 'ERROR', { text_delta: 'reached.' }),
    {
      event: 'result',
      conversation_id: 'conversation-1',
      duration_seconds: 9,
      usage: { output_tokens: 3 }
    }
  ];

  const EXPECTED: readonly KindAndBody[] = [
    {
      kind: 'system',
      body: { systemSubtype: 'init', systemSummary: 'conversation_id=conversation-1 version=v-test' }
    },
    { kind: 'system', body: { systemSubtype: 'user_input', systemSummary: 'Write the plan.' } },
    { kind: 'system', body: { systemSubtype: 'system_message', systemSummary: 'Workspace opened.' } },
    { kind: 'assistant-text', body: { text: 'Reading the spec first.' } },
    {
      kind: 'tool-use',
      body: { toolName: 'read_file', toolInput: '{"path":"spec.md"}', toolArguments: { path: 'spec.md' } }
    },
    { kind: 'system', body: { systemSubtype: 'checkpoint', systemSummary: 'Saved a checkpoint.' } },
    { kind: 'system', body: { systemSubtype: 'error_message', systemSummary: 'Rate limit reached.' } },
    {
      kind: 'result',
      body: {
        resultSummary: 'conversation_id=conversation-1 duration_seconds=9 usage={"output_tokens":3}'
      }
    }
  ];

  it('reads a non-empty feed, one entry per step with its text fragments coalesced', async () => {
    await writeStream(serialize(FIXTURE));

    const manifest = await readStream();

    expect(manifest.verboseDiagnosticsState.kind).toBe('entries-present');
    expect(manifest.skippedLines).toBe(0);
    expect(kindAndBody(manifest.entries)).toEqual(EXPECTED);
  });

  it('yields the same entries from a tail that sees the lines arrive in pieces', async () => {
    const text = serialize(FIXTURE);
    // One cut between two fragments of the same step, one inside a line.
    const betweenFragments = text.indexOf('\n', text.indexOf('Reading ')) + 1;
    const insideLine = text.indexOf('read_file');
    expect(insideLine).toBeGreaterThan(betweenFragments);
    const pieces = [
      text.slice(0, betweenFragments),
      text.slice(betweenFragments, insideLine),
      text.slice(insideLine)
    ];
    const pushed: LiveLogBatchItem[] = [];
    const session = new PhaseLogTailSession({
      sessionId: 's1',
      workspaceRoot,
      filePath: streamPath(),
      selection: SELECTION,
      postBatch: (batch) => {
        pushed.push(...batch.entries);
        return true;
      },
      sanitize,
      caps: { perFieldBytes: CAPS.perFieldBytes }
    });

    await writeStream('');
    await session.start();
    session.ack({ batchSeq: 0 });
    for (const piece of pieces) {
      await fs.appendFile(streamPath(), piece);
      await session.tick();
    }
    const read = await readStream();

    expect(read.entries).toHaveLength(EXPECTED.length);
    // FR-R6-F07 (FR-012) — the tail started on an empty file, so it leads with
    // one `not-yet-produced` gap; every entry after it matches the read.
    const entries = pushed.map((p) => p.entry);
    const leading = entries.at(0);
    expect(leading?.kind).toBe('coverage-gap');
    expect(leading?.body.reason).toBe('not-yet-produced');
    expect(withoutSeq(entries.slice(1))).toEqual(withoutSeq(read.entries));
  });

  it('holds no step from before the tailed file was truncated', async () => {
    const pushed: LiveLogBatchItem[] = [];
    const session = new PhaseLogTailSession({
      sessionId: 's1',
      workspaceRoot,
      filePath: streamPath(),
      selection: SELECTION,
      postBatch: (batch) => {
        pushed.push(...batch.entries);
        return true;
      },
      sanitize,
      caps: { perFieldBytes: CAPS.perFieldBytes }
    });
    await writeStream(serialize([
      step(2, 'agent_response', 'ACTIVE', { text_delta: 'Held from the first file. ' }),
      step(3, 'checkpoint', 'DONE', { text_delta: 'Saved a checkpoint.' })
    ]));
    await session.start();
    session.ack({ batchSeq: 0 });
    await session.tick();

    await writeStream(serialize([step(2, 'agent_response', 'DONE', { text_delta: 'Fresh.' })]));
    await session.tick();

    expect(kindAndBody(pushed.map((p) => p.entry))).toEqual([
      { kind: 'system', body: { systemSubtype: 'checkpoint', systemSummary: 'Saved a checkpoint.' } },
      // FR-R6-F07 (FR-012) — the shorter file is a replaced source, announced before its records.
      { kind: 'coverage-gap', body: { reason: 'source-replaced', count: 1, bytes: 0 } },
      { kind: 'assistant-text', body: { text: 'Fresh.' } }
    ]);
  });

  it('holds at most MAX_OPEN_AGY_STEPS steps open, emitting the oldest when one more opens', async () => {
    expect(MAX_OPEN_AGY_STEPS).toBeGreaterThan(1);
    const opened = Array.from({ length: MAX_OPEN_AGY_STEPS + 1 }, (_, i) =>
      step(i, 'agent_response', 'ACTIVE', { text_delta: `step ${i}` })
    );
    const closed = Array.from({ length: MAX_OPEN_AGY_STEPS }, (_, i) =>
      step(i + 1, 'agent_response', 'DONE')
    );
    await writeStream(serialize([...opened, ...closed]));

    const manifest = await readStream();

    expect(manifest.entries.map((entry) => entry.body.text)).toEqual(
      Array.from({ length: MAX_OPEN_AGY_STEPS + 1 }, (_, i) => `step ${i}`)
    );
  });

  it('keeps at most MAX_AGY_STEP_TEXT_LENGTH characters of a step, never half a surrogate pair', async () => {
    expect(MAX_AGY_STEP_TEXT_LENGTH).toBeGreaterThan(1);
    const kept = 'a'.repeat(MAX_AGY_STEP_TEXT_LENGTH - 1);
    const astral = String.fromCodePoint(0x1d400);
    await writeStream(serialize([
      step(0, 'agent_response', 'ACTIVE', { text_delta: kept }),
      step(0, 'agent_response', 'ACTIVE', { text_delta: `${astral} past the cap` }),
      step(0, 'agent_response', 'DONE', { text_delta: 'more past the cap' })
    ]));

    const manifest = await readStream();

    expect(manifest.entries.map((entry) => entry.body.text)).toEqual([kept]);
  });
});
