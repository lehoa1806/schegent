/**
 * FR-R8-02 (02-06) — stalled-reader and newline-free ACP stream soak benchmark.
 *
 * Kept strictly separate from `tests/perf/aggregate-resource-soak.test.ts` (which preserves the
 * FR-R3-081 `ZippedStreamBuffer` baseline untouched). Drives real bundled `dist/acp-stdio-bridge.js`
 * + `AcpBackedRunner` processes at concurrency `1` and `4` across:
 *   - newline-free multi-MiB CLI stdout floods (`> ACP_MAX_CLI_LINE_BYTES = 2 MiB`)
 *   - high-volume JSONL streams under a slow/stalling `InvocationOutputSink`
 *   - concurrent permanently stalled sink cancellation + parallel healthy sibling invocation +
 *     event-loop heartbeat lag sampling
 *
 * Predeclared pass thresholds (asserted below):
 *   - `streamPendingHighWaterBytes <= ACP_MAX_VERBOSE_TEE_PENDING_BYTES` (4 MiB) per invocation
 *   - heap delta across concurrency-1 and concurrency-4 waves `<= 128 MiB`
 *   - backpressure pause/resume (`drains > 0`) actually exercised on slow sinks
 *   - cancellation of permanently stalled reader settles `< 3,000 ms` with zero residual processes
 *   - sibling fast invocation completes cleanly while a stalled sibling is backpressured
 *   - event-loop heartbeat lag stays `< 250 ms` max during active backpressure & overflow waves
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACP_MAX_CLI_LINE_BYTES,
  ACP_MAX_VERBOSE_TEE_PENDING_BYTES
} from '../../src/contracts/acp-runtime';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import type { InvocationOutputSink } from '../../src/runner/invocation-result';

const BRIDGE_BUNDLE = resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

const HEAP_DELTA_CEILING_BYTES = 128 * 1024 * 1024;
const HOST_RSS_DELTA_CEILING_BYTES = 192 * 1024 * 1024;
const BRIDGE_RSS_CEILING_BYTES = 192 * 1024 * 1024;
const CANCEL_SETTLE_CEILING_MS = 3_000;
const HEARTBEAT_MAX_LAG_MS = 250;

function sampleProcessRssBytes(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const kib = Number.parseInt(out, 10);
    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function makeStubInner(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: async () => {
      throw new Error('legacy inner runner must not run');
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

describe('FR-R8-02 (02-06) — ACP stalled-reader and newline-free flood soak', () => {
  it('bounds memory, pending bytes, heartbeat lag, cancellation latency, and sibling progress at concurrency 1 and 4', async () => {
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'schegent-acp-soak-'));
    try {
      const floodCli = join(root, 'soak-flood-claude');
      const jsonlCli = join(root, 'soak-jsonl-claude');
      const endlessCli = join(root, 'soak-endless-claude');
      const fastCli = join(root, 'soak-fast-claude');

      // 3 MiB newline-free flood (> 2 MiB bridge byte framer bound)
      writeExecutable(
        floodCli,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const chunk = Buffer.alloc(64 * 1024, 0x66);
  let n = 0;
  function push() {
    while (n < 48) {
      n += 1;
      if (!process.stdout.write(chunk)) { process.stdout.once('drain', push); return; }
    }
    process.stdout.write('\\n' + JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n', () => process.exit(0));
  }
  push();
});
`
      );

      // High-volume JSONL stream (120 chunks × 4 KiB)
      writeExecutable(
        jsonlCli,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const body = 'j'.repeat(4096);
  let i = 0;
  function push() {
    while (i < 120) {
      i += 1;
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: body }] }
      }) + '\\n';
      if (!process.stdout.write(line)) { process.stdout.once('drain', push); return; }
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } }) + '\\n', () => process.exit(0));
  }
  push();
});
`
      );

      // Continuous producer for permanently-stalled-sink cancellation + sibling progress check
      writeExecutable(
        endlessCli,
        `#!/usr/bin/env node
process.stdin.resume();
const t = setInterval(() => {
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 's'.repeat(4096) }] }
  }) + '\\n');
}, 10);
process.on('SIGTERM', () => { clearInterval(t); process.exit(143); });
`
      );

      // Healthy fast sibling
      writeExecutable(
        fastCli,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'SIBLING_OK' }] }
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n', () => process.exit(0));
});
`
      );

      const spawnedBridgePids = new Set<number>();
      let peakBridgeRssBytes = 0;

      const runner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM,
        monitorHook: (event) => {
          if (event.kind === 'started' && typeof event.pid === 'number') {
            spawnedBridgePids.add(event.pid);
            const rss = sampleProcessRssBytes(event.pid);
            if (rss !== null && rss > peakBridgeRssBytes) peakBridgeRssBytes = rss;
          }
        }
      });

      // Monitor event-loop heartbeat responsiveness across the entire soak.
      let maxHeartbeatLagMs = 0;
      let lastTick = performance.now();
      const heartbeat = setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - lastTick - 25);
        if (lag > maxHeartbeatLagMs) maxHeartbeatLagMs = lag;
        lastTick = now;
      }, 25);

      const makeSlowSink = (): { sink: InvocationOutputSink; drains: () => number } => {
        let writes = 0;
        let drainCount = 0;
        return {
          drains: () => drainCount,
          sink: {
            write: () => {
              writes += 1;
              return writes % 4 !== 0;
            },
            onceDrain: (_stream, cb) => {
              setTimeout(() => {
                drainCount += 1;
                cb();
              }, 8);
            }
          }
        };
      };

      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const hostRssBefore = process.memoryUsage().rss;
      let maxPendingHighWater = 0;
      let totalDrains = 0;
      const allWarnings: string[] = [];

      try {
        // Wave 1: Concurrency 1 (newline-free flood + slow-sink JSONL)
        const flood1 = await runner.invoke({
          cliPath: floodCli,
          cwd: root,
          prompt: 'flood-c1',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 20_000
        });
        expect(flood1.exitCode).toBe(1);
        expect(flood1.terminalReconciliation?.status).toBe('stream-overflow');
        expect(flood1.diagnosticWarnings).toContain('acp-stream-overflow');
        allWarnings.push(...(flood1.diagnosticWarnings ?? []));

        const s1 = makeSlowSink();
        const jsonl1 = await runner.invoke(
          { cliPath: jsonlCli, cwd: root, prompt: 'jsonl-c1', phase: 'implement', iteration: 1, timeoutMs: 20_000 },
          s1.sink
        );
        expect(jsonl1.exitCode).toBe(0);
        expect(s1.drains()).toBeGreaterThan(0);
        totalDrains += s1.drains();
        maxPendingHighWater = Math.max(maxPendingHighWater, jsonl1.streamPendingHighWaterBytes ?? 0);
        allWarnings.push(...(jsonl1.diagnosticWarnings ?? []));

        // Wave 2: Concurrency 4 (2 newline-free floods + 2 slow-sink JSONL in parallel)
        const s2a = makeSlowSink();
        const s2b = makeSlowSink();
        const wave4 = await Promise.all([
          runner.invoke({ cliPath: floodCli, cwd: root, prompt: 'flood-c4-a', phase: 'implement', iteration: 1, timeoutMs: 25_000 }),
          runner.invoke({ cliPath: floodCli, cwd: root, prompt: 'flood-c4-b', phase: 'implement', iteration: 1, timeoutMs: 25_000 }),
          runner.invoke(
            { cliPath: jsonlCli, cwd: root, prompt: 'jsonl-c4-a', phase: 'implement', iteration: 1, timeoutMs: 25_000 },
            s2a.sink
          ),
          runner.invoke(
            { cliPath: jsonlCli, cwd: root, prompt: 'jsonl-c4-b', phase: 'implement', iteration: 1, timeoutMs: 25_000 },
            s2b.sink
          )
        ]);
        expect(wave4[0].terminalReconciliation?.status).toBe('stream-overflow');
        expect(wave4[1].terminalReconciliation?.status).toBe('stream-overflow');
        expect(wave4[2].exitCode).toBe(0);
        expect(wave4[3].exitCode).toBe(0);
        expect(s2a.drains()).toBeGreaterThan(0);
        expect(s2b.drains()).toBeGreaterThan(0);
        totalDrains += s2a.drains() + s2b.drains();
        for (const r of wave4) {
          maxPendingHighWater = Math.max(maxPendingHighWater, r.streamPendingHighWaterBytes ?? 0);
          allWarnings.push(...(r.diagnosticWarnings ?? []));
        }

        // Wave 3: Permanently stalled reader + concurrent fast sibling progress + prompt cancellation!
        let stallStartedResolve!: () => void;
        const stallStarted = new Promise<void>((r) => {
          stallStartedResolve = r;
        });
        const stalledSink: InvocationOutputSink = {
          write: () => {
            stallStartedResolve();
            return false;
          },
          onceDrain: () => {
            // Never drains!
          }
        };
        const ac = new AbortController();
        const stalledPromise = runner.invoke(
          {
            cliPath: endlessCli,
            cwd: root,
            prompt: 'stalled-forever',
            phase: 'implement',
            iteration: 1,
            timeoutMs: 20_000,
            cancellationSignal: ac.signal
          },
          stalledSink
        );
        await stallStarted;

        // Sample live bridge RSS while stalled sibling is active.
        for (const pid of spawnedBridgePids) {
          const rss = sampleProcessRssBytes(pid);
          if (rss !== null && rss > peakBridgeRssBytes) peakBridgeRssBytes = rss;
        }

        // While the stalled sibling is blocked, a healthy sibling MUST complete cleanly!
        const siblingOut = await runner.invoke({
          cliPath: fastCli,
          cwd: root,
          prompt: 'sibling-fast',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000
        });
        expect(siblingOut.exitCode).toBe(0);
        allWarnings.push(...(siblingOut.diagnosticWarnings ?? []));

        const cancelStart = performance.now();
        ac.abort();
        const stalledOut = await stalledPromise;
        const cancelElapsedMs = performance.now() - cancelStart;
        expect(stalledOut.killed).toBe(true);
        expect(stalledOut.terminalReconciliation?.status).toBe('cancelled');
        expect(cancelElapsedMs).toBeLessThan(CANCEL_SETTLE_CEILING_MS);
        allWarnings.push(...(stalledOut.diagnosticWarnings ?? []));

        const teardowns = await runner.settleTeardowns();
        expect(teardowns.every((t) => t.result !== 'tree-unconfirmed')).toBe(true);
        expect(runner.hasActiveProcess).toBe(false);
        expect(allWarnings).not.toContain('acp-transport-residual-group');

        // Verify EVERY spawned bridge PID actually exited at OS level (no surviving processes).
        expect(spawnedBridgePids.size).toBeGreaterThanOrEqual(8);
        for (const pid of spawnedBridgePids) {
          expect(isPidAlive(pid), `bridge pid ${pid} must be exited`).toBe(false);
        }
      } finally {
        clearInterval(heartbeat);
      }

      global.gc?.();
      const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const hostRssDeltaBytes = Math.max(0, process.memoryUsage().rss - hostRssBefore);

      // Assert all predeclared FR-R8-02 (02-06) bounds!
      expect(ACP_MAX_CLI_LINE_BYTES).toBe(2 * 1024 * 1024);
      expect(totalDrains).toBeGreaterThan(0);
      expect(maxPendingHighWater).toBeLessThanOrEqual(ACP_MAX_VERBOSE_TEE_PENDING_BYTES);
      expect(heapDeltaBytes).toBeLessThanOrEqual(HEAP_DELTA_CEILING_BYTES);
      expect(hostRssDeltaBytes).toBeLessThanOrEqual(HOST_RSS_DELTA_CEILING_BYTES);
      if (process.platform !== 'win32') {
        expect(peakBridgeRssBytes).toBeGreaterThan(0);
        expect(peakBridgeRssBytes).toBeLessThanOrEqual(BRIDGE_RSS_CEILING_BYTES);
      }
      expect(maxHeartbeatLagMs).toBeLessThan(HEARTBEAT_MAX_LAG_MS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
