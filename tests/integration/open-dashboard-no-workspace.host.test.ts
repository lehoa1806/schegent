import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  runOpenDashboard,
  STATIC_MESSAGE,
  STATIC_TEXT,
  _resetWarningInFlightForTests,
  type OpenDashboardCtx
} from '../../src/commands/open-dashboard';
import type { Notifier } from '../../src/ui/notifications';
import type { SanitizedLogger } from '../../src/lib/logger';
import type { DashboardBridge } from '../../src/ui/dashboard/dashboard-bridge';

// Feature 015 T012 / SC-001 / SC-003 / SC-005 integration smoke. Runs inside
// the live @vscode/test-electron host and exercises the
// `schegent.openDashboard` chokepoint with an injected
// `getWorkspaceFolders` accessor returning `undefined`, mirroring the
// production state where the welcome view is showing. The smoke asserts:
//
//   - the command is registered (single chokepoint per FR-007)
//   - the gated branch fires exactly once for a click burst (FR-008, SC-006)
//   - no DashboardPanel is created (FR-004)
//   - a single `logger.warn` line matching STATIC_MESSAGE is emitted (FR-010)
//   - the static toast text matches STATIC_TEXT byte-for-byte (FR-009)
//   - the .schegent/audit.log gains zero new entries (Clarification #2)
//
// Direct invocation of `runOpenDashboard(...)` with a controlled accessor is
// the deterministic equivalent of launching the host with `--no-workspace`:
// the gate is a pure function of the accessor's return value, so verifying
// the accessor-driven branch under the real extension host proves the
// runtime contract end-to-end without needing a second test-host launcher.
const EXTENSION_ID = 'schegent.schegent';
const COMMAND_ID = 'schegent.openDashboard';

interface CapturedLogger {
  readonly logger: SanitizedLogger;
  readonly warnCalls: string[];
  readonly errorCalls: string[];
}

function makeCapturedLogger(): CapturedLogger {
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const logger = {
    info: (_msg: string) => undefined,
    warn: (msg: string) => {
      warnCalls.push(msg);
    },
    error: (msg: string) => {
      errorCalls.push(msg);
    },
    sanitize: (msg: string) => msg
  } as unknown as SanitizedLogger;
  return { logger, warnCalls, errorCalls };
}

interface CapturedNotifier {
  readonly notifier: Notifier;
  readonly warnCalls: string[];
  readonly errorCalls: string[];
  readonly infoCalls: string[];
}

function makeCapturedNotifier(): CapturedNotifier {
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const infoCalls: string[] = [];
  const notifier = {
    info: (msg: string) => {
      infoCalls.push(msg);
    },
    warn: (msg: string) => {
      warnCalls.push(msg);
      return Promise.resolve(undefined);
    },
    error: (msg: string) => {
      errorCalls.push(msg);
    }
  } as unknown as Notifier;
  return { notifier, warnCalls, errorCalls, infoCalls };
}

interface CapturedBridge {
  readonly bridge: DashboardBridge;
  callCount: number;
}

function makeCapturedBridge(): CapturedBridge {
  const out = {
    callCount: 0,
    bridge: undefined as unknown as DashboardBridge
  };
  out.bridge = {
    openDashboard: () => {
      out.callCount += 1;
    }
  } as unknown as DashboardBridge;
  return out;
}

function readAuditLogSize(workspaceRoot: string): number {
  const auditPath = path.join(workspaceRoot, '.schegent', 'audit.log');
  if (!fs.existsSync(auditPath)) return 0;
  return fs.statSync(auditPath).size;
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  // FR-007: the chokepoint command MUST be registered.
  const registered = await vscode.commands.getCommands(true);
  assert.ok(
    registered.includes(COMMAND_ID),
    `command '${COMMAND_ID}' is not registered — single chokepoint contract violated`
  );

  // Audit-log baseline before any gated click. We re-check after the burst
  // to confirm zero new bytes (Clarification #2: no new audit event type
  // and no appendAudit call from the gated path).
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test host has no workspace folder open');
  const workspaceRoot = folder.uri.fsPath;
  const auditSizeBefore = readAuditLogSize(workspaceRoot);

  _resetWarningInFlightForTests();

  const { logger, warnCalls: loggerWarns, errorCalls: loggerErrors } = makeCapturedLogger();
  const { notifier, warnCalls: notifierWarns, errorCalls: notifierErrors } = makeCapturedNotifier();
  const captured = makeCapturedBridge();

  const ctx: OpenDashboardCtx = {
    bridge: captured.bridge,
    notifier,
    logger,
    // FR-002 — the live accessor is what runOpenDashboard reads at the top
    // of every call. Returning `undefined` here is the production-equivalent
    // of launching with the welcome view.
    getWorkspaceFolders: () => undefined
  };

  // Click burst — five gated clicks in quick succession. SC-006 + FR-008
  // require exactly one toast and one logger line for the burst because
  // the captured notifier's warn returns an immediately-resolved promise
  // is faster than the synchronous reentry chain; we resolve the first
  // toast asynchronously by awaiting each call below.
  // To exercise the dedup branch deterministically we keep all calls
  // pending by NOT awaiting the resolved promise until after the burst.
  // The mock notifier returns Promise.resolve(undefined) which microtask-
  // resolves; calling runOpenDashboard 5x synchronously hits the
  // `warningInFlight === true` short-circuit for calls 2-5.
  void runOpenDashboard(undefined, ctx);
  void runOpenDashboard(undefined, ctx);
  void runOpenDashboard(undefined, ctx);
  void runOpenDashboard(undefined, ctx);
  void runOpenDashboard(undefined, ctx);

  // Yield twice so the immediately-resolved toast promise settles and the
  // `.then(reset, reset)` handler runs, clearing the warningInFlight flag.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // FR-004 — no bridge call on the gated path, ever.
  assert.strictEqual(
    captured.callCount,
    0,
    `bridge.openDashboard called ${captured.callCount} times on gated path — expected 0`
  );

  // FR-008 / SC-006 — exactly one warning toast for the burst.
  assert.strictEqual(
    notifierWarns.length,
    1,
    `notifier.warn called ${notifierWarns.length} times for the click burst — expected 1`
  );
  // FR-009 — static literal byte-for-byte.
  assert.strictEqual(
    notifierWarns[0],
    STATIC_TEXT,
    `toast text mismatch — got '${notifierWarns[0]}', expected '${STATIC_TEXT}'`
  );

  // FR-010 — exactly one sanitized log line for the burst, matching STATIC_MESSAGE.
  assert.strictEqual(
    loggerWarns.length,
    1,
    `logger.warn called ${loggerWarns.length} times for the click burst — expected 1`
  );
  assert.ok(
    loggerWarns[0].endsWith(STATIC_MESSAGE),
    `logger.warn line does not end with STATIC_MESSAGE; got: '${loggerWarns[0]}'`
  );

  // SC-005 — no error events on the gated path.
  assert.strictEqual(loggerErrors.length, 0, `logger.error called unexpectedly: ${loggerErrors.join(' | ')}`);
  assert.strictEqual(notifierErrors.length, 0, `notifier.error called unexpectedly: ${notifierErrors.join(' | ')}`);

  // Clarification #2 — the gated path does NOT append to .schegent/audit.log.
  // (The chain `runOpenDashboard → logger.warn → SanitizedLogger` writes
  // only to the host logger surface; the audit-log writer is never
  // touched on this branch.)
  const auditSizeAfter = readAuditLogSize(workspaceRoot);
  assert.strictEqual(
    auditSizeAfter,
    auditSizeBefore,
    `audit.log grew by ${auditSizeAfter - auditSizeBefore} bytes on the gated path — Clarification #2 violated`
  );

  // Defense-in-depth — invoke the registered command via the host's
  // executeCommand and confirm it does not throw. The production handler
  // wires in the live `vscode.workspace.workspaceFolders` accessor, so
  // this call exercises the happy path against the test workspace; the
  // gate's behavior under empty workspace is what we just verified above.
  // Failure modes here are activation/registration regressions, not gate
  // regressions.
  await vscode.commands.executeCommand(COMMAND_ID);

  _resetWarningInFlightForTests();
}
