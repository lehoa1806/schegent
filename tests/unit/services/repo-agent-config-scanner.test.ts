import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AGENT_CONFIG_FILE_BYTES,
  MAX_AGENT_CONFIG_FILES,
  MAX_AGENT_CONFIG_TOTAL_BYTES,
  MAX_AGENT_CONFIG_WALK_DEPTH,
  readBoundedBytes,
  scanOpenedHandle,
  scanRepoAgentConfig
} from '../../../src/services/repo-agent-config-scanner';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('scanRepoAgentConfig (FR-R7-04, SC-001, SC-003, SC-004)', () => {
  it('SC-001: scans Claude hooks, .mcp.json, and CLAUDE.md and never exposes planted secrets', async () => {
    const root = await makeTempDir('schegent-ack-fixture-');
    const secretA = 'SECRET_HOOK_COMMAND_ALPHA_12345';
    const secretB = 'SECRET_MCP_API_KEY_BETA_67890';
    const secretC = 'SECRET_CLAUDE_MD_LINE_GAMMA_54321';

    await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: secretA }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }]
        },
        env: { TOKEN: secretA },
        permissions: { allow: ['Bash(*)'] }
      }),
      'utf8'
    );
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ servers: { demo: { env: { KEY: secretB } } } }),
      'utf8'
    );
    await fsp.writeFile(path.join(root, 'CLAUDE.md'), `# Instructions\n${secretC}\n`, 'utf8');

    const result = await scanRepoAgentConfig(root, 'claude');
    expect(result.scanError).toBe(false);
    expect(result.persistable).toBe(true);
    expect(result.entries.map((e) => e.name)).toEqual([
      '.claude/settings.json',
      '.mcp.json',
      'CLAUDE.md'
    ]);

    const settings = result.entries[0]!;
    expect(settings.status).toBe('present');
    if (settings.status === 'present') {
      expect(settings.hookEvents).toEqual(['PreToolUse', 'Stop']);
      expect(settings.settingKeys).toEqual(['env', 'permissions']);
      expect(settings.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(settings.size).toBeGreaterThan(0);
    }

    const mcp = result.entries[1]!;
    expect(mcp.status).toBe('present');
    if (mcp.status === 'present') {
      expect(mcp.hookEvents).toBeUndefined();
      expect(mcp.settingKeys).toBeUndefined();
      expect(mcp.digest).toMatch(/^[0-9a-f]{64}$/);
    }

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretA);
    expect(serialized).not.toContain(secretB);
    expect(serialized).not.toContain(secretC);
  });

  it('SC-002: changes fingerprint when a single byte of any tracked file changes', async () => {
    const root = await makeTempDir('schegent-ack-byte-');
    await fsp.writeFile(path.join(root, 'CLAUDE.md'), 'hello world', 'utf8');
    const first = await scanRepoAgentConfig(root, 'claude');
    await fsp.writeFile(path.join(root, 'CLAUDE.md'), 'hello worle', 'utf8');
    const second = await scanRepoAgentConfig(root, 'claude');

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('SC-003: refuses a symlink pointing outside the workspace root and reports it as unreadable', async () => {
    const root = await makeTempDir('schegent-ack-ws-');
    const outside = await makeTempDir('schegent-ack-outside-');
    const outsideSecret = 'OUTSIDE_SECRET_DO_NOT_READ';
    const outsideFile = path.join(outside, 'secret-settings.json');
    await fsp.writeFile(outsideFile, JSON.stringify({ hooks: { PreToolUse: [outsideSecret] } }), 'utf8');

    await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
    await fsp.symlink(outsideFile, path.join(root, '.claude', 'settings.json'));

    const result = await scanRepoAgentConfig(root, 'claude');
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([
      {
        name: '.claude/settings.json',
        status: 'unreadable',
        unreadableReason: 'symlink'
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(outsideSecret);
  });

  it('reports oversized files (> maxBytes) as unreadable without reading past bound', async () => {
    const root = await makeTempDir('schegent-ack-big-');
    const big = Buffer.alloc(MAX_AGENT_CONFIG_FILE_BYTES + 1024, 0x41);
    await fsp.writeFile(path.join(root, 'CLAUDE.md'), big);

    const result = await scanRepoAgentConfig(root, 'claude', { maxBytes: big.length });
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([
      {
        name: 'CLAUDE.md',
        status: 'unreadable',
        unreadableReason: 'size-limit-exceeded'
      }
    ]);
  });

  it('handles malformed JSON in .claude/settings.json safely without crashing or leaking content', async () => {
    const root = await makeTempDir('schegent-ack-badjson-');
    const secret = 'MALFORMED_SECRET_VALUE_999';
    await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(root, '.claude', 'settings.json'), `{ broken: "${secret}"`, 'utf8');

    const result = await scanRepoAgentConfig(root, 'claude');
    expect(result.persistable).toBe(true);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.status).toBe('present');
    if (entry.status === 'present') {
      expect(entry.metadataMalformed).toBe(true);
      expect(entry.hookEvents).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('treats a directory at a candidate file path as unreadable non-regular file', async () => {
    const root = await makeTempDir('schegent-ack-dir-');
    await fsp.mkdir(path.join(root, 'CLAUDE.md'), { recursive: true });

    const result = await scanRepoAgentConfig(root, 'claude');
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([
      {
        name: 'CLAUDE.md',
        status: 'unreadable',
        unreadableReason: 'not-a-regular-file'
      }
    ]);
  });

  it('returns empty non-error result for workspace with no config and for agy backend', async () => {
    const root = await makeTempDir('schegent-ack-empty-');
    const claudeEmpty = await scanRepoAgentConfig(root, 'claude');
    expect(claudeEmpty.entries).toEqual([]);
    expect(claudeEmpty.scanError).toBe(false);
    expect(claudeEmpty.persistable).toBe(false);

    await fsp.writeFile(path.join(root, 'CLAUDE.md'), '# hello', 'utf8');
    const agyResult = await scanRepoAgentConfig(root, 'agy');
    expect(agyResult.entries).toEqual([]);
    expect(agyResult.scanError).toBe(false);
  });

  it('SC-004 control: scanner source passes expansion-freeze and a planted mcpServers parse would fail it', async () => {
    const scannerSource = await fsp.readFile(
      path.resolve(__dirname, '../../../src/services/repo-agent-config-scanner.ts'),
      'utf8'
    );
    const freezePattern = /\bmodelcontextprotocol\b|@modelcontextprotocol|\bmcpServers\b|\bMcpServer\b/;
    expect(freezePattern.test(scannerSource)).toBe(false);
    const planted = `${scannerSource}\nconst parsed = JSON.parse(raw).mcpServers;`;
    expect(freezePattern.test(planted)).toBe(true);
  });

  it('strips Unicode bidi/control characters from hook event names and flags invalid hooks shape', async () => {
    const root = await makeTempDir('schegent-ack-bidi-');
    await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          '\u202ePreToolUse\u0007': [],
          PreToolUse: []
        }
      }),
      'utf8'
    );
    await fsp.writeFile(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: ['not-an-object'] }),
      'utf8'
    );

    const result = await scanRepoAgentConfig(root, 'claude');
    expect(result.entries).toHaveLength(2);
    const main = result.entries[0]!;
    const local = result.entries[1]!;
    expect(main.status).toBe('present');
    if (main.status === 'present') {
      expect(main.hookEvents).toEqual(['PreToolUse']);
    }
    expect(local.status).toBe('present');
    if (local.status === 'present') {
      expect(local.metadataMalformed).toBe(true);
    }
  });

  it('fails closed with timeout scanError and stops mutating entries when scan exceeds timeoutMs', async () => {
    const root = await makeTempDir('schegent-ack-timeout-');
    let resolveDelayed: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      resolveDelayed = resolve;
    });
    const calls: string[] = [];

    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof scanRepoAgentConfig>>;
    try {
      const resultPromise = scanRepoAgentConfig(root, 'claude', {
        timeoutMs: 25,
        scanPath: async (_ws, relPath) => {
          calls.push(relPath);
          await delayed;
          return { name: relPath, status: 'present', size: 1, digest: 'a'.repeat(64) };
        }
      });
      await vi.advanceTimersByTimeAsync(25);
      result = await resultPromise;
    } finally {
      vi.useRealTimers();
    }

    // Release delayed promise after timeout and flush microtasks + one immediate turn
    // to confirm late completion does not mutate result.entries.
    resolveDelayed?.();
    await new Promise<void>((r) => setImmediate(r));

    expect(result.scanError).toBe(true);
    expect(result.scanErrorReason).toBe('timeout');
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each(['resolve', 'reject'])('classifies a late final scan %s as a timeout', async (settle) => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const result = await scanRepoAgentConfig('unused', 'codex', {
        timeoutMs: 25,
        scanPath: async (_root, name) => {
          if (name === 'AGENTS.override.md') {
            now = 26;
            if (settle === 'reject') throw new Error('read failed after deadline');
          }
          return { name, status: 'present', size: 1, digest: 'a'.repeat(64) };
        }
      });
      expect(result).toMatchObject({ scanError: true, scanErrorReason: 'timeout', persistable: false });
      expect(result.entries.map((entry) => entry.name)).toEqual(['.codex/config.toml', 'AGENTS.md']);
    } finally {
      clock.mockRestore();
    }
  });

  it('FR-R7-11: reads exact-cap files without ever requesting bytes past maxBytes (zero 1-byte overshoot)', async () => {
    const cap = 40_000; // Spans multiple 16 KiB chunks.
    const payload = Buffer.alloc(cap, 0x61);
    let offset = 0;
    let totalRequested = 0;
    const requestedLengths: number[] = [];

    const fakeHandle = {
      stat: vi.fn(async () => ({ size: cap })),
      read: vi.fn(async (buf: Buffer, bufOffset: number, length: number) => {
        totalRequested += length;
        requestedLengths.push(length);
        const toCopy = Math.min(length, payload.length - offset);
        payload.copy(buf, bufOffset, offset, offset + toCopy);
        offset += toCopy;
        return { bytesRead: toCopy, buffer: buf };
      }),
      close: vi.fn(async () => undefined)
    } as unknown as fsp.FileHandle;

    const read = await readBoundedBytes(fakeHandle, cap);
    expect(read.outcome).toBe('ok');
    if (read.outcome === 'ok') {
      expect(read.bytes.length).toBe(cap);
      expect(read.bytes.equals(payload)).toBe(true);
    }
    // Every chunk request stays strictly within maxBytes — zero sentinel overshoot.
    expect(totalRequested).toBe(cap);
    expect(requestedLengths.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(cap);

    // Also verify exact MAX_AGENT_CONFIG_FILE_BYTES on disk succeeds as present.
    const root = await makeTempDir('schegent-ack-exactcap-');
    await fsp.writeFile(path.join(root, 'CLAUDE.md'), Buffer.alloc(MAX_AGENT_CONFIG_FILE_BYTES, 0x42));
    const diskResult = await scanRepoAgentConfig(root, 'claude');
    expect(diskResult.scanError).toBe(false);
    expect(diskResult.persistable).toBe(true);
    expect(diskResult.entries).toHaveLength(1);
    expect(diskResult.entries[0]).toMatchObject({
      name: 'CLAUDE.md',
      status: 'present',
      size: MAX_AGENT_CONFIG_FILE_BYTES
    });
  });

  it('FR-R7-11: catches a file growing past maxBytes via post-read fstat without reading past maxBytes', async () => {
    const cap = 64;
    const initialData = Buffer.alloc(cap, 0x78);
    let offset = 0;
    let statCalls = 0;
    let totalRequested = 0;

    const growingHandle = {
      stat: vi.fn(async () => {
        statCalls += 1;
        // Pre-read stat fits cap; post-read stat reflects concurrent growth past cap.
        return { size: statCalls === 1 ? cap : cap + 1 };
      }),
      read: vi.fn(async (buf: Buffer, bufOffset: number, length: number) => {
        totalRequested += length;
        const toCopy = Math.min(length, initialData.length - offset);
        initialData.copy(buf, bufOffset, offset, offset + toCopy);
        offset += toCopy;
        return { bytesRead: toCopy, buffer: buf };
      }),
      close: vi.fn(async () => undefined)
    } as unknown as fsp.FileHandle;

    const entry = await scanOpenedHandle('CLAUDE.md', growingHandle, cap);
    expect(entry).toEqual({
      name: 'CLAUDE.md',
      status: 'unreadable',
      unreadableReason: 'size-limit-exceeded'
    });
    expect(totalRequested).toBeLessThanOrEqual(cap);
    expect(statCalls).toBe(2);
    expect(growingHandle.close).toHaveBeenCalledTimes(1);
  });

  it('FR-R7-11: threads AbortSignal into stalled read, fails closed on timeout, closes handle, and never mutates entries', async () => {
    const root = await makeTempDir('schegent-ack-stalled-');
    let observedSignal: AbortSignal | undefined;
    let releaseRead: ((res: { bytesRead: number; buffer: Buffer }) => void) | undefined;
    let markFirstCloseAttempt!: () => void;
    const firstCloseAttempted = new Promise<void>((resolve) => {
      markFirstCloseAttempt = resolve;
    });
    let markClosedCleanly!: () => void;
    const closedCleanly = new Promise<void>((resolve) => {
      markClosedCleanly = resolve;
    });
    let closeAttempts = 0;
    let readSettled = false;

    const stalledHandle = {
      stat: vi.fn(async () => ({ size: 128 })),
      read: vi.fn(
        (buf: Buffer) =>
          new Promise<{ bytesRead: number; buffer: Buffer }>((resolve) => {
            releaseRead = (res) => {
              readSettled = true;
              resolve(res);
            };
            void buf;
          })
      ),
      close: vi.fn(async () => {
        closeAttempts += 1;
        // Simulate EBUSY while the single libuv syscall is in flight; succeed once settled.
        if (!readSettled) {
          markFirstCloseAttempt();
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        markClosedCleanly();
      })
    } as unknown as fsp.FileHandle;

    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof scanRepoAgentConfig>>;
    try {
      const resultPromise = scanRepoAgentConfig(root, 'claude', {
        timeoutMs: 25,
        scanPath: (_ws, relPath, maxBytes, signal) => {
          observedSignal = signal;
          return scanOpenedHandle(relPath, stalledHandle, maxBytes, signal);
        }
      });
      await vi.advanceTimersByTimeAsync(25);
      result = await resultPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(result.scanError).toBe(true);
    expect(result.scanErrorReason).toBe('timeout');
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);

    // Wait for the immediate close attempt (EBUSY while read is in flight), then settle the
    // stalled read and confirm the descriptor closes cleanly without mutating result.entries.
    await firstCloseAttempted;
    releaseRead?.({ bytesRead: 0, buffer: Buffer.alloc(0) });
    await closedCleanly;
    expect(closeAttempts).toBe(2);
    expect(result.entries).toEqual([]);
  });

  it('FR-R7-11: rejects concurrent size mutation within maxBytes (total !== postStat.size) as unreadable with persistable=false and zero digest', async () => {
    const root = await makeTempDir('schegent-ack-mutated-');
    const cap = 256;
    const initialData = Buffer.alloc(50, 0x6d);

    const makeMutatedHandle = (postSize: number) => {
      let offset = 0;
      let statCalls = 0;
      const close = vi.fn(async () => undefined);
      const handle = {
        stat: vi.fn(async () => {
          statCalls += 1;
          return { size: statCalls === 1 ? initialData.length : postSize };
        }),
        read: vi.fn(async (buf: Buffer, bufOffset: number, length: number) => {
          const toCopy = Math.min(length, initialData.length - offset);
          initialData.copy(buf, bufOffset, offset, offset + toCopy);
          offset += toCopy;
          return { bytesRead: toCopy, buffer: buf };
        }),
        close
      } as unknown as fsp.FileHandle;
      return { handle, close, getStatCalls: () => statCalls };
    };

    const direct = makeMutatedHandle(150);
    const readOutcome = await readBoundedBytes(direct.handle, cap);
    expect(readOutcome).toEqual({ outcome: 'changed' });
    expect(direct.getStatCalls()).toBe(2);

    const scanned = makeMutatedHandle(150);
    const result = await scanRepoAgentConfig(root, 'claude', {
      maxBytes: cap,
      scanPath: (_ws, relPath, maxBytes, signal) => {
        if (relPath === 'CLAUDE.md') {
          return scanOpenedHandle(relPath, scanned.handle, maxBytes, signal);
        }
        return Promise.resolve(null);
      }
    });

    expect(result.scanError).toBe(false);
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([
      {
        name: 'CLAUDE.md',
        status: 'unreadable',
        unreadableReason: 'io-failed'
      }
    ]);
    expect('digest' in (result.entries[0] ?? {})).toBe(false);
    expect(scanned.close).toHaveBeenCalledTimes(1);
  });

  it('S3: walks .claude/{skills,commands,agents,hooks}/ recursively up to depth 4 and refuses symlinks', async () => {
    const root = await makeTempDir('schegent-ack-walk-');
    const outside = await makeTempDir('schegent-ack-walk-outside-');
    const outsideFile = path.join(outside, 'secret.md');
    await fsp.writeFile(outsideFile, 'OUTSIDE_WALK_SECRET', 'utf8');

    await fsp.mkdir(path.join(root, '.claude', 'skills', 's1', 'nested'), { recursive: true });
    await fsp.mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
    await fsp.mkdir(path.join(root, '.claude', 'agents'), { recursive: true });
    await fsp.mkdir(path.join(root, '.claude', 'hooks'), { recursive: true });
    await fsp.writeFile(path.join(root, '.claude', 'skills', 's1', 'nested', 'SKILL.md'), '# skill', 'utf8');
    await fsp.writeFile(path.join(root, '.claude', 'commands', 'ship.md'), '# cmd', 'utf8');
    await fsp.writeFile(path.join(root, '.claude', 'agents', 'reviewer.md'), '# agent', 'utf8');
    await fsp.writeFile(path.join(root, '.claude', 'hooks', 'pre.sh'), '#!/bin/sh\necho ok\n', 'utf8');

    const clean = await scanRepoAgentConfig(root, 'claude');
    expect(clean.scanError).toBe(false);
    expect(clean.persistable).toBe(true);
    expect(clean.entries.map((e) => e.name)).toEqual([
      '.claude/skills/s1/nested/SKILL.md',
      '.claude/commands/ship.md',
      '.claude/agents/reviewer.md',
      '.claude/hooks/pre.sh'
    ]);

    // Plant a symlink inside .claude/skills/: must be refused as unreadable symlink without reading target.
    await fsp.symlink(outsideFile, path.join(root, '.claude', 'skills', 'leak.md'));
    const withSymlink = await scanRepoAgentConfig(root, 'claude');
    expect(withSymlink.persistable).toBe(false);
    expect(withSymlink.entries).toContainEqual({
      name: '.claude/skills/leak.md',
      status: 'unreadable',
      unreadableReason: 'symlink'
    });
    expect(JSON.stringify(withSymlink)).not.toContain('OUTSIDE_WALK_SECRET');
    expect(withSymlink.fingerprint).not.toBe(clean.fingerprint);
  });

  it('S3: records overflow markers in entries and fingerprint when walk depth, file count, or total byte cap is exceeded', async () => {
    expect(MAX_AGENT_CONFIG_WALK_DEPTH).toBe(4);
    expect(MAX_AGENT_CONFIG_FILES).toBe(256);
    expect(MAX_AGENT_CONFIG_TOTAL_BYTES).toBe(4 * 1024 * 1024);

    // 1. Depth overflow (> 4 nested directories beneath .claude/skills/)
    const depthRoot = await makeTempDir('schegent-ack-depth-');
    await fsp.mkdir(path.join(depthRoot, '.claude', 'skills', 'd1', 'd2', 'd3', 'd4', 'd5'), {
      recursive: true
    });
    await fsp.writeFile(
      path.join(depthRoot, '.claude', 'skills', 'd1', 'd2', 'd3', 'd4', 'd5', 'too-deep.md'),
      'deep',
      'utf8'
    );
    const depthResult = await scanRepoAgentConfig(depthRoot, 'claude');
    expect(depthResult.persistable).toBe(false);
    expect(depthResult.entries).toContainEqual({
      name: '.claude/skills/d1/d2/d3/d4/d5/',
      status: 'unreadable',
      unreadableReason: 'depth-limit-exceeded'
    });
    const emptyFp = (await scanRepoAgentConfig(await makeTempDir('schegent-ack-empty2-'), 'claude')).fingerprint;
    expect(depthResult.fingerprint).not.toBe(emptyFp);

    // 2. File count overflow
    const countRoot = await makeTempDir('schegent-ack-count-');
    await fsp.mkdir(path.join(countRoot, '.claude', 'skills'), { recursive: true });
    for (let i = 1; i <= 4; i += 1) {
      await fsp.writeFile(path.join(countRoot, '.claude', 'skills', `s${i}.md`), `skill ${i}`, 'utf8');
    }
    const countResult = await scanRepoAgentConfig(countRoot, 'claude', { maxFiles: 3 });
    expect(countResult.persistable).toBe(false);
    expect(countResult.entries.filter((e) => e.status === 'present')).toHaveLength(3);
    expect(countResult.entries).toContainEqual({
      name: '.claude/skills/s4.md',
      status: 'unreadable',
      unreadableReason: 'file-count-limit-exceeded'
    });

    // 3. Total bytes overflow
    const bytesRoot = await makeTempDir('schegent-ack-totalbytes-');
    await fsp.mkdir(path.join(bytesRoot, '.claude', 'skills'), { recursive: true });
    await fsp.writeFile(path.join(bytesRoot, '.claude', 'skills', 'a.md'), Buffer.alloc(60, 0x61));
    await fsp.writeFile(path.join(bytesRoot, '.claude', 'skills', 'b.md'), Buffer.alloc(60, 0x62));
    const bytesResult = await scanRepoAgentConfig(bytesRoot, 'claude', { maxTotalBytes: 100 });
    expect(bytesResult.persistable).toBe(false);
    expect(bytesResult.entries).toContainEqual({
      name: '.claude/skills/b.md',
      status: 'unreadable',
      unreadableReason: 'total-bytes-limit-exceeded'
    });
  });

  it('S3: hashes workspace-internal scripts referenced by Claude hook commands and ignores external/missing paths', async () => {
    const root = await makeTempDir('schegent-ack-hookscripts-');
    const outside = await makeTempDir('schegent-ack-hookoutside-');
    const outsideScript = path.join(outside, 'ext.sh');
    await fsp.writeFile(outsideScript, 'echo EXTERNAL_SECRET', 'utf8');

    await fsp.mkdir(path.join(root, '.claude'), { recursive: true });
    await fsp.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fsp.writeFile(path.join(root, 'scripts', 'guard.sh'), '#!/bin/sh\necho v1\n', 'utf8');
    await fsp.writeFile(path.join(root, 'scripts', 'check.mjs'), 'console.log("ok");\n', 'utf8');
    await fsp.writeFile(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'bash ./scripts/guard.sh --strict' },
                { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/check.mjs"' },
                { type: 'command', command: `sh ${outsideScript}` },
                { type: 'command', command: 'echo harmless-nonfile-token' }
              ]
            }
          ]
        }
      }),
      'utf8'
    );

    const first = await scanRepoAgentConfig(root, 'claude');
    expect(first.persistable).toBe(true);
    expect(first.entries.map((e) => e.name)).toEqual([
      '.claude/settings.json',
      'scripts/check.mjs',
      'scripts/guard.sh'
    ]);
    const guardEntry = first.entries.find((e) => e.name === 'scripts/guard.sh');
    expect(guardEntry).toMatchObject({ status: 'present', hookScript: true });
    expect(JSON.stringify(first)).not.toContain('EXTERNAL_SECRET');

    // Editing the hook script body changes the fingerprint even when settings.json is untouched.
    await fsp.writeFile(path.join(root, 'scripts', 'guard.sh'), '#!/bin/sh\necho v2\n', 'utf8');
    const second = await scanRepoAgentConfig(root, 'claude');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('S3: scans Agy workspace paths (.agents/skills, rules, workflows, AGENTS.md, GEMINI.md, .gemini/settings.json) and Codex paths', async () => {
    const root = await makeTempDir('schegent-ack-agy-codex-');
    await fsp.mkdir(path.join(root, '.agents', 'skills', 'deploy'), { recursive: true });
    await fsp.mkdir(path.join(root, '.agents', 'rules'), { recursive: true });
    await fsp.mkdir(path.join(root, '.agents', 'workflows'), { recursive: true });
    await fsp.mkdir(path.join(root, '.gemini'), { recursive: true });
    await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(root, 'AGENTS.md'), '# agents', 'utf8');
    await fsp.writeFile(path.join(root, 'GEMINI.md'), '# gemini', 'utf8');
    await fsp.writeFile(path.join(root, '.gemini', 'settings.json'), '{}', 'utf8');
    await fsp.writeFile(path.join(root, '.agents', 'skills', 'deploy', 'SKILL.md'), '# deploy', 'utf8');
    await fsp.writeFile(path.join(root, '.agents', 'rules', 'r1.md'), '# rule', 'utf8');
    await fsp.writeFile(path.join(root, '.agents', 'workflows', 'w1.md'), '# wf', 'utf8');
    await fsp.writeFile(path.join(root, '.codex', 'config.toml'), 'approval_policy = "never"\n', 'utf8');

    const agyRes = await scanRepoAgentConfig(root, 'agy');
    expect(agyRes.persistable).toBe(true);
    expect(agyRes.entries.map((e) => e.name)).toEqual([
      'AGENTS.md',
      'GEMINI.md',
      '.gemini/settings.json',
      '.agents/skills/deploy/SKILL.md',
      '.agents/rules/r1.md',
      '.agents/workflows/w1.md'
    ]);

    const codexRes = await scanRepoAgentConfig(root, 'codex');
    expect(codexRes.persistable).toBe(true);
    expect(codexRes.entries.map((e) => e.name)).toEqual([
      '.codex/config.toml',
      'AGENTS.md'
    ]);
  });
});
