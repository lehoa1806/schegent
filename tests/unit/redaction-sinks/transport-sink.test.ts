import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTransportHarness, type TransportHarness } from '../monitor/transport/transport-harness';
import { assertAbsentIn, assertOutcomeIn, assertPreservedIn, casesFor } from './sink-cases';

/**
 * FR-R4-F10 (contract test T11; SK1 to SK3; FR-024, FR-025) -- the CLI transport sink, driven through
 * `createCliTransportSink` over the real router and store, and read back from the per-Run transport
 * file it wrote.
 *
 * WHAT IT PINS. The sink is line-oriented: it sanitizes one CLI line per call, and a private-key block
 * arrives as many records. A string-level fix alone would leave the key in this log while the redactor's
 * own tests stayed green, so each framing the sink sees is exercised: a plain case as one record on
 * each stream of two Runs; a complete block spread over N records; a block whose footer shares a line
 * with the next header; an unterminated block; two adjacent blocks; and stdout and stderr interleaved,
 * where the noise on the other stream must survive while the block body does not. The harness is the
 * transport suite's own (real sink, real router, real directories).
 */
const RUN_A = '5b8a1c22-7d3e-4f10-9c44-1a2b3c4d5e6f';
const RUN_B = '9e0f6a11-2b3c-4d55-8e66-7a8b9c0d1e2f';

let harness: TransportHarness;

beforeEach(async () => {
  harness = await createTransportHarness({ setting: 'on' });
});

afterEach(async () => {
  await harness.dispose();
});

async function readRun(runId: string): Promise<string> {
  return fs.readFile(harness.runFile(runId), 'utf8').catch(() => '');
}

describe('the transport sink, plain string cases on both streams of two Runs', () => {
  it('writes no part of a supported secret and every negative whole', async () => {
    const cases = casesFor('transport');
    for (const [index, testCase] of cases.entries()) {
      // One record per case, alternating the Run and the stream, so both Runs and both streams are read.
      const runId = index % 2 === 0 ? RUN_A : RUN_B;
      harness.record(runId, testCase.build(), { stream: index % 4 < 2 ? 'stdout' : 'stderr' });
    }
    await harness.flush();
    const [fileA, fileB] = [await readRun(RUN_A), await readRun(RUN_B)];
    expect(fileA.length).toBeGreaterThan(0);
    expect(fileB.length).toBeGreaterThan(0);
    for (const [index, testCase] of cases.entries()) {
      assertOutcomeIn(index % 2 === 0 ? fileA : fileB, testCase, 'transport');
    }
  });

  it('records one line per record, with the stream named', async () => {
    harness.record(RUN_A, 'a plain stdout line', { stream: 'stdout' });
    harness.record(RUN_A, 'a plain stderr line', { stream: 'stderr' });
    await harness.flush();
    const lines = (await readRun(RUN_A)).split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.at(0)).toMatch(/\tstdout\ta plain stdout line$/);
    expect(lines.at(1)).toMatch(/\tstderr\ta plain stderr line$/);
  });
});

describe('the transport sink, private-key blocks across records (SK2)', () => {
  const blocks = casesFor('transport', 'split-key-block');

  it('has the four block framings to run', () => {
    expect(blocks.map((testCase) => testCase.name)).toEqual([
      'complete private-key block',
      'private-key block split across records with the footer beside the next header',
      'unterminated private-key block',
      'two adjacent private-key blocks'
    ]);
  });

  it.each(blocks.map((testCase, index) => [testCase.name, testCase, index] as const))(
    '%s: no body line survives, and the other stream still does',
    async (_name, testCase, index) => {
      const runId = `0000000${index}-aaaa-4bbb-8ccc-dddddddddddd`;
      const lines = testCase.build().split('\n');
      // The block arrives on stdout, one line per record, with stderr noise between the lines.
      lines.forEach((line, position) => {
        harness.record(runId, line, { stream: 'stdout' });
        harness.record(runId, `stderr noise ${position}`, { stream: 'stderr' });
      });
      await harness.flush();
      const file = await readRun(runId);
      assertAbsentIn(file, testCase, 'transport block');
      expect(file, 'the other stream was suppressed along with the block').toContain(`stderr noise ${lines.length - 1}`);
      for (const kept of testCase.keep ?? []) {
        expect(file, `${testCase.name}: ${kept} was outside the block and must stay`).toContain(kept);
      }
    }
  );

  it('does not let a block opened on one Run suppress another Run', async () => {
    const block = blocks.find((testCase) => testCase.name === 'unterminated private-key block');
    expect(block).toBeDefined();
    for (const line of (block?.build() ?? '').split('\n')) harness.record(RUN_A, line, { stream: 'stdout' });
    harness.record(RUN_B, 'an ordinary line from another Run', { stream: 'stdout' });
    await harness.flush();
    expect(await readRun(RUN_B)).toContain('an ordinary line from another Run');
  });

  it('keeps a public key block whole', async () => {
    const publicKey = casesFor('transport').find((testCase) => testCase.name === 'a public key block');
    expect(publicKey).toBeDefined();
    harness.record(RUN_A, (publicKey as NonNullable<typeof publicKey>).build(), { stream: 'stdout' });
    await harness.flush();
    assertPreservedIn(await readRun(RUN_A), publicKey as NonNullable<typeof publicKey>, 'transport');
  });
});
