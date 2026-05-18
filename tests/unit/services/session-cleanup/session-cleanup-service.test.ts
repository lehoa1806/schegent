// Feature 034 T003 — unit coverage for the pure session-cleanup helper.
// See specs/034-task-deletion-cleanup/contracts/session-cleanup.md.
//
// Invariants under test:
//   - never throws — every error scenario resolves a boolean.
//   - present targets → true (both gone after).
//   - absent targets → true (force: true converts ENOENT to success).
//   - dir rm throws → false, exactly one logger.warn line.
//   - file rm throws → false, exactly one logger.warn line.
//   - both throw → false, exactly one warn line (aggregated, not two).
//   - sanitization happens via SanitizedLogger.warn (single point).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupSessionArtifacts } from '../../../../src/services/session-cleanup/session-cleanup-service';
import { SanitizedLogger } from '../../../../src/lib/logger';

function makeLogger() {
  const logger = new SanitizedLogger([]);
  const warnSpy = vi.spyOn(logger, 'warn');
  return { logger, warnSpy };
}

describe('Feature 034 T003 — cleanupSessionArtifacts', () => {
  let tmpRoot: string;
  const runId = 'run-test-X';

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cleanup-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('present targets — removes both, resolves true, no warn', async () => {
    const sessionDir = path.join(tmpRoot, '.schegent', 'sessions', runId);
    const nested = path.join(sessionDir, 'diagnostics', 'p', 'q', 'iter-1');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'stream.jsonl'), '{}\n', 'utf8');
    const rawFile = path.join(tmpRoot, '.schegent', 'sessions', `raw-${runId}.log`);
    await fs.writeFile(rawFile, 'hello\n', 'utf8');

    const { logger, warnSpy } = makeLogger();
    const result = await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger
    });

    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    await expect(fs.access(sessionDir)).rejects.toBeDefined();
    await expect(fs.access(rawFile)).rejects.toBeDefined();
  });

  it('absent targets — resolves true, no warn (force: true converts ENOENT)', async () => {
    const { logger, warnSpy } = makeLogger();
    const result = await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger
    });
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('dir rm throws — resolves false, exactly one warn, raw rm still attempted', async () => {
    const { logger, warnSpy } = makeLogger();
    const calls: string[] = [];
    const fsRm = vi
      .fn<(p: string, opts: { recursive: true; force: true }) => Promise<void>>()
      .mockImplementation(async (p) => {
        calls.push(p);
        if (p.endsWith(runId)) throw new Error('boom-dir');
        // raw transcript path succeeds
      });

    const result = await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger,
      fsRm
    });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(fsRm).toHaveBeenCalledTimes(2);
    // Proves no short-circuit on first failure
    expect(calls.some((c) => c.endsWith(runId))).toBe(true);
    expect(calls.some((c) => c.endsWith(`raw-${runId}.log`))).toBe(true);
  });

  it('file rm throws — resolves false, exactly one warn', async () => {
    const { logger, warnSpy } = makeLogger();
    const fsRm = vi
      .fn<(p: string, opts: { recursive: true; force: true }) => Promise<void>>()
      .mockImplementation(async (p) => {
        if (p.endsWith(`raw-${runId}.log`)) throw new Error('boom-file');
        // session-root path succeeds
      });
    const result = await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger,
      fsRm
    });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('both throw — resolves false, exactly one aggregated warn (not two)', async () => {
    const { logger, warnSpy } = makeLogger();
    const fsRm = vi
      .fn<(p: string, opts: { recursive: true; force: true }) => Promise<void>>()
      .mockImplementation(async () => {
        throw new Error('boom-both');
      });
    const result = await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger,
      fsRm
    });
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws — every error scenario returns a boolean', async () => {
    const { logger } = makeLogger();
    // A throwy fsRm that also rejects with a non-Error value.
    const fsRm = vi
      .fn<(p: string, opts: { recursive: true; force: true }) => Promise<void>>()
      .mockImplementation(async () => {
        throw 'not-an-error-object';
      });
    let threw = false;
    let result: boolean | undefined;
    try {
      result = await cleanupSessionArtifacts({
        workspaceRoot: tmpRoot,
        runId,
        logger,
        fsRm
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });

  it('sanitization — the warn body passes through SanitizedLogger.warn once', async () => {
    // The cleanup helper MUST call logger.warn exactly once on failure,
    // and MUST NOT pre-sanitize the message itself. The logger's
    // internal write pipeline applies SECRET_PATTERNS to the message
    // (single sanitization point at SanitizedLogger.write). The helper
    // owns the warn count; the logger owns redaction.
    const logger = new SanitizedLogger([]);
    const warnSpy = vi.spyOn(logger, 'warn');
    const fsRm = vi
      .fn<(p: string, opts: { recursive: true; force: true }) => Promise<void>>()
      .mockImplementation(async () => {
        throw new Error('io-failure');
      });

    await cleanupSessionArtifacts({
      workspaceRoot: tmpRoot,
      runId,
      logger,
      fsRm
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The warn argument MUST be a single message string — no
    // structured context that bypasses redaction.
    const args = warnSpy.mock.calls[0];
    expect(typeof args[0]).toBe('string');
    // The helper does NOT wrap with its own logger.sanitize call. We
    // confirm this by checking the warn message contains the unredacted
    // error text (`io-failure`) — the logger redaction set is the
    // single source of truth and `io-failure` is not a secret.
    expect(args[0]).toContain('io-failure');
  });
});
