/**
 * Principal review Finding 9 — unit tests for `assertFreshBuiltBridgeIdentity` verifying
 * artifact presence, SHA-256/byte integrity, source-tree freshness, commit pinning (including
 * rejecting `commit: 'unknown'`), `dist/extension.js`, and `checkWebview` output verification.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFreshBuiltBridgeIdentity } from '../../helpers/verify-built-bridge';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFixtureRepo(tempDirs: string[]): { readonly root: string; readonly head: string } {
  const root = mkdtempSync(join(tmpdir(), 'schegent-bridge-id-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'webview-ui/src'), { recursive: true });
  mkdirSync(join(root, 'dist/module-graph'), { recursive: true });
  mkdirSync(join(root, 'dist/webview'), { recursive: true });

  writeFileSync(join(root, 'src/extension.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(root, 'webview-ui/src/main.ts'), 'export const y = 1;\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const bridgeBuf = Buffer.from('// bridge bundle\n', 'utf8');
  const extBuf = Buffer.from('// ext bundle\n', 'utf8');
  const webBuf = Buffer.from('// webview bundle\n', 'utf8');
  writeFileSync(join(root, 'dist/acp-stdio-bridge.js'), bridgeBuf);
  writeFileSync(join(root, 'dist/extension.js'), extBuf);
  writeFileSync(join(root, 'dist/webview/app.js'), webBuf);

  const future = new Date(Date.now() + 5_000);
  utimesSync(join(root, 'dist/acp-stdio-bridge.js'), future, future);
  utimesSync(join(root, 'dist/extension.js'), future, future);
  utimesSync(join(root, 'dist/webview/app.js'), future, future);

  writeFileSync(
    join(root, 'dist/module-graph/host.json'),
    JSON.stringify({
      build: { commit: head, dirty: false, mode: 'development' },
      outputs: [
        { file: 'dist/extension.js', bytes: extBuf.length, sha256: sha256(extBuf) },
        { file: 'dist/acp-stdio-bridge.js', bytes: bridgeBuf.length, sha256: sha256(bridgeBuf) }
      ]
    }),
    'utf8'
  );
  writeFileSync(
    join(root, 'dist/module-graph/webview.json'),
    JSON.stringify({
      build: { commit: head, dirty: false, mode: 'production' },
      outputs: [{ file: 'dist/webview/app.js', bytes: webBuf.length, sha256: sha256(webBuf) }]
    }),
    'utf8'
  );

  return { root, head };
}

describe('assertFreshBuiltBridgeIdentity (Finding 9)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when bridge, extension, and webview outputs match module graphs, HEAD, and source freshness', () => {
    const { root, head } = makeFixtureRepo(tempDirs);
    const verified = assertFreshBuiltBridgeIdentity(root, { checkWebview: true });
    expect(verified.hostCommit).toBe(head);
    expect(verified.bridgeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects commit: "unknown" in host.json inside a git checkout', () => {
    const { root } = makeFixtureRepo(tempDirs);
    const hostGraphPath = join(root, 'dist/module-graph/host.json');
    const parsed = JSON.parse(
      execFileSync('cat', [hostGraphPath], { encoding: 'utf8' })
    ) as { build: { commit: string } };
    parsed.build.commit = 'unknown';
    writeFileSync(hostGraphPath, JSON.stringify(parsed), 'utf8');
    expect(() => assertFreshBuiltBridgeIdentity(root)).toThrow(/built for commit unknown/);
  });

  it('rejects uncommitted source edits newer than built artifacts at the same HEAD', () => {
    const { root } = makeFixtureRepo(tempDirs);
    const newer = new Date(Date.now() + 20_000);
    utimesSync(join(root, 'src/extension.ts'), newer, newer);
    expect(() => assertFreshBuiltBridgeIdentity(root)).toThrow(/older than/);
  });

  it('rejects tampered dist/extension.js or tampered dist/webview/app.js under checkWebview', () => {
    const { root } = makeFixtureRepo(tempDirs);
    writeFileSync(join(root, 'dist/webview/app.js'), '// tampered webview\n', 'utf8');
    expect(() => assertFreshBuiltBridgeIdentity(root, { checkWebview: true })).toThrow(
      /dist\/webview\/app\.js/
    );

    writeFileSync(join(root, 'dist/extension.js'), '// tampered ext\n', 'utf8');
    expect(() => assertFreshBuiltBridgeIdentity(root)).toThrow(/dist\/extension\.js/);
  });
});
