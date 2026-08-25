// Feature 098 (PRIV-01) — one sanitizer, two readers.
//
// The reader (reopen a completed phase) and the tail session (watch a
// live phase) both scrub body strings at the IPC boundary, but they used
// to own separate field lists. The tail's list was missing `toolName`,
// `systemSubtype`, and the whole nested `toolArguments` subtree, so the
// same on-disk bytes redacted differently depending on whether the
// operator was watching the phase run or opened it afterwards.
//
// The `tool-use` case is the sharp one: the projector emits the tool's
// input TWICE — once JSON-stringified into `toolInput` and once
// structured into `toolArguments`. The tail scrubbed the first copy and
// shipped the second verbatim, so a redacted string and its cleartext
// original travelled in the same message.
//
// These are the shared canaries the review's testing-gap register asks
// for: one entry, both paths, byte-identical output.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  SANITIZED_BODY_FIELDS,
  sanitizeDisplayEntryBody
} from '../../../../src/services/phase-log/phase-log-sanitizer';
import { readIterationManifest } from '../../../../src/services/phase-log/phase-log-reader';
import {
  PhaseLogTailSession,
  type PhaseLogEntryPushPayload
} from '../../../../src/services/phase-log/phase-log-tail-session';
import type {
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from '../../../../src/services/phase-log/types';

const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);

const API_KEY = 'sk-ant-api03-CANARYCANARYCANARYCANARY0123456789';
const GH_TOKEN = 'ghp_CANARYCANARYCANARYCANARYCANARY0123';
const AWS_KEY = 'AKIACANARY0123456789';

const SELECTION: PhaseLogSelection = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: 1
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-sanitizer-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function streamPath(): string {
  return path.join(
    tmpDir, '.schegent', 'sessions', 'run-1', 'diagnostics',
    'pipe-1', 'phase-1', 'iter-1', 'stream.jsonl'
  );
}

/**
 * A `tool_use` line whose input carries secrets at several nesting
 * depths, inside an array, and in the tool name itself.
 */
const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        name: `Bash(${API_KEY})`,
        input: {
          command: `curl -H "Authorization: ${API_KEY}"`,
          env: { GITHUB_TOKEN: GH_TOKEN, nested: { deep: AWS_KEY } },
          args: ['--key', API_KEY, 42, true, null]
        }
      }
    ]
  }
});

const SYSTEM_LINE = JSON.stringify({
  type: 'system',
  subtype: `init ${GH_TOKEN}`,
  cwd: `/w/${AWS_KEY}`
});

async function writeStream(lines: readonly string[]): Promise<void> {
  const p = streamPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${lines.join('\n')}\n`);
}

/** Drive one tail tick over the written stream and collect the pushes. */
async function tailEntries(): Promise<readonly PhaseLogDisplayEntry[]> {
  const pushed: PhaseLogEntryPushPayload[] = [];
  const session = new PhaseLogTailSession({
    sessionId: 's1',
    workspaceRoot: tmpDir,
    filePath: streamPath(),
    selection: SELECTION,
    pushToWebview: (msg) => pushed.push(msg),
    sanitize,
    caps: { perFieldBytes: 64 * 1024 }
  });
  await session.tick();
  return pushed.map((p) => p.entry);
}

/** Read the same stream back the way a reopen does. */
async function readerEntries(): Promise<readonly PhaseLogDisplayEntry[]> {
  const manifest = await readIterationManifest({
    workspaceRoot: tmpDir,
    selection: SELECTION,
    isInFlight: false,
    caps: { perFieldBytes: 64 * 1024, maxEntries: 1000 },
    sanitize
  });
  return manifest.entries;
}

/** Every string leaf anywhere in the body, at any depth. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
  return out;
}

function expectNoSecrets(entries: readonly PhaseLogDisplayEntry[]): void {
  const haystack = stringLeaves(entries.map((e) => e.body)).join('\n');
  expect(haystack).not.toContain(API_KEY);
  expect(haystack).not.toContain(GH_TOKEN);
  expect(haystack).not.toContain(AWS_KEY);
}

describe('phase-log sanitizer — shared field set (PRIV-01)', () => {
  it('covers every body field the projector can populate with a string', () => {
    // Guards against a field being added to the projector and quietly
    // skipped here; `isError` is a boolean and `reason` is a closed
    // enum of tail-ended reasons, so neither is operator content.
    expect([...SANITIZED_BODY_FIELDS]).toEqual([
      'text',
      'toolName',
      'toolInput',
      'toolResult',
      'systemSubtype',
      'systemSummary',
      'resultSummary'
    ]);
  });

  it('scrubs string leaves of toolArguments at every depth and inside arrays', () => {
    const entry: PhaseLogDisplayEntry = {
      seq: 1,
      kind: 'tool-use',
      ts: null,
      body: {
        toolName: `Bash(${API_KEY})`,
        toolInput: API_KEY,
        toolArguments: {
          command: API_KEY,
          env: { nested: { deep: GH_TOKEN } },
          args: ['--key', AWS_KEY, 7, false, null]
        }
      },
      bodyTruncated: null
    };

    const out = sanitizeDisplayEntryBody(entry, sanitize);
    expectNoSecrets([out]);

    // Shape and non-string leaves survive untouched.
    const args = out.body.toolArguments as {
      env: { nested: { deep: string } };
      args: readonly unknown[];
    };
    expect(args.env.nested.deep).toBe(sanitize(GH_TOKEN));
    expect(args.args.slice(2)).toEqual([7, false, null]);
  });

  it('returns the same reference when nothing needed redacting', () => {
    const entry: PhaseLogDisplayEntry = {
      seq: 1,
      kind: 'assistant-text',
      ts: null,
      body: { text: 'nothing secret here' },
      bodyTruncated: null
    };
    expect(sanitizeDisplayEntryBody(entry, sanitize)).toBe(entry);
  });
});

describe('phase-log sanitizer — live tail and reopen agree (PRIV-01)', () => {
  it('redacts identically whether the phase is watched live or reopened', async () => {
    await writeStream([TOOL_USE_LINE, SYSTEM_LINE]);

    const live = await tailEntries();
    const reopened = await readerEntries();

    expect(live.length).toBe(2);
    expect(reopened.length).toBe(2);
    for (let i = 0; i < live.length; i += 1) {
      expect(live[i]!.body).toEqual(reopened[i]!.body);
    }
  });

  it('leaks no secret on the live tail path', async () => {
    await writeStream([TOOL_USE_LINE, SYSTEM_LINE]);
    expectNoSecrets(await tailEntries());
  });

  it('leaks no secret on the reopen path', async () => {
    await writeStream([TOOL_USE_LINE, SYSTEM_LINE]);
    expectNoSecrets(await readerEntries());
  });

  it('never ships a redacted copy alongside its cleartext original', async () => {
    await writeStream([TOOL_USE_LINE]);
    const [entry] = await tailEntries();

    // The projector emits the tool input twice: stringified into
    // `toolInput` and structured into `toolArguments`. Both copies must
    // agree, or the redaction of one is undone by the other.
    expect(entry!.body.toolInput).not.toContain(API_KEY);
    expect(JSON.stringify(entry!.body.toolArguments)).not.toContain(API_KEY);
  });
});
