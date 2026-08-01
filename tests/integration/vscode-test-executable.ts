import * as fs from 'fs';
import * as path from 'path';

const COMPLETE_MARKER = 'is-complete';

/**
 * Resolve the executable produced by @vscode/test-electron. VS Code 1.131+
 * macOS archives name the binary `Code`, while test-electron 2.5 reports the
 * historical `Electron` path.
 */
export function resolveDownloadedExecutable(reportedPath: string): string | null {
  const candidates = [reportedPath];
  if (process.platform === 'darwin' && path.basename(reportedPath) === 'Electron') {
    candidates.push(path.join(path.dirname(reportedPath), 'Code'));
  }
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next known executable layout.
    }
  }
  return null;
}

/** Find the nearest test-electron completion marker for cache invalidation. */
export function findCompletionMarker(reportedPath: string): string | null {
  let current = path.dirname(reportedPath);
  for (let depth = 0; depth < 8; depth++) {
    const marker = path.join(current, COMPLETE_MARKER);
    if (fs.existsSync(marker)) return marker;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
