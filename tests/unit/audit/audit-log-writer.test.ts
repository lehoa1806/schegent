import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('AuditLogWriter.append', () => {
  it('writes JSONL entries to .schegent/audit.log', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const entry = await writer.append({
      runId: 'run-1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-end',
      payload: { ok: true },
      outcome: 'success'
    });
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();

    const contents = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    expect(contents.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(contents.trim());
    expect(parsed.runId).toBe('run-1');
  });

  it('creates a local .schegent/.gitignore without overwriting existing operator content', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    await writer.append({
      runId: 'run-1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-end',
      payload: { ok: true },
      outcome: 'success'
    });
    const ignorePath = path.join(tmpRoot, '.schegent', '.gitignore');
    const first = await fs.readFile(ignorePath, 'utf8');
    expect(first).toContain('*');

    await fs.writeFile(ignorePath, 'operator-managed\n', 'utf8');
    await writer.append({
      runId: 'run-2',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-end',
      payload: { ok: true },
      outcome: 'success'
    });

    await expect(fs.readFile(ignorePath, 'utf8')).resolves.toBe('operator-managed\n');
  });

  it('appends multiple entries in order', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 1, eventType: 'phase-start', payload: {}, outcome: 'info'
    });
    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 1, eventType: 'phase-end', payload: {}, outcome: 'success'
    });

    const lines = (await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.eventType).toBe('phase-start');
    expect(b.eventType).toBe('phase-end');
  });

  it('rotates when size threshold exceeded', async () => {
    const writer = new AuditLogWriter(
      { workspaceRoot: tmpRoot, rotationSizeBytes: 100 },
      new SanitizedLogger()
    );
    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 1, eventType: 'phase-end', payload: { padding: 'x'.repeat(150) }, outcome: 'success'
    });
    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 2, eventType: 'phase-end', payload: { padding: 'y'.repeat(50) }, outcome: 'success'
    });

    const dirEntries = await fs.readdir(path.join(tmpRoot, '.schegent'));
    const archives = dirEntries.filter((n) => n.startsWith('audit.log.'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
  });

  it('sanitizes secrets in payload before writing', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    await writer.append({
      runId: 'r',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: { args: 'Bearer abcdefghijklmnopqrst' },
      outcome: 'info'
    });
    const contents = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('abcdefghijklmnopqrst');
  });

  it('serializes concurrent appends in order', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const writes = Array.from({ length: 5 }, (_, i) =>
      writer.append({
        runId: 'r', phase: 'speckit-specify', iteration: i, eventType: 'phase-end', payload: { i }, outcome: 'success'
      })
    );
    await Promise.all(writes);
    const lines = (await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(5);
    const iterations = lines.map((l) => JSON.parse(l).iteration);
    expect(iterations).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('AuditLogWriter.subscribe', () => {
  it('fires listener once per append with the full entry', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const received: Array<{ id: string; iteration: number }> = [];
    writer.subscribe((entry) => {
      received.push({ id: entry.id, iteration: entry.iteration });
    });

    const a = await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 1, eventType: 'phase-start', payload: {}, outcome: 'info'
    });
    const b = await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 2, eventType: 'phase-end', payload: {}, outcome: 'success'
    });

    expect(received).toHaveLength(2);
    expect(received[0].id).toBe(a.id);
    expect(received[0].iteration).toBe(1);
    expect(received[1].id).toBe(b.id);
    expect(received[1].iteration).toBe(2);
  });

  it('disposing prevents subsequent fires for that listener only', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const a: number[] = [];
    const b: number[] = [];
    const subA = writer.subscribe((e) => a.push(e.iteration));
    writer.subscribe((e) => b.push(e.iteration));

    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 1, eventType: 'phase-start', payload: {}, outcome: 'info'
    });
    subA.dispose();
    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 2, eventType: 'phase-end', payload: {}, outcome: 'success'
    });

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('isolates a throwing listener from other subscribers', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const ok: number[] = [];
    writer.subscribe(() => {
      throw new Error('boom');
    });
    writer.subscribe((e) => ok.push(e.iteration));

    await writer.append({
      runId: 'r', phase: 'speckit-specify', iteration: 7, eventType: 'phase-end', payload: {}, outcome: 'success'
    });

    expect(ok).toEqual([7]);
  });

  it('notifies sanitized live subscribers even when the durable append fails', async () => {
    await fs.writeFile(path.join(tmpRoot, '.schegent'), 'not-a-directory', 'utf8');
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const received: unknown[] = [];
    writer.subscribe((entry) => received.push(entry));

    await expect(
      writer.append({
        runId: 'r',
        phase: 'speckit-specify',
        iteration: 1,
        eventType: 'cli-invocation',
        payload: { token: 'Bearer abcdefghijklmnopqrst' },
        outcome: 'info'
      })
    ).rejects.toThrow();

    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).toContain('[REDACTED]');
    expect(JSON.stringify(received[0])).not.toContain('abcdefghijklmnopqrst');
  });
});
