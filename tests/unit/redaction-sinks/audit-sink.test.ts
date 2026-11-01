import { promises as fsp } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { mask } from '../../fixtures/redaction-corpus';
import { assertAbsentIn, assertRedactedIn, casesFor } from './sink-cases';

/**
 * FR-R4-F10 (contract test T10; SK1 to SK3; FR-024, FR-025; hard rules 21, 22) -- the audit log
 * writer, driven through its real `append` path into a temporary workspace's `.schegent/audit.log`,
 * and read back as the JSONL it wrote.
 *
 * WHAT THE WRITER DOES WITH A SECRET. It does not quietly redact a payload: it projects the payload,
 * runs `sanitizeRecord` over the whole entry, and when that changed the payload it REFUSES the entry
 * with `secret-detected` and writes nothing. A field outside the payload (here the run id) is
 * redacted and written. So a supported case is checked two ways: placed in a payload it must be
 * refused and absent from the log, and placed in the run id it must be written redacted. A negative
 * case must be written byte-identical in its payload, and a record keyed `input_tokens` must keep its
 * number.
 *
 * Hard rule 21: the log is written only by the real writer. Hard rule 22: no line holds the temporary
 * workspace root or the home directory.
 */
let root: string;
let writer: AuditLogWriter;

const logFile = (): string => path.join(root, '.schegent', 'audit.log');

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'redaction-audit-sink-'));
  const logger = new SanitizedLogger([]);
  writer = new AuditLogWriter({ workspaceRoot: root }, logger);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function entryWith(payload: Record<string, unknown>, runId = 'run-1') {
  return { runId, phase: 'implement', iteration: 1, eventType: 'phase-start', outcome: 'info', payload } as never;
}

async function readLog(): Promise<string> {
  return fsp.readFile(logFile(), 'utf8').catch(() => '');
}

async function rows(): Promise<Array<{ runId: string; payload: Record<string, unknown> }>> {
  return (await readLog())
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { runId: string; payload: Record<string, unknown> });
}

/** The append is refused for a secret: nothing was written for it. */
async function expectRefused(payload: Record<string, unknown>): Promise<void> {
  await expect(writer.append(entryWith(payload))).rejects.toMatchObject({ reasonCode: 'secret-detected' });
}

describe('the audit log writer, plain string cases (SK1 to SK3)', () => {
  it('refuses a supported secret placed in a payload, and writes none of it', async () => {
    const supported = casesFor('audit').filter(
      (testCase) => testCase.expected === 'redacted' || testCase.expected === 'over-redacted'
    );
    expect(supported.length).toBeGreaterThan(20);
    for (const testCase of supported) {
      await expectRefused({ detail: testCase.build() });
      assertAbsentIn(await readLog(), testCase, 'audit payload');
    }
  });

  it('writes a supported secret placed in a field outside the payload redacted', async () => {
    const supported = casesFor('audit').filter((testCase) => testCase.expected === 'redacted');
    for (const testCase of supported) {
      const written = await writer.append(entryWith({ ok: true }, testCase.build()));
      assertRedactedIn(written.runId, testCase, 'audit run id (returned entry)');
    }
    const onDisk = await rows();
    expect(onDisk).toHaveLength(supported.length);
    supported.forEach((testCase, index) => {
      assertRedactedIn(onDisk.at(index)?.runId ?? '', testCase, 'audit run id (read back)');
    });
  });

  it('writes every negative case byte-identical in its payload', async () => {
    const negatives = casesFor('audit').filter((testCase) => testCase.expected === 'preserved');
    expect(negatives.length).toBeGreaterThanOrEqual(8);
    for (const testCase of negatives) {
      await writer.append(entryWith({ detail: testCase.build() }));
    }
    const onDisk = await rows();
    expect(onDisk).toHaveLength(negatives.length);
    negatives.forEach((testCase, index) => {
      expect(onDisk.at(index)?.payload['detail'], `audit payload: ${testCase.name}: a negative case was changed`).toBe(
        testCase.build()
      );
    });
  });

  it('records each unsupported and over-redacted case with its reason', async () => {
    for (const testCase of casesFor('audit').filter(
      (candidate) => candidate.expected === 'unsupported' || candidate.expected === 'over-redacted'
    )) {
      console.log(`[FR-R4-F10 sinks] audit: ${testCase.expected}: ${testCase.name}: ${testCase.reason}`);
      expect((testCase.reason ?? '').length).toBeGreaterThan(20);
    }
  });
});

describe('the audit log writer, structured records (SK2)', () => {
  const structured = casesFor('audit', 'structured');

  it('has structured cases to run', () => {
    expect(structured.filter((testCase) => testCase.key !== undefined).length).toBeGreaterThanOrEqual(3);
    expect(structured.some((testCase) => testCase.key === undefined)).toBe(true);
  });

  it.each(
    casesFor('audit', 'structured').map((testCase) => [testCase.name, testCase] as const)
  )('refuses %s in every placement and writes none of it', async (_name, testCase) => {
    const value = testCase.build();
    const placements: Array<Record<string, unknown>> =
      testCase.key === undefined
        ? [{ list: [value] }, { nested: { list: [value] } }]
        : [{ [testCase.key]: value }, { nested: { [testCase.key]: value } }, { list: [{ [testCase.key]: value }] }];
    for (const payload of placements) {
      await expectRefused(payload);
    }
    assertAbsentIn(await readLog(), testCase, 'audit structured');
  });

  it('keeps an input_tokens number, and a number under a secret-looking key', async () => {
    await writer.append(entryWith({ input_tokens: 123456789, output_tokens: 5678, token: 12345 }));
    const row = (await rows()).at(0);
    expect(row?.payload['input_tokens']).toBe(123456789);
    expect(row?.payload['output_tokens']).toBe(5678);
    expect(row?.payload['token']).toBe(12345);
  });
});

describe('what the writer wrote reveals nothing about the machine (hard rule 22)', () => {
  it('holds neither the temporary workspace root nor the home directory in any line', async () => {
    const negatives = casesFor('audit').filter((testCase) => testCase.expected === 'preserved');
    for (const testCase of negatives) await writer.append(entryWith({ detail: testCase.build() }));
    const text = await readLog();
    expect(text.length).toBeGreaterThan(0);
    expect(text, `a line holds the temporary root ${mask(root)}`).not.toContain(root);
    expect(text, 'a line holds the home directory').not.toContain(homedir());
  });
});

describe('the writer is the only way these rows were written (hard rule 21)', () => {
  it('leaves the log absent until the real writer appends', async () => {
    expect(await readLog()).toBe('');
    await writer.append(entryWith({ ok: true }));
    expect((await rows()).length).toBe(1);
  });
});
