import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AGENT_CONFIG_FILE_BYTES,
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
});
