// Feature FR-R3-005 (T335) — "Refusal is never silent and never partial".
//
// Every guard added by this feature can refuse, and a refusal is only useful
// if the operator can see it. That pulls in the opposite direction from the
// standing rule that the structured audit log never carries a workspace path:
// the most natural way to make a refusal legible is to say which path was
// refused, and that path is exactly what must not be written.
//
// So the contract is two-sided and this test asserts both sides at once, over
// real files and real symlinks:
//
//   - present  — the refusal reaches the audit log and the runtime log with a
//     reason drawn from the closed `ContainmentRefusal` set.
//   - bounded  — neither carries the workspace root, the escape target, or any
//     other absolute path.
//
// It is an integration test rather than a unit one because the two halves are
// owned by different modules: the service decides the reason code, and the
// audit writer serializes it. A unit test of either would assert the shape it
// itself produced.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { cleanupSessionArtifacts } from '../../../src/services/session-cleanup/session-cleanup-service';
import { SessionArtifactRetentionService } from '../../../src/services/session-retention/session-artifact-retention-service';

/** The closed set. A reason outside it is a leak vector by construction. */
const BOUNDED_REASONS = ['not-contained', 'resolve-failed'] as const;

/**
 * Anything that looks like an absolute filesystem path.
 *
 * Deliberately broader than "the roots this test created": a payload that
 * named some *other* absolute path would be just as much of a disclosure, and
 * a test that only forbids the two paths it knows about would pass on it.
 */
const ABSOLUTE_PATH = /(?:^|[\s":[(,])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/;

function warnCapture(): { logger: SanitizedLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = new SanitizedLogger();
  vi.spyOn(logger, 'warn').mockImplementation(((message: string, context?: unknown) => {
    lines.push(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
  }) as SanitizedLogger['warn']);
  return { logger, lines };
}

describe('FR-R3-005 — a containment refusal is recorded, bounded, and path-free', () => {
  let workspaceRoot: string;
  let outside: string;

  beforeEach(async () => {
    workspaceRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-refusal-ws-'))
    );
    outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-refusal-out-'))
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('writes the retention refusal to the audit log as a bounded code with no path', async () => {
    // A legitimately contained sessions root with one run directory symlinked
    // out of the workspace — the "symlinked candidate inside a contained root"
    // shape, driven over a real link rather than a stubbed `realpath`.
    const sessionsRoot = path.join(workspaceRoot, '.schegent', 'sessions');
    await fs.mkdir(sessionsRoot, { recursive: true });
    const contained = path.join(sessionsRoot, 'run-contained');
    await fs.mkdir(contained, { recursive: true });
    await fs.writeFile(path.join(contained, 'transcript.txt'), 'x'.repeat(4096));
    const escapeTarget = path.join(outside, 'run-escaped');
    await fs.mkdir(escapeTarget, { recursive: true });
    await fs.writeFile(path.join(escapeTarget, 'transcript.txt'), 'y'.repeat(4096));
    await fs.symlink(escapeTarget, path.join(sessionsRoot, 'run-escaped'));

    const { logger, lines } = warnCapture();
    const audit = new AuditLogWriter({ workspaceRoot }, logger);
    const service = new SessionArtifactRetentionService({
      workspaceRoot,
      // Everything is over budget, so every candidate is a prune candidate and
      // the refusal is the only reason one survives.
      policy: () => ({ maxAgeMs: 0, maxBytes: 0 }),
      logger,
      audit
    });

    await service.sweep();

    const raw = await fs.readFile(audit.logPath, 'utf8');
    const events = raw
      .split('\n')
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => JSON.parse(entry) as { eventType: string; payload: Record<string, unknown> });
    const applied = events.find((event) => event.eventType === 'session-retention-applied');
    expect(applied, 'the sweep must record its outcome').toBeDefined();

    // Present: the refusal is in the payload, as a member of the closed set.
    const refusals = applied!.payload.containmentRefusals as readonly string[];
    expect(refusals).toEqual(['not-contained']);
    for (const reason of refusals) {
      expect(BOUNDED_REASONS as readonly string[]).toContain(reason);
    }

    // Bounded: not the workspace root, not the escape target, not any path.
    expect(raw).not.toContain(workspaceRoot);
    expect(raw).not.toContain(outside);
    expect(raw).not.toContain('run-escaped');
    expect(ABSOLUTE_PATH.exec(raw)?.[1] ?? null).toBeNull();

    // The contained sibling was still pruned — a refusal is per candidate.
    await expect(fs.stat(contained)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(escapeTarget)).resolves.toBeDefined();

    // And the runtime log says which operation was refused and why, still
    // without the path. That is the division of labour: the audit log carries
    // the code, the sanitized runtime log carries the operator-facing detail,
    // and neither carries the location.
    //
    // The count is not pinned, and deliberately so. A refused candidate never
    // completes, so it is never marked removed, and the byte-budget pass
    // reconsiders it after the age pass has already refused it — one candidate,
    // two attempts, two warns. That is the sweep's ordinary retry structure and
    // has nothing to do with containment; pinning a number here would make this
    // test fail the next time a policy threshold changes how many passes run.
    // What must hold is that *every* line is bounded and path-free, so the
    // assertion is over all of them.
    const refusalLines = lines.filter((entry) => entry.includes('refused'));
    expect(refusalLines.length, 'the refusal must reach the runtime log').toBeGreaterThan(0);
    for (const entry of refusalLines) {
      expect(entry).toContain('not-contained');
      expect(entry).not.toContain(workspaceRoot);
      expect(entry).not.toContain(outside);
      expect(entry).not.toContain('run-escaped');
      expect(ABSOLUTE_PATH.exec(entry)?.[1] ?? null).toBeNull();
    }
  });

  it('reports a refused task-deletion cleanup as a bounded code with no path', async () => {
    // `.schegent` itself is the symlink here, so both cleanup targets resolve
    // out of the workspace and the operator-triggered delete refuses.
    const escape = path.join(outside, 'schegent-escape');
    await fs.mkdir(path.join(escape, 'sessions', 'run-42'), { recursive: true });
    await fs.symlink(escape, path.join(workspaceRoot, '.schegent'));

    const { logger, lines } = warnCapture();
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId: 'run-42',
      logger
    });

    expect(outcome.cleaned).toBe(false);
    expect(outcome.refusal).toBe('not-contained');
    expect(BOUNDED_REASONS as readonly string[]).toContain(outcome.refusal!);
    // Nothing was removed, and the evidence outside the workspace is untouched.
    await expect(fs.stat(path.join(escape, 'sessions', 'run-42'))).resolves.toBeDefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not-contained');
    expect(lines[0]).not.toContain(workspaceRoot);
    expect(lines[0]).not.toContain(outside);
    expect(ABSOLUTE_PATH.exec(lines[0]!)?.[1] ?? null).toBeNull();
  });

  it('keeps the audit log free of refusal noise when nothing is refused', async () => {
    // The complement. A payload that always carried a `containmentRefusals`
    // key with something in it would make the assertions above pass for the
    // wrong reason, so the clean sweep is pinned too.
    const sessionsRoot = path.join(workspaceRoot, '.schegent', 'sessions');
    await fs.mkdir(path.join(sessionsRoot, 'run-one'), { recursive: true });
    await fs.writeFile(path.join(sessionsRoot, 'run-one', 'transcript.txt'), 'z'.repeat(4096));

    const { logger, lines } = warnCapture();
    const audit = new AuditLogWriter({ workspaceRoot }, logger);
    const service = new SessionArtifactRetentionService({
      workspaceRoot,
      policy: () => ({ maxAgeMs: 0, maxBytes: 0 }),
      logger,
      audit
    });

    await service.sweep();

    const raw = await fs.readFile(audit.logPath, 'utf8');
    const applied = raw
      .split('\n')
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => JSON.parse(entry) as { eventType: string; payload: Record<string, unknown> })
      .find((event) => event.eventType === 'session-retention-applied');
    expect(applied!.payload.containmentRefusals).toEqual([]);
    expect(lines.filter((entry) => entry.includes('refused'))).toEqual([]);
    expect(ABSOLUTE_PATH.exec(raw)?.[1] ?? null).toBeNull();
    await expect(fs.stat(path.join(sessionsRoot, 'run-one'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});
