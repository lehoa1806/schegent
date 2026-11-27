/**
 * FR-R8-02 (02-03) — integration proof of bounded ACP stream framing, real output-sink
 * backpressure pause/resume, cancellation escape on a permanently stalled sink, bounded verbose
 * diagnostic tee queueing, and incremental fatal-signature scanning without unbounded `liveStreamText`.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACP_MAX_CLI_LINE_BYTES,
  ACP_MAX_VERBOSE_TEE_PENDING_BYTES
} from '../../src/contracts/acp-runtime';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { getEffectiveSignatures } from '../../src/lib/fatal-signature-registry';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import type { InvocationOutputSink } from '../../src/runner/invocation-result';

const BRIDGE_BUNDLE = resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

function makeStubInner(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: async () => {
      throw new Error('legacy inner runner must not execute');
    },
    cancelActive: () => false,
    settleTeardowns: async () => [],
    close: () => undefined
  };
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

describe('FR-R8-02 (02-03) — bounded ACP stream framing, backpressure, cancellation, and incremental fatal scan', () => {
  it('bounds newline-free multi-MiB CLI stdout before UTF-8 decode and fails closed with acp-stream-overflow', async () => {
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'schegent-acp-overflow-'));
    try {
      const cliPath = join(root, 'flood-claude');
      // Emit 4 MiB with NO newline (> ACP_MAX_CLI_LINE_BYTES = 2 MiB), then newline + clean result.
      writeExecutable(
        cliPath,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
  const totalChunks = 64; // 4 MiB > 2 MiB
  let sent = 0;
  function writeMore() {
    while (sent < totalChunks) {
      sent += 1;
      if (!process.stdout.write(chunk)) {
        process.stdout.once('drain', writeMore);
        return;
      }
    }
    process.stdout.write('\\n' + JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n', () => {
      process.exit(0);
    });
  }
  writeMore();
});
`
      );
      const runner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });

      const raw = await runner.invoke({
        cliPath,
        cwd: root,
        prompt: 'flood',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 15_000
      });

      expect(ACP_MAX_CLI_LINE_BYTES).toBe(2 * 1024 * 1024);
      expect(raw.exitCode).toBe(1);
      expect(raw.terminalReconciliation?.status).toBe('stream-overflow');
      expect(raw.diagnosticWarnings).toContain('acp-stream-overflow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('pauses and resumes ACP transport on slow OutputSink and cancels immediately without deadlocking on a permanently stalled sink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schegent-acp-bp-'));
    try {
      const cliPath = join(root, 'chatty-claude');
      writeExecutable(
        cliPath,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const payload = 'x'.repeat(2048);
  let i = 0;
  const max = 200;
  function sendNext() {
    while (i < max) {
      i += 1;
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: payload + ' #' + i }] }
      }) + '\\n';
      if (!process.stdout.write(line)) {
        process.stdout.once('drain', sendNext);
        return;
      }
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }) + '\\n', () => {
      process.exit(0);
    });
  }
  sendNext();
});
`
      );
      const runner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });

      // 1. Slow sink that pauses every 5th write and drains after 10ms -> completes cleanly with bounded pending bytes!
      let writes = 0;
      let drains = 0;
      const slowSink: InvocationOutputSink = {
        write: (_stream, _chunk) => {
          writes += 1;
          return writes % 5 !== 0;
        },
        onceDrain: (_stream, cb) => {
          setTimeout(() => {
            drains += 1;
            cb();
          }, 10);
        }
      };

      const res = await runner.invoke(
        {
          cliPath,
          cwd: root,
          prompt: 'slow sink',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 15_000
        },
        slowSink
      );
      expect(res.exitCode).toBe(0);
      expect(drains).toBeGreaterThan(0);
      expect(res.streamPendingHighWaterBytes ?? 0).toBeGreaterThan(0);
      expect(res.streamPendingHighWaterBytes ?? 0).toBeLessThan(ACP_MAX_VERBOSE_TEE_PENDING_BYTES);

      // 2. Permanently stalled sink (returns false and NEVER fires onceDrain) + cancellation -> exits fast, zero hang!
      const endlessCli = join(root, 'endless-claude');
      writeExecutable(
        endlessCli,
        `#!/usr/bin/env node
process.stdin.resume();
const timer = setInterval(() => {
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'y'.repeat(4096) }] }
  }) + '\\n');
}, 15);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
`
      );
      let firstBackpressureResolve!: () => void;
      const firstBackpressure = new Promise<void>((r) => {
        firstBackpressureResolve = r;
      });
      const stalledSink: InvocationOutputSink = {
        write: () => {
          firstBackpressureResolve();
          return false;
        },
        onceDrain: () => {
          // Intentionally NEVER drains!
        }
      };
      const ac = new AbortController();
      const started = Date.now();
      const invokePromise = runner.invoke(
        {
          cliPath: endlessCli,
          cwd: root,
          prompt: 'stalled',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 15_000,
          cancellationSignal: ac.signal
        },
        stalledSink
      );
      await firstBackpressure;
      ac.abort();
      const cancelled = await invokePromise;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(cancelled.killed).toBe(true);
      expect(cancelled.terminalReconciliation?.status).toBe('cancelled');
      expect(runner.hasActiveProcess).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('detects fatal signatures incrementally across stdout and stderr without accumulating liveStreamText', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schegent-acp-fatal-'));
    try {
      const cliPath = join(root, 'fatal-stderr-claude');
      writeExecutable(
        cliPath,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('error: unknown option --bad-flag\\n');
  process.exit(2);
});
`
      );
      const runner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });

      const raw = await runner.invoke({
        cliPath,
        cwd: root,
        prompt: 'trigger fatal',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 10_000,
        effectiveFatalSignatures: getEffectiveSignatures([])
      });

      expect(raw.exitCode).toBe(1);
      expect(raw.streamFatalMatch?.matched).toBe(true);
      if (raw.streamFatalMatch?.matched) {
        expect(raw.streamFatalMatch.stream).toBe('stderr');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
