import { describe, expect, it } from 'vitest';
import {
  ALL_AUDIT_EVENT_TYPES,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  WORKSPACE_LIFECYCLE_EVENT_TYPES,
  type MultiRootWarningShownPayload
} from '../../../src/contracts/audit-events';

describe('multi-root audit event registration (058, T003/T004)', () => {
  it('registers multi-root.warning-shown in WORKSPACE_LIFECYCLE_EVENT_TYPES', () => {
    expect([...WORKSPACE_LIFECYCLE_EVENT_TYPES]).toEqual(['multi-root.warning-shown']);
  });

  it('exposes multi-root.warning-shown via ALL_AUDIT_EVENT_TYPES', () => {
    expect(ALL_AUDIT_EVENT_TYPES).toContain('multi-root.warning-shown');
  });

  it('exposes multi-root.warning-shown via the KNOWN_AUDIT_EVENT_TYPE_SET', () => {
    expect(KNOWN_AUDIT_EVENT_TYPE_SET.has('multi-root.warning-shown')).toBe(true);
  });

  it('MultiRootWarningShownPayload accepts the expected primitive fields only', () => {
    const payload: MultiRootWarningShownPayload = {
      folderCount: 2,
      canonicalFolderName: 'repo-a'
    };
    expect(Object.keys(payload).sort()).toEqual(['canonicalFolderName', 'folderCount']);
  });
});
