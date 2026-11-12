// Review gap GC-26 (2026-11-12) — which SQLite database a window opens, and what that means for one
// folder opened two ways.
//
// WHAT THIS PINS:
//   - the database lives under the window's `storageUri` (or `globalStorageUri` when the window has
//     none), in `sqlite/<scope>/schegent-state.db`, where `<scope>` hashes the workspace root only;
//   - VS Code keys `storageUri` by workspace identity, so a folder opened directly and the same folder
//     opened through a `.code-workspace` get two storage directories and therefore two databases with
//     the SAME scope id. The primacy fence lives in `<root>/.schegent/ownership` and records no storage
//     identity, so the two windows contend for one fence (never primary together) while each reads its
//     own store when used one after the other. This test states that split; it does not endorse it.
//     `docs/reference/file-layout.md` documents it for operators.
import { describe, expect, it } from 'vitest';
import { deriveWorkspaceScopeId, sqliteDatabasePathFor } from '../../../src/activation/sqlite-cutover-wiring';

const WORKSPACE_ROOT = '/home/dev/project';
const FOLDER_WINDOW_STORAGE = '/home/dev/.config/Code/User/workspaceStorage/1111aaaa/schegent.schegent';
const CODE_WORKSPACE_WINDOW_STORAGE = '/home/dev/.config/Code/User/workspaceStorage/2222bbbb/schegent.schegent';
const GLOBAL_STORAGE = '/home/dev/.config/Code/User/globalStorage/schegent.schegent';

describe('GC-26 — the SQLite database follows the window storage, not the folder', () => {
  it('places the database under the window storageUri, scoped by the workspace root', () => {
    expect(
      sqliteDatabasePathFor({ storageUri: FOLDER_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE }, WORKSPACE_ROOT)
    ).toBe(`${FOLDER_WINDOW_STORAGE}/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/schegent-state.db`);
  });

  it('falls back to globalStorageUri when the window has no workspace storage', () => {
    expect(sqliteDatabasePathFor({ storageUri: undefined, globalStorageUri: GLOBAL_STORAGE }, WORKSPACE_ROOT)).toBe(
      `${GLOBAL_STORAGE}/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/schegent-state.db`
    );
  });

  it('gives one folder opened two ways two databases with the same scope id', () => {
    const viaFolder = sqliteDatabasePathFor(
      { storageUri: FOLDER_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      WORKSPACE_ROOT
    );
    const viaCodeWorkspace = sqliteDatabasePathFor(
      { storageUri: CODE_WORKSPACE_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      WORKSPACE_ROOT
    );

    expect(viaFolder).not.toBe(viaCodeWorkspace);
    const scope = `/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/`;
    expect(viaFolder).toContain(scope);
    expect(viaCodeWorkspace).toContain(scope);
  });
});
