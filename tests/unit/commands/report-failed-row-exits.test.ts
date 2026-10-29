/**
 * FR-R4-F16 (feature 244) — contract M3.1 to M3.3: the read-only command that opens the failed-row
 * report.
 *
 * `specs/244-failed-row-exit-evidence/contracts/report-command.md`. Everything runs on a real
 * temporary directory used as the workspace root, with a chain seeded on disk and a
 * `WorkspaceStateStore` over an in-memory `Memento`. The command must write nothing, so each case that
 * reads a real chain compares the whole root's tree (every path, its bytes and mode, `.schegent/`
 * included, since SC-005 names the workspace's files) and every `Memento` key and value before and
 * after. The order the chain and the queue state are read in is observed through the chain lister,
 * which the reader takes from `src/audit/audit-chain`.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import { Notifier } from '../../../src/ui/notifications';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import {
  REPORT_FAILED_ROW_EXITS_COMMAND,
  runReportFailedRowExits,
  type ReportFailedRowExitsDeps
} from '../../../src/commands/report-failed-row-exits';
import { R1, T1 } from '../../fixtures/failed-row-census/histories';

// The chain lister is the reader's only seam, and the command gives the reader no other. Wrapping it
// records when the chain is first read, relative to the queue state.
const order = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../src/audit/audit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/audit/audit-chain')>();
  return {
    ...actual,
    collectChainFiles: (auditDir: string) => {
      order.calls.push('chain');
      return actual.collectChainFiles(auditDir);
    }
  };
});

class SnapshotMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
  /** Every key and value, serialized, so a write of any kind shows. */
  public dump(): string {
    return JSON.stringify([...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

const HEADINGS = ['## Identity', '## Coverage', '## Totals', '## Unknowns', '## Episodes', '## Limits'];
const FIXED_ERROR = 'Schegent: could not open the failed-row report.';
const SECRET_MESSAGE = 'SENTINEL-OPEN-FAILURE-7C21';

let root: string;
let memento: SnapshotMemento;
let store: WorkspaceStateStore;
let warnings: string[];
let showError: ReturnType<typeof vi.fn>;
let calls: string[];
let clockMs: number;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'report-failed-row-exits-'));
  memento = new SnapshotMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  warnings = [];
  showError = vi.fn();
  calls = [];
  order.calls = [];
  clockMs = Date.parse('2026-10-29T12:00:00.000Z');
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** One audit line in the shape the writer produces. */
function auditLine(eventType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    id: `entry-${eventType}`,
    timestamp: '2026-10-20T10:00:00.000Z',
    runId: 'run-envelope',
    phase: 'queue-manager',
    iteration: 0,
    eventType,
    outcome: 'info',
    payload
  });
}

async function seedChain(): Promise<void> {
  const dir = path.join(root, '.schegent');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'audit.log'),
    [
      auditLine('task-execution-started', { taskId: T1, runId: R1, queueId: 'default', isResume: false }),
      auditLine('task-execution-ended', { taskId: T1, runId: R1, terminalStatus: 'failed', failureCause: 'phase_failed' }),
      auditLine('task-removed', {
        taskId: T1,
        queueId: 'default',
        priorStatus: 'completed',
        runId: R1,
        completionProvenance: 'operator-attested'
      })
    ].join('\n') + '\n',
    'utf8'
  );
  await fsp.writeFile(path.join(dir, 'audit.log.20261018-100000'), `${auditLine('queue-cleared', { queueId: 'x' })}\n`, 'utf8');
}

/** Every path under the root with its bytes and mode, so a write, a mode change or a new file shows. */
async function treeOf(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    const stat = await fsp.lstat(full);
    if (entry.isDirectory()) {
      out[rel] = `dir ${stat.mode}`;
      Object.assign(out, await treeOf(full, base));
    } else {
      const bytes = entry.isSymbolicLink() ? await fsp.readlink(full) : (await fsp.readFile(full)).toString('base64');
      out[rel] = `file ${stat.mode} ${bytes}`;
    }
  }
  return out;
}

function makeDeps(overrides: Partial<ReportFailedRowExitsDeps> = {}): {
  deps: ReportFailedRowExitsDeps;
  opened: string[];
} {
  const opened: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line) => warnings.push(line) }]);
  const notifier = new Notifier({
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: showError as unknown as (message: string) => Thenable<string | undefined>
  });
  const deps: ReportFailedRowExitsDeps = {
    workspaceRoot: root,
    now: () => {
      calls.push('now');
      return clockMs;
    },
    readQueueStates: () => {
      calls.push('readQueueStates');
      order.calls.push('snapshot');
      return store.getQueueStates();
    },
    readPolicyDefault: () => {
      calls.push('readPolicyDefault');
      return 'halt-on-failure';
    },
    extensionVersion: () => {
      calls.push('extensionVersion');
      return '0.2.0';
    },
    openReport: async (markdown) => {
      calls.push('openReport');
      opened.push(markdown);
    },
    logger,
    notifier,
    ...overrides
  };
  return { deps, opened };
}

describe('the report command: what it opens and what it leaves alone (contract M3.1)', () => {
  it('opens the report once, with the six headings, and changes nothing in the root or the Memento', async () => {
    await seedChain();
    const treeBefore = await treeOf(root);
    const mementoBefore = memento.dump();
    const { deps, opened } = makeDeps();

    await runReportFailedRowExits(deps);

    expect(opened).toHaveLength(1);
    const lines = (opened[0] as string).split('\n');
    expect(lines.filter((line) => line.startsWith('## '))).toEqual(HEADINGS);
    expect(opened[0]).toContain('attested-removed');
    expect(await treeOf(root)).toEqual(treeBefore);
    expect(memento.dump()).toBe(mementoBefore);
    expect(Object.keys(treeBefore).length).toBeGreaterThan(2);
    expect(mementoBefore).toContain(KEYS.queue);
  });

  it('calls no port after openReport, and calls openReport exactly once', async () => {
    await seedChain();
    const { deps } = makeDeps();

    await runReportFailedRowExits(deps);

    expect(calls.filter((call) => call === 'openReport')).toHaveLength(1);
    expect(calls[calls.length - 1]).toBe('openReport');
  });

  it('reads the queue state before the chain', async () => {
    await seedChain();
    const { deps } = makeDeps();

    await runReportFailedRowExits(deps);

    expect(order.calls[0]).toBe('snapshot');
    expect(order.calls).toContain('chain');
    expect(order.calls.indexOf('snapshot')).toBeLessThan(order.calls.indexOf('chain'));
  });

  it('opens the empty report, not an error, when there is no .schegent directory', async () => {
    const treeBefore = await treeOf(root);
    const { deps, opened } = makeDeps();

    await runReportFailedRowExits(deps);

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('No audit log was found; there are no episodes.');
    expect(showError).not.toHaveBeenCalled();
    expect(await treeOf(root)).toEqual(treeBefore);
  });

  it('lets two windows run it at once, each opening its own report, with nothing written', async () => {
    await seedChain();
    const treeBefore = await treeOf(root);
    const first = makeDeps();
    const second = makeDeps();

    await Promise.all([runReportFailedRowExits(first.deps), runReportFailedRowExits(second.deps)]);

    expect(first.opened).toHaveLength(1);
    expect(second.opened).toHaveLength(1);
    expect(second.opened[0]).toBe(first.opened[0]);
    expect(await treeOf(root)).toEqual(treeBefore);
  });
});

describe('the report command: the cutoff and the snapshot (contract M3.2)', () => {
  it('calls now() once and writes that value as the cutoff', async () => {
    await seedChain();
    const { deps, opened } = makeDeps();

    await runReportFailedRowExits(deps);

    expect(calls.filter((call) => call === 'now')).toHaveLength(1);
    expect(opened[0]).toContain(`Cutoff: ${new Date(clockMs).toISOString()}`);
  });

  it('takes the cutoff and reads the queue state and the policy default in one synchronous turn', async () => {
    await seedChain();
    let turnPassed = false;
    const seenByPorts: boolean[] = [];
    const { deps } = makeDeps({
      now: () => {
        queueMicrotask(() => {
          turnPassed = true;
        });
        return clockMs;
      },
      readQueueStates: () => {
        seenByPorts.push(turnPassed);
        return store.getQueueStates();
      },
      readPolicyDefault: () => {
        seenByPorts.push(turnPassed);
        return 'halt-on-failure';
      }
    });

    await runReportFailedRowExits(deps);

    expect(seenByPorts).toEqual([false, false]);
    // Control: the probe does fire once the command yields, so `false` above means no `await` came between.
    expect(turnPassed).toBe(true);
  });
});

describe('the report command: a report that cannot be opened (contract M3.3)', () => {
  it('shows the fixed error once, warns without the error message, and resolves', async () => {
    await seedChain();
    const failure = Object.assign(new Error(`${SECRET_MESSAGE} at ${root}`), { code: 'EBUSY' });
    const { deps } = makeDeps({
      openReport: async () => {
        calls.push('openReport');
        throw failure;
      }
    });

    await expect(runReportFailedRowExits(deps)).resolves.toBeUndefined();

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(FIXED_ERROR);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EBUSY');
    for (const line of warnings) {
      expect(line).not.toContain(SECRET_MESSAGE);
      expect(line).not.toContain(root);
    }
  });

  it('names the error type when it has no code', async () => {
    const { deps } = makeDeps({
      openReport: async () => {
        throw new TypeError(SECRET_MESSAGE);
      }
    });

    await runReportFailedRowExits(deps);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TypeError');
    expect(warnings[0]).not.toContain(SECRET_MESSAGE);
  });

  it('shows nothing and warns nothing when the report opens', async () => {
    const { deps } = makeDeps();
    await runReportFailedRowExits(deps);
    expect(showError).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe('the report command: its identity and its imports (contract M1.3, M2.1)', () => {
  it('is registered under one command id', () => {
    expect(REPORT_FAILED_ROW_EXITS_COMMAND).toBe('schegent.reportFailedRowExits');
  });

  it('imports no vscode, takes no lock and writes no file', async () => {
    const source = await fsp.readFile(
      path.join(__dirname, '..', '..', '..', 'src', 'commands', 'report-failed-row-exits.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/from ['"]vscode['"]/);
    expect(source).not.toMatch(/\b(writeFile|appendFile|unlink|rename|mkdir|rm)\b\s*\(/);
    expect(source).not.toMatch(/\b(tryAcquire|acquireLease|isPrimary)\b/);
  });
});
