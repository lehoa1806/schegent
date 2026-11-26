import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ModuleGraphOutput {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface ModuleGraphDoc {
  readonly build?: {
    readonly commit?: string;
    readonly dirty?: boolean;
    readonly mode?: string;
  };
  readonly outputs?: readonly ModuleGraphOutput[];
}

function readGitHead(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function readGraph(filePath: string): ModuleGraphDoc {
  if (!existsSync(filePath)) {
    throw new Error(`Missing build module graph at ${filePath} — run \`npm run build\` first.`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as ModuleGraphDoc;
}

/**
 * Verifies that `dist/acp-stdio-bridge.js` exists, matches the exact SHA-256 and byte length
 * recorded in `dist/module-graph/host.json`, and (when running inside a git checkout) that the
 * stamped build commit matches `HEAD`. When `checkWebview` is true, also verifies the webview
 * module graph commit matches `HEAD`.
 */
export function assertFreshBuiltBridgeIdentity(
  repoRoot: string,
  options: { readonly checkWebview?: boolean } = {}
): { readonly bridgeSha256: string; readonly hostCommit: string | null } {
  const bridgePath = resolve(repoRoot, 'dist/acp-stdio-bridge.js');
  if (!existsSync(bridgePath)) {
    throw new Error(`Missing built ACP bridge at ${bridgePath} — run \`npm run build:host\` first.`);
  }
  const hostGraph = readGraph(resolve(repoRoot, 'dist/module-graph/host.json'));
  const bridgeOutput = hostGraph.outputs?.find((entry) => entry.file === 'dist/acp-stdio-bridge.js');
  if (bridgeOutput === undefined) {
    throw new Error(
      'dist/module-graph/host.json does not record dist/acp-stdio-bridge.js — run `npm run build:host`.'
    );
  }
  const actualBytes = readFileSync(bridgePath);
  const actualSha256 = createHash('sha256').update(actualBytes).digest('hex');
  if (actualBytes.length !== bridgeOutput.bytes || actualSha256 !== bridgeOutput.sha256) {
    throw new Error(
      `dist/acp-stdio-bridge.js (${actualSha256}, ${actualBytes.length} B) does not match ` +
        `dist/module-graph/host.json (${bridgeOutput.sha256}, ${bridgeOutput.bytes} B) — run \`npm run build:host\`.`
    );
  }
  const gitHead = readGitHead(repoRoot);
  const hostCommit = typeof hostGraph.build?.commit === 'string' ? hostGraph.build.commit : null;
  if (gitHead !== null && hostCommit !== null && hostCommit !== 'unknown' && hostCommit !== gitHead) {
    throw new Error(
      `dist/module-graph/host.json was built for commit ${hostCommit}, but HEAD is ${gitHead} — run \`npm run build:host\`.`
    );
  }
  if (options.checkWebview === true) {
    const webviewGraph = readGraph(resolve(repoRoot, 'dist/module-graph/webview.json'));
    const webviewCommit =
      typeof webviewGraph.build?.commit === 'string' ? webviewGraph.build.commit : null;
    if (
      gitHead !== null &&
      webviewCommit !== null &&
      webviewCommit !== 'unknown' &&
      webviewCommit !== gitHead
    ) {
      throw new Error(
        `dist/module-graph/webview.json was built for commit ${webviewCommit}, but HEAD is ${gitHead} — run \`npm run build:webview\`.`
      );
    }
  }
  return { bridgeSha256: actualSha256, hostCommit };
}

