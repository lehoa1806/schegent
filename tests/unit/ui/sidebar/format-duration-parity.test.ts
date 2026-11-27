import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SIDEBAR_IPC_SCHEMA_VERSION } from '../../../../src/contracts/sidebar-ipc';
import { SCHEMA_VERSION as HOST_SNAPSHOT_VERSION } from '../../../../src/contracts/generated/snapshot-types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOST_PATH = path.join(REPO_ROOT, 'src', 'ui', 'sidebar', 'duration.ts');
const WEBVIEW_PATH = path.join(REPO_ROOT, 'webview-ui', 'src', 'lib', 'format-duration.ts');

describe('formatDuration host/webview parity', () => {
  it('host duration.ts and webview format-duration.ts have byte-identical bodies', () => {
    const host = fs.readFileSync(HOST_PATH, 'utf8');
    const webview = fs.readFileSync(WEBVIEW_PATH, 'utf8');
    expect(host).toBe(webview);
  });
});

describe('generated sidebar IPC and snapshot versions (FR-R7-05)', () => {
  it('preserves the distinct envelope and body version values', async () => {
    const { SCHEMA_VERSION: webviewSnapshotVersion } = await import(
      '../../../../webview-ui/src/lib/generated/snapshot-mirror.js'
    );
    expect(SIDEBAR_IPC_SCHEMA_VERSION).toBe(3);
    expect(HOST_SNAPSHOT_VERSION).toBe(4);
    expect(webviewSnapshotVersion).toBe(HOST_SNAPSHOT_VERSION);
  });
});
