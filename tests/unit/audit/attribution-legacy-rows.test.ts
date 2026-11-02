// Feature 251 (FR-R4-F04, contract T19, SC-009, FR-029, US5-5; P2, P5) — a history written before the
// pseudonym still reads, renders and verifies, and nothing new carries the OS username.
//
// What it pins: a history whose rows name the OS user as their actor, and a stored phase override that
// does, reads through the parser and verifies with the real chain verifier, with every byte as it was;
// rows written now through `operatorAuditActor()` carry the pseudonym and not `synthetic-os-user-7f3a`; the
// phase-control overrides read the one helper (here, by what the file reads; the writers' stamped actor is
// pinned in `tests/unit/controller/phase-control-service.test.ts`); and an audit export and a Run export of
// the fixture contain no occurrence of the synthetic username that today's code wrote.
//
// Why: FR-029 says older records are never rewritten (rewriting would break the hash chain) and that the
// documentation says they may still hold a username. This is the test that no byte moved, and that the one
// helper every attribution site reads is the one that changed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { createCountsOnlyAuditExport } from '../../../src/commands/export-audit';
import { exportRunEvidence } from '../../../src/services/evidence-export';
import {
  createOperatorAttribution,
  getOperatorActor,
  installOperatorAttribution,
  type OperatorAttributionStore
} from '../../../src/lib/operator-attribution';
import { createStateTransitionAuditEnvelope, operatorAuditActor } from '../../../src/lib/audit-event-envelope';
import { SanitizedLogger } from '../../../src/lib/logger';
import { removeTempRoot } from '../../temp-root-cleanup';

const SYNTHETIC_OS_USER = 'synthetic-os-user-7f3a';
const EXPORTED_RUN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, userInfo: () => ({ username: 'synthetic-os-user-7f3a' }) };
  return { ...mocked, default: mocked };
});

let root: string;
let auditDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-attribution-legacy-'));
  auditDir = path.join(root, '.schegent');
});

afterEach(async () => {
  installOperatorAttribution(null);
  await removeTempRoot(root);
});

async function installPseudonym(): Promise<string> {
  const store: OperatorAttributionStore & { value: unknown } = {
    value: undefined,
    readOperatorPseudonym: () => store.value,
    writeOperatorPseudonym: async (next) => {
      store.value = next;
    }
  };
  const attribution = createOperatorAttribution(store, randomBytes);
  installOperatorAttribution(attribution);
  return attribution.ensureStored();
}

const append = (writer: AuditLogWriter, n: number, actorId: string) =>
  writer.append({
    runId: `run-${n}`,
    phase: 'operator',
    iteration: 0,
    eventType: 'queue-paused',
    outcome: 'info',
    payload: { n, actor: { kind: 'operator', id: actorId } }
  } as never);

describe('a history that names the OS user still verifies, byte for byte (FR-029)', () => {
  it('reads and verifies rows whose actor is a username, and keeps every byte when new rows follow', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([]));
    await append(writer, 1, SYNTHETIC_OS_USER);
    await append(writer, 2, SYNTHETIC_OS_USER);
    const before = await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8');

    await installPseudonym();
    await append(writer, 3, operatorAuditActor().id);

    const after = await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8');
    expect(after.startsWith(before), 'no existing byte was rewritten').toBe(true);
    const checked = verifyAuditChainAt(auditDir);
    expect(checked!.verdict.ok, JSON.stringify(checked!.verdict)).toBe(true);
    expect(checked!.verdict.ok && checked!.verdict.entries).toBe(3);
  });
});

describe('new attribution carries the pseudonym (P2)', () => {
  it('stamps the envelope default and the explicit helper with the pseudonym, never the username', async () => {
    const pseudonym = await installPseudonym();

    expect(operatorAuditActor()).toEqual({ kind: 'operator', id: pseudonym });
    expect(createStateTransitionAuditEnvelope({ reasonCode: 'operator-pause' }).actor).toEqual({ kind: 'operator', id: pseudonym });
    expect(JSON.stringify([operatorAuditActor(), createStateTransitionAuditEnvelope({ reasonCode: 'x' })])).not.toContain(SYNTHETIC_OS_USER);
  });

  it('is what the two phase-control overrides read', async () => {
    const pseudonym = await installPseudonym();
    const source = await fs.readFile(path.join(__dirname, '../../../src/controller/phase-control-service.ts'), 'utf8');
    // Both override sites call the one helper the envelope uses; the control proves the helper answers
    // the pseudonym, and that no site in the file reads the OS account on its own.
    expect(source.match(/getOperatorActor\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/os\.userInfo|userInfo\(/);
    expect(getOperatorActor()).toBe(pseudonym);
  });
});

describe('exports of a mixed history name no username that today\'s code wrote (SC-009)', () => {
  it('the audit export of rows written after the pseudonym contains no synthetic username', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([]));
    await installPseudonym();
    await append(writer, 1, operatorAuditActor().id);
    await append(writer, 2, operatorAuditActor().id);

    const exported = createCountsOnlyAuditExport(await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8'));

    expect(exported.length, 'the control: the export has rows').toBeGreaterThan(0);
    expect(exported).not.toContain(SYNTHETIC_OS_USER);
    expect(await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8')).not.toContain(SYNTHETIC_OS_USER);
  });

  it('the Run export of rows written after the pseudonym contains no synthetic username, and carries the rows (G9)', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([]));
    const pseudonym = await installPseudonym();
    await append(writer, 1, operatorAuditActor().id);
    await append(writer, 2, operatorAuditActor().id);
    // The audit log is shared and is carried only when the Run has evidence of its own.
    await fs.mkdir(path.join(auditDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(auditDir, 'sessions', `raw-${EXPORTED_RUN}.log`), 'a transcript line\n');
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-attribution-export-'));
    try {
      const result = await exportRunEvidence(root, EXPORTED_RUN, destination);

      expect(result.outcome, 'the control: the export was made').toBe('exported');
      const names = await fs.readdir(destination);
      const texts = await Promise.all(names.map((name) => fs.readFile(path.join(destination, name), 'utf8')));
      const everything = [...names, ...texts].join('\n');
      expect(everything, 'the control: the exported audit history holds the rows').toContain(pseudonym);
      expect(everything).not.toContain(SYNTHETIC_OS_USER);
    } finally {
      await removeTempRoot(destination);
    }
  });
});
