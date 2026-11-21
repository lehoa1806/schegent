import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AGENT_CONFIG_FILE_BYTES,
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

    const result = await scanRepoAgentConfig(root, 'claude');
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

    const result = await scanRepoAgentConfig(root, 'claude', {
      timeoutMs: 25,
      scanPath: async (_ws, relPath) => {
        calls.push(relPath);
        await delayed;
        return { name: relPath, status: 'present', size: 1, digest: 'a'.repeat(64) };
      }
    });

    // Release delayed promise after timeout to confirm late completion does not mutate result.entries.
    resolveDelayed?.();
    await new Promise((r) => setTimeout(r, 15));

    expect(result.scanError).toBe(true);
    expect(result.scanErrorReason).toBe('timeout');
    expect(result.persistable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(calls).toHaveLength(1);
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

    const result = await scanRepoAgentConfig(root, 'claude', {
      timeoutMs: 25,
      scanPath: (_ws, relPath, maxBytes, signal) => {
        observedSignal = signal;
        return scanOpenedHandle(relPath, stalledHandle, maxBytes, signal);
      }
    });

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
});
