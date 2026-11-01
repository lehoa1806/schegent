import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTION_SENTINEL, SanitizedLogger } from '../../../src/lib/logger';
import {
  PhaseLogTailSession,
  type PhaseLogEntryPushPayload
} from '../../../src/services/phase-log/phase-log-tail-session';
import type { PhaseLogSelection } from '../../../src/services/phase-log/types';
import { assertAbsentIn, assertOutcomeIn, casesFor } from './sink-cases';

/**
 * FR-R4-F10 (contract test T13; SK1 to SK3; FR-024, FR-025, FR-026; hard rule 25) -- the host-side
 * tail of a running phase, driven through a real `PhaseLogTailSession` over a real `stream.jsonl`,
 * and read back from the message objects it posts to the webview.
 *
 * WHAT IT PINS. The projector emits a tool's input twice: JSON-stringified into `toolInput` and
 * structured into `toolArguments`. A redactor that works on the string only masks the first and ships
 * the second in cleartext beside it (feature 098, PRIV-01). With key-name redaction that is now a
 * question about keys, so a tool call whose input holds `{ "password": ... }` must come out with BOTH
 * copies masked in the SAME message. Every plain string case is delivered as an assistant text line.
 * Redaction stays on the host, before the content crosses to the webview, and the webview does not
 * re-sanitize `toolArguments` (hard rule 25).
 */
const SELECTION: PhaseLogSelection = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: 1
};
const logger = new SanitizedLogger();
const sanitize = (text: string): string => logger.sanitize(text);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redaction-webview-tail-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function streamPath(): string {
  return path.join(tmpDir, '.schegent', 'sessions', 'run-1', 'diagnostics', 'pipe-1', 'phase-1', 'iter-1', 'stream.jsonl');
}

async function postedFor(lines: readonly string[]): Promise<PhaseLogEntryPushPayload[]> {
  await fs.mkdir(path.dirname(streamPath()), { recursive: true });
  await fs.writeFile(streamPath(), `${lines.join('\n')}\n`);
  const posted: PhaseLogEntryPushPayload[] = [];
  const session = new PhaseLogTailSession({
    sessionId: 's1',
    workspaceRoot: tmpDir,
    filePath: streamPath(),
    selection: SELECTION,
    pushToWebview: (message) => posted.push(message),
    sanitize,
    caps: { perFieldBytes: 64 * 1024 }
  });
  await session.tick();
  return posted;
}

const textLine = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const toolUseLine = (input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Deploy', input }] } });

describe('the webview tail, plain string cases as assistant text', () => {
  it('posts no part of a supported secret and every negative whole', async () => {
    const cases = casesFor('webview-tail');
    const posted = await postedFor(cases.map((testCase) => textLine(testCase.build())));
    expect(posted).toHaveLength(cases.length);
    cases.forEach((testCase, index) => {
      assertOutcomeIn(posted.at(index)?.entry.body.text ?? '', testCase, 'webview tail text');
    });
  });
});

describe('the webview tail, a tool call whose input holds a secret under a key (SK2)', () => {
  const keyed = casesFor('webview-tail', 'structured').filter((testCase) => testCase.key !== undefined);

  it('has keyed cases to run', () => {
    expect(keyed.length).toBeGreaterThanOrEqual(3);
  });

  it.each(keyed.map((testCase) => [testCase.name, testCase] as const))(
    '%s: toolInput and toolArguments are both masked in one posted message',
    async (_name, testCase) => {
      const key = testCase.key as string;
      const value = testCase.build();
      const posted = await postedFor([toolUseLine({ [key]: value, target: 'staging', count: 3 })]);
      expect(posted).toHaveLength(1);
      const { body } = (posted.at(0) as PhaseLogEntryPushPayload).entry;
      assertAbsentIn(body.toolInput ?? '', testCase, 'webview tail toolInput');
      assertAbsentIn(JSON.stringify(body.toolArguments), testCase, 'webview tail toolArguments');
      expect(body.toolArguments).toEqual({ [key]: REDACTION_SENTINEL, target: 'staging', count: 3 });
      expect(body.toolInput).toContain(`"${key}"`);
    }
  );

  it('masks a nested keyed string and one inside an array, and keeps a token-usage number', async () => {
    const value = casesFor('webview-tail', 'structured').find((testCase) => testCase.key === 'client_secret');
    const secret = (value as NonNullable<typeof value>).build();
    const posted = await postedFor([
      toolUseLine({ nested: { client_secret: secret }, steps: [{ password: secret }], input_tokens: 4096 })
    ]);
    const { body } = (posted.at(0) as PhaseLogEntryPushPayload).entry;
    expect(JSON.stringify(body.toolArguments)).not.toContain(secret);
    expect(body.toolInput).not.toContain(secret);
    expect(body.toolArguments).toEqual({
      nested: { client_secret: REDACTION_SENTINEL },
      steps: [{ password: REDACTION_SENTINEL }],
      input_tokens: 4096
    });
  });

  it('leaves a tool call with no secret key and no secret pattern whole', async () => {
    const input = { command: 'ls -la', tokenizer: 'wordpiece', path: '/tmp/example/work' };
    const posted = await postedFor([toolUseLine(input)]);
    expect((posted.at(0) as PhaseLogEntryPushPayload).entry.body.toolArguments).toEqual(input);
  });
});
