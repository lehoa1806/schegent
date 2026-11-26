import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

const SKIPPED_SOURCE_DIRS = new Set(['__tests__', 'node_modules', '.vite']);

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

function newestNonTestSource(dir: string): { readonly path: string; readonly mtimeMs: number } | null {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return { path: dir, mtimeMs: stats.mtimeMs };
  let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_SOURCE_DIRS.has(entry.name)) continue;
      const deeper = newestNonTestSource(join(dir, entry.name));
      if (deeper !== null && (newest === null || deeper.mtimeMs > newest.mtimeMs)) newest = deeper;
      continue;
    }
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    const full = join(dir, entry.name);
    const mtimeMs = statSync(full).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest;
}

function readGraph(filePath: string): ModuleGraphDoc {
  if (!existsSync(filePath)) {
    throw new Error(`Missing build module graph at ${filePath} — run \`npm run build\` first.`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as ModuleGraphDoc;
}

function verifyRecordedOutput(
  repoRoot: string,
  graphPath: string,
  output: ModuleGraphOutput,
  rebuildCommand: string
): { readonly sha256: string; readonly bytes: number; readonly mtimeMs: number } {
  const fullPath = resolve(repoRoot, output.file);
  if (!existsSync(fullPath)) {
    throw new Error(
      `Missing build artifact ${output.file} recorded in ${graphPath} — run \`${rebuildCommand}\` first.`
    );
  }
  const actualBytes = readFileSync(fullPath);
  const actualSha256 = createHash('sha256').update(actualBytes).digest('hex');
  if (actualBytes.length !== output.bytes || actualSha256 !== output.sha256) {
    throw new Error(
      `${output.file} (${actualSha256}, ${actualBytes.length} B) does not match ` +
        `${graphPath} (${output.sha256}, ${output.bytes} B) — run \`${rebuildCommand}\`.`
    );
  }
  return { sha256: actualSha256, bytes: actualBytes.length, mtimeMs: statSync(fullPath).mtimeMs };
}

/**
 * Verifies that `dist/acp-stdio-bridge.js` and `dist/extension.js` exist, match the exact SHA-256
 * and byte length recorded in `dist/module-graph/host.json`, are at least as fresh as `src/`, and
 * (inside a git checkout) that `host.json`'s stamped build commit is a valid SHA matching `HEAD`.
 * When `checkWebview` is true, also verifies `dist/module-graph/webview.json`'s commit, every
 * recorded webview output file digest/size, and `webview-ui/src/` source freshness.
 */
export function assertFreshBuiltBridgeIdentity(
  repoRoot: string,
  options: { readonly checkWebview?: boolean; readonly checkSourceFreshness?: boolean } = {}
): { readonly bridgeSha256: string; readonly hostCommit: string | null } {
  const hostGraphPath = resolve(repoRoot, 'dist/module-graph/host.json');
  const hostGraph = readGraph(hostGraphPath);
  const bridgeOutput = hostGraph.outputs?.find((entry) => entry.file === 'dist/acp-stdio-bridge.js');
  if (bridgeOutput === undefined) {
    throw new Error(
      'dist/module-graph/host.json does not record dist/acp-stdio-bridge.js — run `npm run build:host`.'
    );
  }
  const extensionOutput = hostGraph.outputs?.find((entry) => entry.file === 'dist/extension.js');
  if (extensionOutput === undefined) {
    throw new Error(
      'dist/module-graph/host.json does not record dist/extension.js — run `npm run build:host`.'
    );
  }

  const bridgeVerified = verifyRecordedOutput(
    repoRoot,
    'dist/module-graph/host.json',
    bridgeOutput,
    'npm run build:host'
  );
  const extensionVerified = verifyRecordedOutput(
    repoRoot,
    'dist/module-graph/host.json',
    extensionOutput,
    'npm run build:host'
  );

  const checkFreshness = options.checkSourceFreshness !== false;
  if (checkFreshness) {
    const newestSrc = newestNonTestSource(resolve(repoRoot, 'src'));
    const oldestHostOutMs = Math.min(bridgeVerified.mtimeMs, extensionVerified.mtimeMs);
    if (newestSrc !== null && oldestHostOutMs < newestSrc.mtimeMs) {
      throw new Error(
        `Built host artifacts are older than ${newestSrc.path} — run \`npm run build:host\` before running bridge tests.`
      );
    }
  }

  const gitHead = readGitHead(repoRoot);
  const hostCommit = typeof hostGraph.build?.commit === 'string' ? hostGraph.build.commit : null;
  if (gitHead !== null && (hostCommit === null || hostCommit === 'unknown' || hostCommit !== gitHead)) {
    throw new Error(
      `dist/module-graph/host.json was built for commit ${hostCommit ?? '<missing>'}, but HEAD is ${gitHead} — run \`npm run build:host\`.`
    );
  }

  if (options.checkWebview === true) {
    const webviewGraphPath = resolve(repoRoot, 'dist/module-graph/webview.json');
    const webviewGraph = readGraph(webviewGraphPath);
    const webviewCommit =
      typeof webviewGraph.build?.commit === 'string' ? webviewGraph.build.commit : null;
    if (
      gitHead !== null &&
      (webviewCommit === null || webviewCommit === 'unknown' || webviewCommit !== gitHead)
    ) {
      throw new Error(
        `dist/module-graph/webview.json was built for commit ${webviewCommit ?? '<missing>'}, but HEAD is ${gitHead} — run \`npm run build:webview\`.`
      );
    }
    const outputs = webviewGraph.outputs ?? [];
    if (outputs.length === 0) {
      throw new Error(
        'dist/module-graph/webview.json records zero outputs — run `npm run build:webview`.'
      );
    }
    let newestWebviewOutMs = 0;
    for (const entry of outputs) {
      const verified = verifyRecordedOutput(
        repoRoot,
        'dist/module-graph/webview.json',
        entry,
        'npm run build:webview'
      );
      if (verified.mtimeMs > newestWebviewOutMs) newestWebviewOutMs = verified.mtimeMs;
    }
    if (checkFreshness) {
      const newestWebviewSrc = newestNonTestSource(resolve(repoRoot, 'webview-ui/src'));
      if (newestWebviewSrc !== null && newestWebviewOutMs < newestWebviewSrc.mtimeMs) {
        throw new Error(
          `Built webview artifacts are older than ${newestWebviewSrc.path} — run \`npm run build:webview\`.`
        );
      }
    }
  }

  return { bridgeSha256: bridgeVerified.sha256, hostCommit };
}
