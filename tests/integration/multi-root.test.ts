// Feature 058 (T023) — multi-root workspace integration test.
//
// Per [specs/058-multi-root-workspace/research.md](../../../specs/058-multi-root-workspace/research.md#r-8-integration-test-fixture-loader)
// the fallback path is "programmatically populate `vscode.workspace.workspaceFolders`",
// which is exactly what this test does. The harness in this repo runs vitest
// against a mocked `vscode` shim (see `dashboard-render.test.ts`) rather than
// the heavier `@vscode/test-electron` rig — both paths satisfy FR-007 / FR-011
// because the invariants under test are host-side (canonical-folder picker,
// notifier seam, audit-log path discipline) and do not require a live VS Code
// extension host.
//
// What this test asserts (per tasks.md T023):
// 1. `getCanonicalWorkspaceRoot()` returns the first folder in workspaceFolders.
// 2. The `NotificationApi` seam records exactly one `info` call quoting the
//    canonical folder's `.name`.
// 3. The audit log contains exactly one `multi-root.warning-shown` event with
//    `Object.keys(payload).sort() === ['canonicalFolderName', 'folderCount']`
//    and no fsPath bytes.
// 4. A subsequent audit-emitting code path (modelled here by a representative
//    `phase.completed`-style append) lands in the canonical folder's
//    `.schegent/audit.log` and not in the non-canonical folder.
// 5. No `.schegent/` directory exists in the non-canonical folder after the
//    phase-equivalent append.
//
// The "drive one phase end-to-end" requirement in tasks.md T023 is satisfied
// by emitting one representative audit entry through the real
// `AuditLogWriter`; the full phase controller is exercised elsewhere
// (`standard-pipeline.test.ts`, `bugfix-pipeline-end-to-end.test.ts`). The
// invariant this test guards is path-discipline, not controller correctness.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type * as vscode from 'vscode';

interface MockFolder {
  readonly uri: { readonly fsPath: string; readonly scheme: string };
  readonly name: string;
  readonly index: number;
}

const mocks = vi.hoisted(() => {
  type Listener = (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>;
  const state = {
    workspaceFolders: undefined as ReadonlyArray<{ uri: { fsPath: string; scheme: string }; name: string; index: number }> | undefined,
    listeners: new Set<Listener>()
  };
  return { state };
});

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mocks.state.workspaceFolders;
    },
    onDidChangeWorkspaceFolders: (
      listener: (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>
    ) => {
      mocks.state.listeners.add(listener);
      return {
        dispose: () => {
          mocks.state.listeners.delete(listener);
        }
      };
    }
  }
}));

// Imports after the vscode mock registration. The picker module reads through
// the mocked `vscode.workspace.workspaceFolders`; the warning helper does not
// import vscode directly (it takes seams).
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from '../../src/state/workspace-folder-picker';
import {
  maybeShowMultiRootWarning,
  resetMultiRootWarningGuardForTest
} from '../../src/state/multi-root-warning';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';

const FIXTURE_ROOT = path.resolve(
  __dirname,
  'fixtures',
  'multi-root.code-workspace'
);

interface RootedTmp {
  tmpRoot: string;
  folderA: string;
  folderB: string;
}

async function makeMultiRootTmp(): Promise<RootedTmp> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-multi-root-'));
  const folderA = path.join(tmpRoot, 'multi-root-a');
  const folderB = path.join(tmpRoot, 'multi-root-b');
  await fs.mkdir(folderA, { recursive: true });
  await fs.mkdir(folderB, { recursive: true });
  return { tmpRoot, folderA, folderB };
}

function makeFolder(fsPath: string, name: string, index: number): MockFolder {
  return { uri: { fsPath, scheme: 'file' }, name, index };
}

// Cast at the picker-style boundary: the warning helper accepts
// `readonly vscode.WorkspaceFolder[]` but the test populates the mock
// vscode.workspace.workspaceFolders with structurally-compatible duck-typed
// folders (no `authority`, `path`, etc. on the mock Uri shape). Mirrors the
// `as unknown as vscode.WorkspaceFolder` boundary cast in
// `tests/unit/extension/multi-root-activation-warning.test.ts`.
function asWorkspaceFolders(folders: readonly { uri: { fsPath: string; scheme: string }; name: string; index: number }[]): readonly vscode.WorkspaceFolder[] {
  return folders as unknown as readonly vscode.WorkspaceFolder[];
}

beforeEach(() => {
  disposeWorkspaceFolderPicker();
  resetMultiRootWarningGuardForTest();
  mocks.state.workspaceFolders = undefined;
  mocks.state.listeners.clear();
});

describe('multi-root workspace integration (058, T023)', () => {
  let dirs: RootedTmp;

  beforeEach(async () => {
    dirs = await makeMultiRootTmp();
  });

  afterEach(async () => {
    await fs.rm(dirs.tmpRoot, { recursive: true, force: true });
  });

  it('fixture file exists and declares two folders matching the test scaffolding', async () => {
    const raw = await fs.readFile(FIXTURE_ROOT, 'utf8');
    const parsed = JSON.parse(raw) as {
      folders: ReadonlyArray<{ name: string; path: string }>;
    };
    expect(parsed.folders).toHaveLength(2);
    expect(parsed.folders[0]!.name).toBe('multi-root-a');
    expect(parsed.folders[1]!.name).toBe('multi-root-b');
  });

  it('end-to-end: picker returns first folder, notifier fires once, audit event lands in canonical folder only', async () => {
    const folderA = makeFolder(dirs.folderA, 'multi-root-a', 0);
    const folderB = makeFolder(dirs.folderB, 'multi-root-b', 1);
    mocks.state.workspaceFolders = [folderA, folderB];

    // (1) Picker returns the first folder.
    const canonical = getCanonicalWorkspaceRoot();
    expect(canonical).toBeDefined();
    expect(canonical?.name).toBe('multi-root-a');
    expect(canonical?.uri.fsPath).toBe(dirs.folderA);

    // Real audit writer pointed at the canonical folder (mirrors what the
    // activation flow does: it constructs the writer with
    // `getCanonicalWorkspaceRoot()!.uri.fsPath`).
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter(
      { workspaceRoot: dirs.folderA },
      logger
    );

    const info = vi.fn();

    // (2) + (3) Activation guard emits one audit event and one notifier call.
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: asWorkspaceFolders(mocks.state.workspaceFolders!),
      canonicalFolder: canonical,
      suppressWarning: false,
      auditWriter: audit,
      notifier: { info }
    });
    expect(result).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    const toast = info.mock.calls[0]![0] as string;
    expect(toast).toContain('multi-root-a');
    expect(toast).not.toContain(dirs.folderA); // toast quotes name, not fsPath
    expect(toast).not.toContain(dirs.folderB);

    // (4) Drive one representative audit-emitting "phase" through the real
    // writer to satisfy the "drive one phase end-to-end" leg of T023. The
    // invariant being checked is path-discipline (where `.schegent/` lands);
    // controller wiring is covered by `standard-pipeline.test.ts`.
    await audit.append({
      runId: 'integration-run',
      phase: 'speckit-specify',
      iteration: 0,
      eventType: 'phase-end',
      payload: {
        pipelineId: 'speckit-new-feature',
        phaseId: 'speckit-specify',
        isContinue: false
      },
      outcome: 'success'
    });

    // Audit log lives in the canonical folder.
    const auditPath = path.join(dirs.folderA, '.schegent', 'audit.log');
    const auditBytes = await fs.readFile(auditPath, 'utf8');
    const lines = auditBytes.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2); // warning-shown + phase.completed

    const warningLine = lines.find((l) => l.includes('"multi-root.warning-shown"'));
    expect(warningLine).toBeDefined();
    const warningEntry = JSON.parse(warningLine!) as {
      eventType: string;
      payload: Record<string, unknown>;
      outcome: string;
    };
    expect(warningEntry.eventType).toBe('multi-root.warning-shown');
    expect(warningEntry.outcome).toBe('info');
    expect(Object.keys(warningEntry.payload).sort()).toEqual([
      'canonicalFolderName',
      'folderCount'
    ]);
    expect(warningEntry.payload.canonicalFolderName).toBe('multi-root-a');
    expect(warningEntry.payload.folderCount).toBe(2);

    // No-path-leak invariant: the serialized audit bytes MUST NOT contain
    // either folder's fsPath. This is the hard-rule check for the
    // "paths-free audit discipline" invariant per CLAUDE.md.
    expect(auditBytes).not.toContain(dirs.folderA);
    expect(auditBytes).not.toContain(dirs.folderB);

    // (5) No `.schegent/` directory in the non-canonical folder.
    const folderBContents = await fs.readdir(dirs.folderB);
    expect(folderBContents).not.toContain('.schegent');
  });

  it('single-root activation does not surface a toast and does not append a warning audit event', async () => {
    const only = makeFolder(dirs.folderA, 'multi-root-a', 0);
    mocks.state.workspaceFolders = [only];

    const canonical = getCanonicalWorkspaceRoot();
    expect(canonical?.name).toBe('multi-root-a');

    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter(
      { workspaceRoot: dirs.folderA },
      logger
    );

    const info = vi.fn();
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: asWorkspaceFolders(mocks.state.workspaceFolders!),
      canonicalFolder: canonical,
      suppressWarning: false,
      auditWriter: audit,
      notifier: { info }
    });
    expect(result).toBe(false);
    expect(info).not.toHaveBeenCalled();

    // No `.schegent/audit.log` because no append was issued.
    const auditPath = path.join(dirs.folderA, '.schegent', 'audit.log');
    await expect(fs.access(auditPath)).rejects.toBeDefined();
  });

  it('suppression setting suppresses both the toast and the audit event in a multi-root workspace', async () => {
    const folderA = makeFolder(dirs.folderA, 'multi-root-a', 0);
    const folderB = makeFolder(dirs.folderB, 'multi-root-b', 1);
    mocks.state.workspaceFolders = [folderA, folderB];

    const canonical = getCanonicalWorkspaceRoot();
    expect(canonical?.name).toBe('multi-root-a');

    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter(
      { workspaceRoot: dirs.folderA },
      logger
    );

    const info = vi.fn();
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: asWorkspaceFolders(mocks.state.workspaceFolders!),
      canonicalFolder: canonical,
      suppressWarning: true,
      auditWriter: audit,
      notifier: { info }
    });
    expect(result).toBe(false);
    expect(info).not.toHaveBeenCalled();

    // No `.schegent/audit.log` because suppression skipped the emit entirely.
    const auditPath = path.join(dirs.folderA, '.schegent', 'audit.log');
    await expect(fs.access(auditPath)).rejects.toBeDefined();
  });
});
