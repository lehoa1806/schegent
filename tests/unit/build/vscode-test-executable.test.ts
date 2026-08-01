import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  findCompletionMarker,
  readSuccessfulIntegrationHostResult,
  resolveDownloadedExecutable
} from '../../integration/vscode-test-executable';

describe('VS Code integration-test executable cache', () => {
  it('accepts the executable path reported by test-electron', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schegent-vscode-cache-'));
    const executable = join(dir, 'code');
    writeFileSync(executable, '');
    chmodSync(executable, 0o755);
    expect(resolveDownloadedExecutable(executable)).toBe(executable);
  });

  it.runIf(process.platform === 'darwin')('supports the macOS Code binary fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schegent-vscode-cache-'));
    const macos = join(dir, 'Visual Studio Code.app', 'Contents', 'MacOS');
    mkdirSync(macos, { recursive: true });
    const code = join(macos, 'Code');
    writeFileSync(code, '');
    chmodSync(code, 0o755);
    expect(resolveDownloadedExecutable(join(macos, 'Electron'))).toBe(code);
  });

  it('finds the nearest cache completion marker and rejects missing binaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schegent-vscode-cache-'));
    const nested = join(dir, 'App', 'Contents', 'MacOS');
    mkdirSync(nested, { recursive: true });
    const marker = join(dir, 'is-complete');
    writeFileSync(marker, '');
    const missing = join(nested, 'Electron');
    expect(resolveDownloadedExecutable(missing)).toBeNull();
    expect(findCompletionMarker(missing)).toBe(marker);
  });
});

describe('VS Code integration-test result authority', () => {
  it('accepts one successful host result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schegent-vscode-result-'));
    writeFileSync(
      join(dir, 'result-123.json'),
      JSON.stringify({ schemaVersion: 1, pid: 123, executed: 9, failures: 0 })
    );
    expect(readSuccessfulIntegrationHostResult(dir)).toMatchObject({
      executed: 9,
      failures: 0
    });
  });

  it('rejects missing, duplicate, and failing host results', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'schegent-vscode-result-'));
    expect(() => readSuccessfulIntegrationHostResult(missing)).toThrow(/found 0/);

    const duplicate = await mkdtemp(join(tmpdir(), 'schegent-vscode-result-'));
    for (const pid of [123, 456]) {
      writeFileSync(
        join(duplicate, `result-${pid}.json`),
        JSON.stringify({ schemaVersion: 1, pid, executed: 9, failures: 0 })
      );
    }
    expect(() => readSuccessfulIntegrationHostResult(duplicate)).toThrow(/found 2/);

    const failed = await mkdtemp(join(tmpdir(), 'schegent-vscode-result-'));
    writeFileSync(
      join(failed, 'result-789.json'),
      JSON.stringify({ schemaVersion: 1, pid: 789, executed: 9, failures: 1 })
    );
    expect(() => readSuccessfulIntegrationHostResult(failed)).toThrow(/failing result/);
  });
});
