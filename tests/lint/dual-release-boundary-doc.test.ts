import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const PLAN_PATH = path.join(WORKSPACE_ROOT, 'docs', 'plans', 'dual-release-host-abstraction.md');
const PRD_PATH = path.join(WORKSPACE_ROOT, 'docs', 'features', '064-dual-release-host-abstraction.md');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function expectHeading(markdown: string, heading: string): void {
  expect(markdown).toContain(`## ${heading}`);
}

describe.skip('dual release boundary documentation', () => {
  it('keeps the release-boundary guide sections required by the PRD', () => {
    const doc = read(PLAN_PATH);
    for (const heading of [
      'Release Surfaces',
      'Boundary Categories',
      'Shared Contract Inventory',
      'Extension Preservation',
      'Verification Gates',
      'Future Feature Decision Guide',
      'Desktop Prototype Path',
      'Production Desktop Parity Checklist',
      'Shared Engine Convergence'
    ]) {
      expectHeading(doc, heading);
    }
  });

  it('covers all boundary categories', () => {
    const doc = read(PLAN_PATH);
    for (const category of [
      'Shared Behavior',
      'VS Code Shell Behavior',
      'Desktop Shell Behavior',
      'Adapter Behavior'
    ]) {
      expect(doc).toContain(category);
    }
  });

  it('covers required shared contract families', () => {
    const doc = read(PLAN_PATH);
    for (const family of [
      'Webview commands',
      'Command acknowledgements',
      'Host push messages',
      'State snapshots',
      'Queue records',
      'Workflow run records',
      'Settings records',
      'Audit events',
      'Backend runner requests',
      'Phase logs',
      'WakeUp settings/logs',
      'Workspace root selection',
      'Notifications/file reveal'
    ]) {
      expect(doc).toContain(family);
    }
  });

  it('pins extension compatibility and no manual migration for this feature', () => {
    const doc = read(PLAN_PATH);
    expect(doc).toContain('No persisted workspace-state shape is changed.');
    expect(doc).toContain('No audit event shape is changed.');
    expect(doc).toContain('No manual operator migration is required.');
  });

  it('links the PRD to the release-boundary guide', () => {
    const prd = read(PRD_PATH);
    expect(prd).toContain('docs/plans/dual-release-host-abstraction.md');
  });
});
