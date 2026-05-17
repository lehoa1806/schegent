// Feature 014 — Publish the bundled headless runner + mirror config
// files into `<globalStorageUri>/wakeup/` for the OS scheduler to spawn.
//
// Layout written:
//   <homeDir>/runner.js                — copied from dist/wakeup-runner.js
//   <homeDir>/settings.json            — WakeUpSettings mirror (runner double-checks)
//   <homeDir>/workspace-roots.json     — { roots: string[] } (workspace defense)
//
// Atomic write semantics: each file is written to a sibling `.tmp.<pid>`
// path and rename()d into place. The runner reads the three files at
// fire time; partial-update windows are intolerable.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WakeUpSettings } from './settings';

export interface PublishOptions {
  readonly settings: WakeUpSettings;
  readonly workspaceRoots: readonly string[];
}

export interface PublishedBundle {
  readonly homeDir: string;
  readonly runnerPath: string;
  readonly settingsPath: string;
  readonly workspaceRootsPath: string;
}

/**
 * Publish the runner + mirrors. Idempotent for identical inputs.
 *
 * @param sourceRunnerPath  Absolute path to the bundled runner.js,
 *                          typically `<extensionPath>/dist/wakeup-runner.js`.
 * @param homeDir           Per-user home directory, typically
 *                          `<globalStorageUri>/wakeup`.
 */
export async function publishRunnerBundle(
  sourceRunnerPath: string,
  homeDir: string,
  opts: PublishOptions
): Promise<PublishedBundle> {
  await fs.mkdir(homeDir, { recursive: true });

  const runnerPath = path.join(homeDir, 'runner.js');
  const settingsPath = path.join(homeDir, 'settings.json');
  const workspaceRootsPath = path.join(homeDir, 'workspace-roots.json');

  await atomicCopy(sourceRunnerPath, runnerPath);
  await atomicWriteJSON(settingsPath, opts.settings);
  await atomicWriteJSON(workspaceRootsPath, { roots: [...opts.workspaceRoots] });

  return { homeDir, runnerPath, settingsPath, workspaceRootsPath };
}

async function atomicCopy(src: string, dst: string): Promise<void> {
  const tmp = `${dst}.tmp.${process.pid}`;
  await fs.copyFile(src, tmp);
  await fs.rename(tmp, dst);
}

async function atomicWriteJSON(filePath: string, body: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}
