// Feature 014 — Standalone Wake-up runner.
//
// Spawned by the OS scheduler (launchd / Windows Task Scheduler /
// cron / systemd-user) as `node <runner.js>`. There is NO VS Code
// host process around this binary; the `vscode` module does NOT
// resolve. The regression at
// `tests/lint/no-vscode-import-in-headless.test.ts` enforces the
// invariant at build time.
//
// Single-fire lifecycle:
//   1. SCHEGENT_WAKEUP_HOME    — bundle/home directory env var. Absent → exit 2.
//   2. Acquire wakeup.lock     — exclusive 'wx'; 120s stale-recovery (dead pid).
//   3. Re-read settings mirror — double-check `enabled` (de-bounce after disable).
//   4. Create ephemeral cwd    — under os.tmpdir()/schegent-primer-session/<id>.
//   5. Workspace defense       — fail-closed if cwd resolves inside any known root.
//   6. Env scrub               — strict allowlist + explicit denylist (defense-in-depth).
//   7. Spawn `claude -p .`     — cwd = ephemeral, env = scrubbed, 60s watchdog.
//   8. Cleanup                 — rm -rf ephemeral cwd; release lock.
//   9. Append JSONL invocation log with the literal `cwdInsideWorkspace: false`.

import {
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { InvocationLog, type InvocationRecord } from '../wakeup/invocation-log';
import {
  RUNNER_DEFAULT_MODEL,
  WAKEUP_SUPPORTED_MODELS,
  type WakeUpSettings
} from '../wakeup/settings';
import { detectPlatform, type WakeUpPlatform } from '../wakeup/platform-detect';
import { SessionCaptureRing } from '../wakeup/session-capture-ring';
import { SanitizedLogger } from '../lib/logger';
import { appendBlock } from '../wakeup/session-log-writer';

const LOCK_STALE_MS = 120_000;
const CLAUDE_TIMEOUT_MS = 60_000;
const SIGKILL_GRACE_MS = 5_000;

// Strict allowlist. Anything outside is dropped.
const ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'LANG',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP'
]);

// Defense-in-depth denylist. Even if a future maintainer adds one of
// these to the allowlist by mistake, the deny check filters it out.
const ENV_DENY_PREFIXES = ['VSCODE_', 'WORKSPACE', 'SCHEGENT_'] as const;
const ENV_DENY_EXACT = new Set(['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']);
const ENV_DENY_TOKENS = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD'] as const;

interface WorkspaceRootsMirror {
  readonly roots: readonly string[];
}

interface ClaudeResult {
  readonly exitCode: number | null;
  readonly killedByWatchdog: boolean;
  readonly spawnFailed: boolean;
  /**
   * Sanitized 4 KB compact tail of stdout+stderr — kept on the
   * `InvocationRecord.rawResponse` field so the existing "View recent
   * runs" 5-row preview UI continues to render the tail. Derived from
   * the single-pass sanitized full capture (see `sessionLogFull`).
   */
  readonly rawResponse: string;
  /**
   * Sanitized full capture (≤ 64 KB FIFO ring). Lands in the on-disk
   * session-log block for the row's expansion panel.
   */
  readonly sessionLogFull: string;
  /**
   * True iff the lifetime byte count exceeded the 64 KB capture cap
   * and FIFO eviction trimmed the head. Surfaced on the JSONL record
   * as `sessionLogTrimmed`.
   */
  readonly sessionLogTruncated: boolean;
  /**
   * Lifetime byte count of stream bytes appended to the ring
   * (pre-eviction). Surfaced on the JSONL record as
   * `sessionLogBytesAppended`.
   */
  readonly sessionLogBytesAppended: number;
}

export interface WakeupRunOptions {
  readonly homeDir?: string;
  readonly triggerSource?: 'scheduled' | 'manual';
  readonly ignoreDisabledSetting?: boolean;
  readonly recordLockSkipped?: boolean;
  /**
   * Test-only spawn override. Production scheduler/manual paths omit this so
   * the runner resolves `claude` from PATH exactly as before.
   */
  readonly claudeCommand?: string;
  readonly claudeCommandPrefixArgs?: readonly string[];
}

async function main(options: WakeupRunOptions = {}): Promise<number> {
  const home = options.homeDir ?? process.env.SCHEGENT_WAKEUP_HOME;
  if (!home) return 2;

  const startedAtMs = Date.now();
  const platform: WakeUpPlatform = detectPlatform();
  const log = new InvocationLog(home);
  const lockPath = path.join(home, 'wakeup.lock');

  let lockFd: number | null = null;
  let lockAcquired = false;
  let ephemeralCwd: string | null = null;
  let envScrubbed = false;
  let claudeExitCode: number | null = null;
  let timedOut = false;
  let skipped = false;
  let rawResponse = '';
  let errorReason: string | undefined;
  const triggerSource = options.triggerSource ?? 'scheduled';
  let shouldAppendRecord = true;
  // Feature 031 — operator's selected model (verbatim) + what the
  // runner actually invoked. Resolved AFTER the mirror is read; both
  // collapse to the `'runner-default'` sentinel when the mirror is
  // unparsable, omits the field, or carries a non-registry id.
  let requestedModel: string = RUNNER_DEFAULT_MODEL;
  let actualModel: string = RUNNER_DEFAULT_MODEL;
  // Feature 031 T034 — session-log capture metadata surfaced from the
  // ring on the JSONL record. Both default to absent (writer omits when
  // the spawn never ran, e.g. lock-held / settings-disabled paths).
  let sessionLogBytesAppended: number | undefined;
  let sessionLogTrimmed: boolean | undefined;
  // Feature 031 T048 — UUIDv4 correlation id joining the JSONL
  // InvocationRecord, the on-disk session.log block, and the audit
  // event. Generated AT spawn-start; lock-skipped (and any path that
  // never reaches the spawn) leaves this undefined so the JSONL
  // record's `correlationId` field is absent. The data-model invariant
  // (§3) is `correlationId === undefined` iff no session-log block was
  // written.
  let correlationId: string | undefined;
  // Sanitized full capture from the SessionCaptureRing — populated only
  // when the spawn actually ran. Held here so the finally block can
  // compose the session-log block AFTER the JSONL record's status is
  // finalized.
  let sessionLogFull: string | undefined;
  // Write-failed reason from the session-log writer, surfaced verbatim
  // on the JSONL record as a non-standard field so operators can grep
  // for `session-log-write-failed:eacces` without a second invocation.
  let sessionLogWriteFailedReason: string | undefined;

  try {
    lockFd = tryAcquireLock(lockPath);
    if (lockFd === null) {
      skipped = true;
      errorReason = 'lock-held';
      // Scheduled fires preserve historical behavior and exit silently.
      if (options.recordLockSkipped !== true) {
        shouldAppendRecord = false;
        return 0;
      }
      return 0;
    }
    lockAcquired = true;

    const settings = readSettingsMirror(home);
    if (!settings) {
      errorReason = 'settings-mirror-missing';
      return 1;
    }
    if (!settings.enabled && options.ignoreDisabledSetting !== true) {
      // De-bounce: scheduler fired after the user disabled wake-up but
      // before the daemon-manager finished uninstalling. Honor the
      // current setting, NOT the schedule.
      errorReason = 'settings-disabled-at-fire-time';
      return 0;
    }

    // Feature 031 T022 — resolve model from the (already-validated)
    // mirror. Three branches:
    //   (a) `runner-default` (or absent → sentinel via coercion at the
    //       writer) → omit the flag (CLI uses its own default).
    //   (b) Known registry member → carry verbatim through to `--model`.
    //   (c) Unknown identifier   → omit the flag AND surface the
    //       requested-vs-actual mismatch on the JSONL record so
    //       operators can see their selection was unhonored.
    const mirrorModelRaw: unknown = (settings as { model?: unknown }).model;
    const mirrorModel: string =
      typeof mirrorModelRaw === 'string' ? mirrorModelRaw : RUNNER_DEFAULT_MODEL;
    if (mirrorModel === RUNNER_DEFAULT_MODEL) {
      requestedModel = RUNNER_DEFAULT_MODEL;
      actualModel = RUNNER_DEFAULT_MODEL;
    } else if ((WAKEUP_SUPPORTED_MODELS as readonly string[]).includes(mirrorModel)) {
      requestedModel = mirrorModel;
      actualModel = mirrorModel;
    } else {
      // Unknown id — defense-in-depth against a future registry
      // mismatch where the operator-side allows a model that the runner
      // CLI does not yet support.
      requestedModel = mirrorModel;
      actualModel = RUNNER_DEFAULT_MODEL;
    }

    ephemeralCwd = createEphemeralCwd();

    const workspaceRoots = readWorkspaceRoots(home);
    if (cwdInsideAnyWorkspace(ephemeralCwd, workspaceRoots)) {
      // Hard invariant breached — refuse to spawn claude. This branch
      // should be unreachable on any normal host; if it fires, treat
      // as a security-critical defect to be triaged.
      errorReason = 'cwd-inside-workspace-aborted';
      return 1;
    }

    const env = scrubEnv(process.env);
    envScrubbed = true;

    // Feature 031 T048 — generate the correlation id BEFORE the spawn
    // so it joins every artefact (session.log block header + JSONL
    // record + future audit event) for this invocation.
    correlationId = randomUUID();

    const result = await spawnClaude(
      options.claudeCommand ?? 'claude',
      options.claudeCommandPrefixArgs ?? [],
      ephemeralCwd,
      env,
      actualModel
    );
    claudeExitCode = result.exitCode;
    timedOut = result.killedByWatchdog;
    rawResponse = result.rawResponse;
    sessionLogFull = result.sessionLogFull;
    sessionLogBytesAppended = result.sessionLogBytesAppended;
    sessionLogTrimmed = result.sessionLogTruncated;
    if (result.killedByWatchdog) {
      errorReason = 'claude-watchdog-killed';
    } else if (result.spawnFailed) {
      errorReason = 'claude-spawn-failed';
    } else if (typeof claudeExitCode === 'number' && claudeExitCode !== 0) {
      errorReason = `claude-exited-${claudeExitCode}`;
    }

    return 0;
  } catch (err) {
    if (!errorReason) errorReason = canonicalize(err);
    return 1;
  } finally {
    if (ephemeralCwd) {
      try {
        rmSync(ephemeralCwd, { recursive: true, force: true });
      } catch {
        // Cleanup failure is non-critical — the OS will reap /tmp.
      }
    }

    // Compute the terminal status BEFORE composing the session-log
    // block — the block header carries the status verbatim.
    const finalStatus = skipped
      ? 'skipped'
      : timedOut
        ? 'timed-out'
        : claudeExitCode === 0 && !errorReason
          ? 'succeeded'
          : 'failed';

    // Feature 031 T048 — append the on-disk session-log block when (and
    // only when) the spawn actually ran. The writer is a SINK: caller
    // sanitizes the body once, the writer never throws. Both
    // success/failure paths produce a block — the lock-skipped path is
    // explicitly excluded (it never reached the spawn so there is no
    // body to record and no correlation id to surface).
    if (
      correlationId !== undefined
      && sessionLogFull !== undefined
      && finalStatus !== 'skipped'
    ) {
      const sessionLogPath = path.join(home, 'session.log');
      const writeResult = await appendBlock({
        sessionLogPath,
        header: {
          iso: new Date(startedAtMs).toISOString(),
          correlationId,
          trigger: triggerSource,
          model: actualModel,
          status: finalStatus
        },
        body: ensureTrailingNewline(sessionLogFull)
      });
      if (writeResult.outcome === 'appended') {
        // Override the ring-derived counters with the writer's
        // ground-truth values. The ring's bytes count the captured
        // stream bytes; the writer's `bytesAppended` counts the
        // composed block (header + body) as written to disk. The JSONL
        // record surfaces the writer's value so operators can match
        // against the file size growth.
        sessionLogBytesAppended = writeResult.bytesAppended;
        sessionLogTrimmed = writeResult.trimmed;
      } else {
        // Write-failed — record the canonical reason on the JSONL
        // record but otherwise continue. The priming spawn MUST never
        // block on disk hygiene.
        sessionLogWriteFailedReason = writeResult.reason;
      }
    }

    if (shouldAppendRecord) {
      const record: InvocationRecord = {
        timestamp: new Date(startedAtMs).toISOString(),
        platform,
        pid: process.pid,
        lockAcquired,
        ephemeralCwd: ephemeralCwd ?? '',
        cwdInsideWorkspace: false,
        envScrubbed,
        claudeExitCode,
        durationMs: Date.now() - startedAtMs,
        triggerSource,
        status: finalStatus,
        timedOut,
        skipped,
        ...(rawResponse ? { rawResponse } : {}),
        ...(errorReason ? { errorReason } : {}),
        // Feature 031 T022 — surface the model selection on every
        // non-lock-skipped record. Skipped (lock-held) records keep the
        // legacy 014 shape since the fire never reached the resolution
        // step. `lockAcquired === false` is the canonical signal.
        ...(lockAcquired
          ? {
              requestedModel,
              actualModel
            }
          : {}),
        // Feature 031 T048 — correlation id surfaced when a session-log
        // block exists. Lock-skipped records leave this undefined per
        // the data-model invariant.
        ...(correlationId !== undefined && finalStatus !== 'skipped'
          ? { correlationId }
          : {}),
        // Feature 031 T034 — session-log capture metadata. The writer
        // overrides these with its ground-truth values; for paths that
        // never reached the spawn (lock-held / settings-disabled), both
        // remain absent.
        ...(sessionLogBytesAppended !== undefined ? { sessionLogBytesAppended } : {}),
        ...(sessionLogTrimmed !== undefined ? { sessionLogTrimmed } : {}),
        ...(sessionLogWriteFailedReason !== undefined
          ? { sessionLogWriteFailedReason }
          : {})
      };
      try {
        await log.append(record);
      } catch {
        // We have no other sink — the log append failure is silent.
      }
    }
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch { /* noop */ }
      try { unlinkSync(lockPath); } catch { /* noop */ }
    }
  }
}

/**
 * Ensure `body` ends with `\n` so the next block's header line lands
 * on its own line in the on-disk file. The SessionCaptureRing already
 * preserves the original stream's trailing newline; this is a safety
 * pass for the unusual case where the subprocess emitted bytes
 * without a final newline.
 */
function ensureTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : body + '\n';
}

function tryAcquireLock(lockPath: string): number | null {
  try {
    return writeLockFile(lockPath);
  } catch {
    const holder = readLockHolder(lockPath);
    if (holder && isProcessAlive(holder.pid)) {
      const age = Date.now() - holder.startMs;
      if (age < LOCK_STALE_MS) {
        // Live and fresh — defer to the other runner.
        return null;
      }
    }
    // Stale (dead pid OR age beyond watchdog window) — reclaim.
    try { unlinkSync(lockPath); } catch { /* noop */ }
    try {
      return writeLockFile(lockPath);
    } catch {
      return null;
    }
  }
}

function writeLockFile(lockPath: string): number {
  const fd = openSync(lockPath, 'wx');
  const body = JSON.stringify({ pid: process.pid, startMs: Date.now() });
  writeSync(fd, body);
  return fd;
}

function readLockHolder(lockPath: string): { pid: number; startMs: number } | null {
  try {
    const body = readFileSync(lockPath, 'utf8');
    const obj: unknown = JSON.parse(body);
    if (
      obj
      && typeof obj === 'object'
      && typeof (obj as { pid?: unknown }).pid === 'number'
      && typeof (obj as { startMs?: unknown }).startMs === 'number'
    ) {
      const o = obj as { pid: number; startMs: number };
      return { pid: o.pid, startMs: o.startMs };
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = no such process.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function readSettingsMirror(home: string): WakeUpSettings | null {
  try {
    const body = readFileSync(path.join(home, 'settings.json'), 'utf8');
    const obj: unknown = JSON.parse(body);
    if (
      obj
      && typeof obj === 'object'
      && typeof (obj as { enabled?: unknown }).enabled === 'boolean'
      && ((obj as { schedulerType?: unknown }).schedulerType === 'chronological'
        || (obj as { schedulerType?: unknown }).schedulerType === 'periodic')
      && typeof (obj as { chronologicalTime?: unknown }).chronologicalTime === 'string'
      && typeof (obj as { periodicInterval?: unknown }).periodicInterval === 'string'
    ) {
      return obj as WakeUpSettings;
    }
    return null;
  } catch {
    return null;
  }
}

function readWorkspaceRoots(home: string): readonly string[] {
  try {
    const body = readFileSync(path.join(home, 'workspace-roots.json'), 'utf8');
    const obj: unknown = JSON.parse(body);
    if (obj && typeof obj === 'object' && Array.isArray((obj as WorkspaceRootsMirror).roots)) {
      return (obj as WorkspaceRootsMirror).roots.filter((r): r is string => typeof r === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function createEphemeralCwd(): string {
  const root = path.join(os.tmpdir(), 'schegent-primer-session');
  mkdirSync(root, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cwdInsideAnyWorkspace(cwd: string, roots: readonly string[]): boolean {
  const realCwd = safeRealpath(cwd);
  for (const root of roots) {
    const realRoot = safeRealpath(root);
    if (realCwd === realRoot) return true;
    if (realCwd.startsWith(realRoot + path.sep)) return true;
  }
  return false;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function scrubEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (ENV_DENY_EXACT.has(k)) continue;
    if (ENV_DENY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (ENV_DENY_TOKENS.some((t) => k.includes(t))) continue;
    if (ENV_ALLOW.has(k) || k.startsWith('LC_')) {
      out[k] = v;
    }
  }
  return out;
}

function spawnClaude(
  command: string,
  prefixArgs: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  model: string
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    let killedByWatchdog = false;
    let settled = false;

    // Feature 031 T034 — bounded 64 KB FIFO ring captures stdout +
    // stderr with `OUT:` / `ERR:` stream prefixes. At end-of-spawn we
    // sanitize once (via `SECRET_PATTERNS` reuse) and derive both the
    // 4 KB legacy `rawResponse` projection AND the full sanitized body
    // (for the on-disk session-log block) from a single pass.
    const ring = new SessionCaptureRing();
    const sanitizer = new SanitizedLogger([]);
    const sanitize = (input: string): string => sanitizer.sanitize(input);

    // Feature 031 T022 — prepend `--model <id>` ONLY for known-registry
    // models. The `runner-default` sentinel (and any unknown id that
    // was coerced to it upstream) means "let the CLI choose its own
    // default" — omit the flag entirely.
    const args: readonly string[] =
      model === RUNNER_DEFAULT_MODEL
        ? [...prefixArgs, '-p', '.']
        : [...prefixArgs, '--model', model, '-p', '.'];

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Feature 031 — Node delivers stdout/stderr in arbitrarily-sized
    // chunks. The CLI may write multiple lines in a single chunk
    // (Node coalesces writes before draining). To get a per-line
    // `OUT:` / `ERR:` tag — which is what operators expect when
    // reading `session.log` — we buffer partial lines per stream
    // and forward complete lines (newline-terminated) to the ring
    // one append() per line.
    let pendingOut = '';
    let pendingErr = '';

    const drainLines = (
      stream: 'out' | 'err',
      buffered: string,
      incoming: string
    ): string => {
      const combined = buffered + incoming;
      const lastNewline = combined.lastIndexOf('\n');
      if (lastNewline === -1) {
        return combined;
      }
      const completeBlock = combined.slice(0, lastNewline + 1);
      const remainder = combined.slice(lastNewline + 1);
      // Emit each line individually so each carries its own stream tag.
      let cursor = 0;
      while (cursor < completeBlock.length) {
        const nl = completeBlock.indexOf('\n', cursor);
        const line = completeBlock.slice(cursor, nl + 1);
        ring.append(stream, line);
        cursor = nl + 1;
      }
      return remainder;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      pendingOut = drainLines('out', pendingOut, String(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      pendingErr = drainLines('err', pendingErr, String(chunk));
    });

    const flushPending = (): void => {
      if (pendingOut.length > 0) {
        ring.append('out', pendingOut);
        pendingOut = '';
      }
      if (pendingErr.length > 0) {
        ring.append('err', pendingErr);
        pendingErr = '';
      }
    };

    const settle = (
      partial: Omit<
        ClaudeResult,
        'rawResponse' | 'sessionLogFull' | 'sessionLogTruncated' | 'sessionLogBytesAppended'
      >
    ): void => {
      // Drain any trailing unterminated output before sealing the ring.
      // A CLI may exit without a final newline; the residue MUST still
      // appear in `session.log` with its `OUT:` / `ERR:` tag.
      flushPending();
      const finalized = ring.finalize(sanitize);
      resolve({
        ...partial,
        rawResponse: finalized.projection,
        sessionLogFull: finalized.full,
        sessionLogTruncated: finalized.truncated,
        sessionLogBytesAppended: ring.bytesAppended()
      });
    };

    const sigtermTimer = setTimeout(() => {
      killedByWatchdog = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      const sigkillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }, CLAUDE_TIMEOUT_MS);
    sigtermTimer.unref();

    // Use `close`, not `exit`: `exit` can fire before stdout/stderr pipes
    // have drained, which can seal a header-only session.log block under
    // parallel test or host load.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(sigtermTimer);
      settle({ exitCode: code, killedByWatchdog, spawnFailed: false });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(sigtermTimer);
      settle({ exitCode: null, killedByWatchdog: false, spawnFailed: true });
    });
  });
}

function canonicalize(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return `error-${code.toLowerCase()}`;
  }
  return 'unknown-error';
}

// Gate the auto-bootstrap so unit tests can import this module and
// exercise the exported helpers without firing a real wake-up. The
// runtime check is a no-op for the bundled output (esbuild preserves
// `require.main === module`, which evaluates true when the OS scheduler
// spawns `node runner.js`).
if (typeof require !== 'undefined' && require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}

export { main as runWakeup };
