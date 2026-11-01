import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneralSettingsConfig } from '../../../src/config/general-settings';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  __resetRuntimeLogAccessorWarnCache,
  createRuntimeLogAccessor
} from '../../../src/lib/runtime-log/runtime-log-settings';
import { RuntimeLogSink } from '../../../src/lib/runtime-log/runtime-log-sink';
import { SchegentOutputChannel, type OutputChannelLike } from '../../../src/ui/output-channel';
import { assertAbsentIn, assertOutcomeIn, casesFor } from './sink-cases';

/**
 * FR-R4-F10 (contract test T12; SK1 to SK3; FR-024, FR-025) -- the runtime log and the output
 * channel, each driven through its real caller and read back from what it wrote.
 *
 * WHAT IT PINS. Two sinks take the host's log lines. `SanitizedLogger.write` sanitizes a message
 * before any sink sees it, and `formatWithContext` folds a context object into the line as JSON
 * BEFORE that, so a secret in a context value is redacted in its escaped form (a quoted key inside a
 * JSON string reads `\"key\"`). The runtime-log sink writes the line to a file, and the output channel
 * appends it to a VS Code channel; the channel's own `log()` sanitizes a message too. So each case
 * is delivered as a message and as a context value to the file, and as `log()` and as a logger line to
 * a recording channel, and the file and the recorded lines are what is asserted on, not the
 * redactor's return value.
 */
let tmpRoot: string;
let target: string;

function makeConfig(pathValue: string): GeneralSettingsConfig {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (key === 'logging.runtimeLogLevel') return 'DEBUG' as T;
      if (key === 'logging.runtimeLogFilePath') return pathValue as T;
      return defaultValue as T;
    },
    update: async () => undefined
  } as unknown as GeneralSettingsConfig;
}

function wire(): { logger: SanitizedLogger; sink: RuntimeLogSink } {
  const logger = new SanitizedLogger();
  const accessor = createRuntimeLogAccessor(() => makeConfig(target), () => null, logger);
  const sink = new RuntimeLogSink({ accessor, fallbackLogger: logger });
  logger.addSink(sink);
  return { logger, sink };
}

beforeEach(async () => {
  __resetRuntimeLogAccessorWarnCache();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'redaction-runtime-log-'));
  target = path.join(tmpRoot, '.schegent', 'syslog');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readTarget(): Promise<string> {
  return fs.readFile(target, 'utf8').catch(() => '');
}

describe('the runtime-log file (SK1 to SK3)', () => {
  it('holds no part of a supported secret and every negative whole, for a message', async () => {
    const { logger, sink } = wire();
    const cases = casesFor('runtime-log');
    for (const testCase of cases) logger.info(testCase.build());
    await sink.flushPendingWrites();
    const text = await readTarget();
    expect(text.length).toBeGreaterThan(0);
    for (const testCase of cases) assertOutcomeIn(text, testCase, 'runtime log message');
  });

  it('holds no part of a supported secret for a value in the context object, which is serialized into the line first', async () => {
    const { logger, sink } = wire();
    const cases = casesFor('runtime-log').filter(
      (testCase) => testCase.expected === 'redacted' || testCase.expected === 'over-redacted'
    );
    for (const testCase of cases) logger.info('event', { value: testCase.build() });
    await sink.flushPendingWrites();
    const text = await readTarget();
    expect(text).toContain('"value"');
    for (const testCase of cases) assertAbsentIn(text, testCase, 'runtime log context');
  });

  it('keeps a negative whole inside a context value, in its JSON-escaped form', async () => {
    const { logger, sink } = wire();
    const negatives = casesFor('runtime-log').filter((testCase) => testCase.expected === 'preserved');
    for (const testCase of negatives) logger.info('event', { value: testCase.build() });
    await sink.flushPendingWrites();
    const text = await readTarget();
    for (const testCase of negatives) {
      expect(text, `runtime log context: ${testCase.name}: a negative case was changed`).toContain(
        JSON.stringify(testCase.build()).slice(1, -1)
      );
    }
  });

  it('redacts a key that names a secret when the context object is serialized', async () => {
    const { logger, sink } = wire();
    const value = casesFor('audit', 'structured').find((testCase) => testCase.key === 'client_secret');
    expect(value).toBeDefined();
    const secret = (value as NonNullable<typeof value>).build();
    logger.info('event', { client_secret: secret, input_tokens: 123456789 });
    await sink.flushPendingWrites();
    const text = await readTarget();
    expect(text).not.toContain(secret);
    expect(text).toContain('"client_secret"');
    expect(text).toContain('"input_tokens":123456789');
  });
});

describe('the output channel (SK1 to SK3)', () => {
  function recordingChannel(): { channel: OutputChannelLike; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      channel: { appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined }
    };
  }

  it('appends no part of a supported secret through log(), and every negative whole', () => {
    const { channel, lines } = recordingChannel();
    const output = new SchegentOutputChannel(channel, new SanitizedLogger());
    const cases = casesFor('runtime-log');
    for (const testCase of cases) output.log(testCase.build());
    const text = lines.join('\n');
    expect(lines.length).toBe(cases.length);
    for (const testCase of cases) assertOutcomeIn(text, testCase, 'output channel log()');
  });

  it('appends no part of a supported secret through a logger line it is attached to', () => {
    const { channel, lines } = recordingChannel();
    const logger = new SanitizedLogger();
    new SchegentOutputChannel(channel, logger);
    const cases = casesFor('runtime-log');
    for (const testCase of cases) logger.warn(testCase.build());
    const text = lines.join('\n');
    expect(lines.length).toBe(cases.length);
    for (const testCase of cases) assertOutcomeIn(text, testCase, 'output channel logger line');
  });
});
