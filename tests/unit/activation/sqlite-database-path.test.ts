// FR-R7-10 (closing review gap GC-26) — one SQLite operational store per folder, whichever way it is
// opened.
//
// WHAT THIS PINS:
//   - the canonical database lives under `globalStorageUri/sqlite/<scope>/schegent-state.db`, where
//     `<scope>` hashes the workspace root only (`deriveWorkspaceScopeId`);
//   - a folder opened directly, opened through a `.code-workspace` file (which VS Code assigns a
//     different `storageUri`), or opened with no `storageUri` at all resolves to the EXACT same
//     canonical database path;
//   - two distinct folders in the same editor profile resolve to distinct scoped database paths
//     under `globalStorageUri`.
//   - reintroducing `storageUri ?? globalStorageUri` breaks the direct-folder and two-way identity
//     assertions below.
import { describe, expect, it } from 'vitest';
import { deriveWorkspaceScopeId, sqliteDatabasePathFor } from '../../../src/activation/sqlite-cutover-wiring';

const WORKSPACE_ROOT = '/home/dev/project';
const OTHER_WORKSPACE_ROOT = '/home/dev/other-project';
const FOLDER_WINDOW_STORAGE = '/home/dev/.config/Code/User/workspaceStorage/1111aaaa/schegent.schegent';
const CODE_WORKSPACE_WINDOW_STORAGE = '/home/dev/.config/Code/User/workspaceStorage/2222bbbb/schegent.schegent';
const GLOBAL_STORAGE = '/home/dev/.config/Code/User/globalStorage/schegent.schegent';

describe('FR-R7-10 (GC-26) — one SQLite database per folder under globalStorageUri', () => {
  it('places the canonical database under globalStorageUri, scoped by the workspace root', () => {
    expect(
      sqliteDatabasePathFor({ storageUri: FOLDER_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE }, WORKSPACE_ROOT)
    ).toBe(`${GLOBAL_STORAGE}/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/schegent-state.db`);
  });

  it('uses the same canonical path when the window has no workspace storageUri', () => {
    expect(sqliteDatabasePathFor({ storageUri: undefined, globalStorageUri: GLOBAL_STORAGE }, WORKSPACE_ROOT)).toBe(
      `${GLOBAL_STORAGE}/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/schegent-state.db`
    );
  });

  it('gives one folder opened directly and through a .code-workspace the exact same database path', () => {
    const viaFolder = sqliteDatabasePathFor(
      { storageUri: FOLDER_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      WORKSPACE_ROOT
    );
    const viaCodeWorkspace = sqliteDatabasePathFor(
      { storageUri: CODE_WORKSPACE_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      WORKSPACE_ROOT
    );

    expect(viaFolder).toBe(viaCodeWorkspace);
    expect(viaFolder).toBe(`${GLOBAL_STORAGE}/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/schegent-state.db`);
  });

  it('isolates two distinct folders under globalStorageUri with distinct scope ids', () => {
    const first = sqliteDatabasePathFor(
      { storageUri: FOLDER_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      WORKSPACE_ROOT
    );
    const second = sqliteDatabasePathFor(
      { storageUri: CODE_WORKSPACE_WINDOW_STORAGE, globalStorageUri: GLOBAL_STORAGE },
      OTHER_WORKSPACE_ROOT
    );

    expect(first).not.toBe(second);
    expect(first).toContain(`/sqlite/${deriveWorkspaceScopeId(WORKSPACE_ROOT)}/`);
    expect(second).toContain(`/sqlite/${deriveWorkspaceScopeId(OTHER_WORKSPACE_ROOT)}/`);
  });
});
