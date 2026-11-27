import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CHUNK_BYTES,
  DEFAULT_MAX_READ_BYTES,
  judgeSize,
  readBoundedRange,
  readBoundedTail
} from '../../../src/lib/bounded-read';

/**
 * FR-R3-052 (H-03) — the adversarial fixture the acceptance asks for: a **sparse
 * multi-GiB file**, produced with `ftruncate`, so allocation is measured against a
 * file far larger than the process could hold.
 *
 * Sparse is what makes this cheap and what makes it realistic. A rotation that
 * never happened leaves a genuinely large phase log; nothing here needs an
 * attacker, and the test costs no disk.
 */
const FOUR_GIB = 4 * 1024 * 1024 * 1024;

describe('a bounded read does not allocate in proportion to the file', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-bounded-'));
    file = path.join(dir, 'stream.jsonl');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A sparse file of `size` bytes, with `head` written at offset 0. */
  async function sparse(size: number, head = ''): Promise<void> {
    const handle = await fs.open(file, 'w');
    try {
      if (head.length > 0) await handle.write(head, 0);
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  it('reads a bounded prefix of a 4 GiB sparse file', async () => {
    await sparse(FOUR_GIB, 'first line\n');
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      expect(size).toBe(FOUR_GIB);

      const range = await readBoundedRange(handle, 0, size, 1024 * 1024);
      // The allocation is the BOUND, not the file. Without this the same call
      // asks Node for a 4 GiB Buffer.
      expect(range.bytes.length).toBe(1024 * 1024);
      expect(range.bytes.subarray(0, 10).toString('utf8')).toBe('first line');
      // And it says what it left behind.
      expect(range.skippedBytes).toBe(FOUR_GIB - 1024 * 1024);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('reads the TAIL of a 4 GiB sparse file, and reports the skip', async () => {
    await sparse(FOUR_GIB);
    const handle = await fs.open(file, 'r');
    try {
      const tail = await readBoundedTail(handle, FOUR_GIB, 64 * 1024);
      expect(tail.bytes.length).toBe(64 * 1024);
      expect(tail.nextOffset).toBe(FOUR_GIB);
      // A log's recent end is the useful one, and the 4 GiB skipped is reported
      // rather than presented as a complete answer.
      expect(tail.skippedBytes).toBe(FOUR_GIB - 64 * 1024);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('refuses a structured document that exceeds the bound, rather than truncating it', async () => {
    // Half a phase message is not a smaller phase message; it is invalid input.
    await sparse(FOUR_GIB);
    const handle = await fs.open(file, 'r');
    try {
      const verdict = await judgeSize(handle, 1024);
      expect(verdict.outcome).toBe('too-large');
      if (verdict.outcome !== 'too-large') return;
      expect(verdict.size).toBe(FOUR_GIB);
      expect(verdict.limit).toBe(1024);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('reads a small file whole, with nothing skipped', async () => {
    await fs.writeFile(file, 'line one\nline two\n');
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const range = await readBoundedRange(handle, 0, size);
      expect(range.bytes.toString('utf8')).toBe('line one\nline two\n');
      expect(range.skippedBytes).toBe(0);
      expect(range.nextOffset).toBe(size);
      expect((await judgeSize(handle)).outcome).toBe('within');
    } finally {
      await handle.close();
    }
  });

  it('resumes from an offset, which is how a tail advances', async () => {
    await fs.writeFile(file, 'aaaa\nbbbb\n');
    const handle = await fs.open(file, 'r');
    try {
      const first = await readBoundedRange(handle, 0, 5);
      expect(first.bytes.toString('utf8')).toBe('aaaa\n');
      const second = await readBoundedRange(handle, first.nextOffset, 5);
      expect(second.bytes.toString('utf8')).toBe('bbbb\n');
    } finally {
      await handle.close();
    }
  });

  it('returns empty rather than throwing when there is nothing to read', async () => {
    await fs.writeFile(file, '');
    const handle = await fs.open(file, 'r');
    try {
      const range = await readBoundedRange(handle, 0, 0);
      expect(range.bytes.length).toBe(0);
      expect(range.skippedBytes).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it('handles a short read without hanging or over-reporting', async () => {
    // A concurrent truncation: `available` says more than the file now holds.
    await fs.writeFile(file, 'short');
    const handle = await fs.open(file, 'r');
    try {
      const range = await readBoundedRange(handle, 0, 1_000_000);
      expect(range.bytes.toString('utf8')).toBe('short');
      expect(range.nextOffset).toBe(5);
      expect(range.skippedBytes).toBe(1_000_000 - 5);
    } finally {
      await handle.close();
    }
  });

  it('keeps the chunk size fixed and well below the default bound', () => {
    // If the chunk ever tracked the bound, allocation would track the file again.
    expect(CHUNK_BYTES).toBe(64 * 1024);
    expect(DEFAULT_MAX_READ_BYTES).toBeGreaterThan(CHUNK_BYTES * 16);
  });
});

describe('the three migrated readers are bounded (FR-R3-052)', () => {
  it('no reader takes a whole file before checking its size', async () => {
    // The three sites the review named, asserted as a property of the source
    // rather than re-derived per reader. Each was a different shape of the same
    // defect, and a test per reader would let a fourth arrive unnoticed.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '..', '..', '..');
    const migrated = [
      'src/controller/phase-sidecar-reader.ts',
      'src/services/phase-log/phase-log-reader.ts',
      'src/services/phase-log/phase-log-tail-session.ts'
    ];
    for (const relative of migrated) {
      // CODE lines only. Each of these files documents the call it replaced, and
      // a whole-file text match flags that comment -- the same false-positive
      // class corrected in the `appendFile` gate under FR-R3-053. Matching a
      // comment pressures an author to write a worse comment.
      const body = readFileSync(resolve(root, relative), 'utf8')
        .split(/\r?\n/)
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      // No unbounded whole-file read, and no allocation sized from a stat.
      expect(body, `${relative} must not call fs.readFile on a path`).not.toMatch(
        /fs\.readFile\(\s*[a-zA-Z]/
      );
      expect(body, `${relative} must not allocate from a file size`).not.toMatch(
        /Buffer\.alloc\(\s*(?:stat|length)/
      );
      // And it reaches the bounded reader or checks a byte limit first.
      expect(
        /bounded-read|MAX_[A-Z_]*BYTES/.test(body),
        `${relative} must go through the bounded reader`
      ).toBe(true);
    }
  });
});
