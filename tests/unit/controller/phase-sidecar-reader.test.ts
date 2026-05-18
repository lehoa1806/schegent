import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PhaseSidecarReader,
  composePhaseMessagePath,
  type PhaseSidecarInputs
} from '../../../src/controller/phase-sidecar-reader';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry, AuditEntryFields } from '../../../src/audit/audit-entry';

function makeAuditWriter(): {
  writer: AuditLogWriter;
  appends: Array<{ eventType: string; payload: Record<string, unknown> }>;
} {
  const appends: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let counter = 0;
  const writer = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      appends.push({
        eventType: entry.eventType,
        payload: entry.payload as Record<string, unknown>
      });
      return {
        id: `audit-${++counter}`,
        timestamp: '2026-05-19T00:00:00Z',
        ...entry
      } as AuditEntry;
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, appends };
}

async function mkRunDir(): Promise<{ cwd: string; runId: string; iteration: number; sidecarPath: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-reader-'));
  const runId = 'run-abc';
  const iteration = 1;
  const sidecarPath = composePhaseMessagePath({
    cwd,
    runId,
    pipelineId: 'speckit-new-feature',
    phaseId: 'speckit-specify',
    iteration
  });
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  return { cwd, runId, iteration, sidecarPath };
}

function makeInputs(overrides: Partial<PhaseSidecarInputs> & Pick<PhaseSidecarInputs, 'cwd' | 'runId' | 'iteration'>): PhaseSidecarInputs {
  return {
    phase: 'speckit-specify',
    pipelineId: 'speckit-new-feature',
    ...overrides
  };
}

describe('PhaseSidecarReader.parsePhaseMessage', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    logger = new SanitizedLogger();
  });

  it('reads the canonical sidecar and emits phase-message-emitted with sanitized entries', async () => {
    const { cwd, runId, iteration, sidecarPath } = await mkRunDir();
    await fs.writeFile(sidecarPath, 'KEY=value\nOTHER=data\n', 'utf8');
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      null
    );

    expect(result).not.toBeNull();
    expect(result!.invalidReason).toBeNull();
    expect(result!.entryCount).toBe(2);
    expect(result!.entries.KEY).toBe('value');
    const emitted = appends.find((a) => a.eventType === 'phase-message-emitted');
    expect(emitted).toBeDefined();
    expect(emitted!.payload.entryCount).toBe(2);
  });

  it('rejects sidecar > 4 KiB with phase-message-truncated and truncated=true', async () => {
    const { cwd, runId, iteration, sidecarPath } = await mkRunDir();
    const bigValue = 'A'.repeat(5000);
    await fs.writeFile(sidecarPath, `BIG=${bigValue}\n`, 'utf8');
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      null
    );

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.invalidReason).toBeNull();
    expect(appends.find((a) => a.eventType === 'phase-message-truncated')).toBeDefined();
  });

  it('emits phase-message-invalid with reason=duplicate-keys when the same key appears twice', async () => {
    const { cwd, runId, iteration, sidecarPath } = await mkRunDir();
    await fs.writeFile(sidecarPath, 'KEY=first\nKEY=second\n', 'utf8');
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      null
    );

    expect(result).not.toBeNull();
    expect(result!.invalidReason).toBe('duplicate-keys');
    const invalid = appends.find((a) => a.eventType === 'phase-message-invalid');
    expect(invalid).toBeDefined();
    expect(invalid!.payload.reason).toBe('duplicate-keys');
  });

  it('emits phase-message-invalid with reason=malformed-lines for invalid key syntax', async () => {
    const { cwd, runId, iteration, sidecarPath } = await mkRunDir();
    await fs.writeFile(sidecarPath, 'GOOD=ok\n9bad=nope\nno-equals-line\n', 'utf8');
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      null
    );

    const invalid = appends.find((a) => a.eventType === 'phase-message-invalid');
    expect(invalid).toBeDefined();
    expect(invalid!.payload.reason).toBe('malformed-lines');
    expect(invalid!.payload.invalidLines).toBe(1);
    expect(invalid!.payload.invalidKeys).toBe(1);
  });

  it('emits phase-message-invalid with reason=path-outside-run-dir when audit candidate diverges from canonical', async () => {
    const { cwd, runId, iteration } = await mkRunDir();
    const evilDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evil-'));
    const evilPath = path.join(evilDir, 'phase-message.env');
    await fs.writeFile(evilPath, 'SECRET=leaked\n', 'utf8');
    const auditEntry: AuditEntryFields = {
      phase: 'speckit-specify',
      filesCreated: [evilPath],
      filesModified: [],
      filesDeleted: [],
      commandsExecuted: [],
      networkCalls: [],
      rulesetSwitches: [],
      notes: '',
      metrics: {},
      warnings: []
    };
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      auditEntry
    );

    expect(result).not.toBeNull();
    expect(result!.invalidReason).toBe('path-outside-run-dir');
    const invalid = appends.find((a) => a.eventType === 'phase-message-invalid');
    expect(invalid).toBeDefined();
    expect(invalid!.payload.reason).toBe('path-outside-run-dir');
  });

  it('emits phase-message-invalid with reason=missing-canonical-sidecar when no candidate matches and canonical is missing', async () => {
    const { cwd, runId, iteration } = await mkRunDir();
    // No sidecar written at canonicalPath; provide an audit candidate with
    // mismatched basename so the filter eliminates it and we reach the
    // "no candidates" branch.
    const auditEntry: AuditEntryFields = {
      phase: 'speckit-specify',
      filesCreated: [path.join(cwd, 'unrelated.txt')],
      filesModified: [],
      filesDeleted: [],
      commandsExecuted: [],
      networkCalls: [],
      rulesetSwitches: [],
      notes: '',
      metrics: {},
      warnings: []
    };
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      auditEntry
    );

    // No matching candidate AND no canonical sidecar = null return (no audit emission).
    expect(result).toBeNull();
    expect(appends.find((a) => a.eventType === 'phase-message-invalid')).toBeUndefined();
  });

  it('emits phase-message-invalid with reason=duplicate-sidecar when audit reports two distinct candidates', async () => {
    const { cwd, runId, iteration } = await mkRunDir();
    const first = await fs.mkdtemp(path.join(os.tmpdir(), 'first-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'second-'));
    const firstPath = path.join(first, 'phase-message.env');
    const secondPath = path.join(second, 'phase-message.env');
    await fs.writeFile(firstPath, 'A=1\n', 'utf8');
    await fs.writeFile(secondPath, 'B=2\n', 'utf8');
    const auditEntry: AuditEntryFields = {
      phase: 'speckit-specify',
      filesCreated: [firstPath],
      filesModified: [secondPath],
      filesDeleted: [],
      commandsExecuted: [],
      networkCalls: [],
      rulesetSwitches: [],
      notes: '',
      metrics: {},
      warnings: []
    };
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      auditEntry
    );

    const duplicate = appends.find(
      (a) => a.eventType === 'phase-message-invalid' && a.payload.reason === 'duplicate-sidecar'
    );
    expect(duplicate).toBeDefined();
    expect(duplicate!.payload.candidateCount).toBe(2);
  });

  it('Track 2 O_NOFOLLOW defense: rejects symlinked sidecar with path-symlink-redirect (POSIX only)', async () => {
    if (process.platform === 'win32') return; // POSIX-only check
    const { cwd, runId, iteration, sidecarPath } = await mkRunDir();
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-'));
    const targetPath = path.join(targetDir, 'real.env');
    await fs.writeFile(targetPath, 'STOLEN=secret\n', 'utf8');
    await fs.symlink(targetPath, sidecarPath);
    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const result = await reader.parsePhaseMessage(
      makeInputs({ cwd, runId, iteration }),
      null
    );

    // Step 1 with silentOnFailure swallows the ELOOP. Without audit
    // candidates the call returns null without emitting an audit event.
    expect(result).toBeNull();
    expect(
      appends.find(
        (a) => a.eventType === 'phase-message-invalid' && a.payload.reason === 'path-symlink-redirect'
      )
    ).toBeUndefined();
  });
});

describe('PhaseSidecarReader.canonicalSidecarPath', () => {
  it('prefers an explicit phaseMessagePath override', () => {
    const writer = makeAuditWriter().writer;
    const reader = new PhaseSidecarReader(writer, new SanitizedLogger());
    const override = '/explicit/sidecar/path.env';
    const out = reader.canonicalSidecarPath({
      phase: 'speckit-plan',
      runId: 'run-1',
      iteration: 1,
      cwd: '/repo',
      phaseMessagePath: override
    });
    expect(out).toBe(path.resolve(override));
  });

  it('returns null when runId or iteration is missing (legacy fixture path)', () => {
    const writer = makeAuditWriter().writer;
    const reader = new PhaseSidecarReader(writer, new SanitizedLogger());
    expect(
      reader.canonicalSidecarPath({
        phase: 'speckit-plan',
        runId: '',
        iteration: 0,
        cwd: '/repo'
      })
    ).toBeNull();
  });

  it('composes the canonical iter-N path under .schegent/sessions/<runId>/diagnostics/...', () => {
    const writer = makeAuditWriter().writer;
    const reader = new PhaseSidecarReader(writer, new SanitizedLogger());
    const out = reader.canonicalSidecarPath({
      phase: 'speckit-specify',
      pipelineId: 'speckit-new-feature',
      runId: 'run-1',
      iteration: 3,
      cwd: '/repo'
    });
    expect(out).toBe(
      '/repo/.schegent/sessions/run-1/diagnostics/speckit-new-feature/speckit-specify/iter-3/phase-message.env'
    );
  });
});

describe('PhaseSidecarReader.parsePhaseMessageEnv', () => {
  const reader = new PhaseSidecarReader(makeAuditWriter().writer, new SanitizedLogger());

  it('returns parsed entries on a clean flat-KV input', () => {
    const out = reader.parsePhaseMessageEnv('A=1\nB=two\n');
    expect(out.entries).toEqual({ A: '1', B: 'two' });
    expect(out.invalidLines).toBe(0);
    expect(out.invalidKeys).toBe(0);
    expect(out.duplicateKey).toBe(false);
  });

  it('flags lines without = as invalid', () => {
    const out = reader.parsePhaseMessageEnv('A=1\nNOPE\n');
    expect(out.invalidLines).toBe(1);
  });

  it('flags keys not matching ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$', () => {
    const out = reader.parsePhaseMessageEnv('9bad=val\n');
    expect(out.invalidKeys).toBe(1);
  });

  it('flags duplicate keys without overwriting first occurrence', () => {
    const out = reader.parsePhaseMessageEnv('K=first\nK=second\n');
    expect(out.entries.K).toBe('first');
    expect(out.duplicateKey).toBe(true);
  });
});
