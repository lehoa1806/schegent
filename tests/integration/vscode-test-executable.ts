import * as fs from 'fs';
import * as path from 'path';

const COMPLETE_MARKER = 'is-complete';
export const INTEGRATION_RESULT_DIR_ENV = 'SCHEGENT_INTEGRATION_RESULT_DIR';

/**
 * FR-R3-146 — the launch's private `--user-data-dir`, told to the host leg.
 *
 * A host test runs INSIDE the window under test, so it can see what the extension
 * host sees and nothing else. That is enough for almost everything, and not enough
 * for one claim this repository makes in several places: that
 * `ConfigurationTarget.Global` writes to the profile's User settings. What the
 * unit suites assert is that the call was made with that target — an assertion
 * about an argument, which a `Workspace` target would also satisfy if the enum
 * member were wrong.
 *
 * The observable that separates them is the FILE VS Code writes, and its path is
 * derived from a flag only the launcher knows. So the launcher tells the host leg
 * where the profile is, and the host test reads `User/settings.json` off disk.
 *
 * Exported here rather than declared in the host module because `runPass` sets it
 * and the module reads it: one name, one file, no drift.
 */
export const INTEGRATION_USER_DATA_DIR_ENV = 'SCHEGENT_INTEGRATION_USER_DATA_DIR';

export interface IntegrationHostResult {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly executed: number;
  readonly failures: number;
}

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

/** Write one completion marker per extension host; duplicate hosts stay visible. */
export function writeIntegrationHostResult(result: IntegrationHostResult): void {
  const resultDirectory = process.env[INTEGRATION_RESULT_DIR_ENV];
  if (!resultDirectory) {
    throw new Error(`${INTEGRATION_RESULT_DIR_ENV} is required for integration tests`);
  }
  fs.writeFileSync(
    path.join(resultDirectory, `result-${process.pid}.json`),
    JSON.stringify(result),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
}

/** Fail unless exactly one host completed every discovered integration module. */
export function readSuccessfulIntegrationHostResult(
  resultDirectory: string
): IntegrationHostResult {
  const files = fs.readdirSync(resultDirectory).filter((name) =>
    /^result-\d+\.json$/.test(name)
  );
  if (files.length !== 1) {
    throw new Error(`expected exactly one integration host result, found ${files.length}`);
  }
  const raw = JSON.parse(
    fs.readFileSync(path.join(resultDirectory, files[0]), 'utf8')
  ) as Partial<IntegrationHostResult>;
  if (
    raw.schemaVersion !== 1 ||
    !Number.isSafeInteger(raw.pid) ||
    !Number.isSafeInteger(raw.executed) ||
    !Number.isSafeInteger(raw.failures) ||
    (raw.executed ?? 0) < 1 ||
    (raw.failures ?? -1) !== 0
  ) {
    throw new Error(`integration host reported an invalid or failing result: ${JSON.stringify(raw)}`);
  }
  return raw as IntegrationHostResult;
}
