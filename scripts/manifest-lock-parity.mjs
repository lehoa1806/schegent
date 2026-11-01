// FR-R4-F09 (FR-023, FR-024; contract DP1; research R18) -- does a lockfile's root entry say what
// its manifest declares?
//
// npm writes the manifest's declared ranges into the lock's root entry (`packages[""]`), so the
// two must list the same names with the same ranges, as exact strings. When they do not, a
// declaration was edited without the lock being regenerated, and the lock no longer records what
// the manifest asks for. That is how `FR-R3-109` left two declared packages out of the lock root:
// both were already resolved in the tree as transitives, so the install worked and nothing
// complained, which is the point of a parity check and the reason it is a gate.
//
// PURE. It reads two parsed objects and returns every disagreement; the gate
// (`tests/lint/manifest-lock-parity.test.ts`) reads the files, for both trees. It compares ranges
// as written and does not interpret them: `1.0.0` and `=1.0.0` mean the same and are still
// different text, and the lock root would have been written from the manifest's own.

/** The two fields npm records in a lock root, in the order the results list them. */
const FIELDS = Object.freeze(['dependencies', 'devDependencies']);

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every place the manifest and the lock root disagree, sorted by field then package. An empty
 * list means parity. A manifest or lock root with no such field lists none.
 *
 * @param {{ tree: 'root' | 'webview-ui', manifest: object, lock: object }} input
 * @returns {Array<{ tree: string, field: string, package: string,
 *   kind: 'missing-from-lock' | 'extra-in-lock' | 'range-differs',
 *   manifestRange?: string, lockRange?: string }>}
 */
export function manifestLockParity({ tree, manifest, lock }) {
  const lockRoot = lock?.packages?.[''] ?? {};
  const disagreements = [];
  for (const field of FIELDS) {
    const declared = manifest?.[field] ?? {};
    const locked = lockRoot[field] ?? {};
    const names = [...new Set([...Object.keys(declared), ...Object.keys(locked)])].sort(byCodeUnit);
    for (const name of names) {
      const inManifest = Object.hasOwn(declared, name);
      const inLock = Object.hasOwn(locked, name);
      if (inManifest && !inLock) {
        disagreements.push({ tree, field, package: name, kind: 'missing-from-lock', manifestRange: declared[name] });
      } else if (!inManifest && inLock) {
        disagreements.push({ tree, field, package: name, kind: 'extra-in-lock', lockRange: locked[name] });
      } else if (declared[name] !== locked[name]) {
        disagreements.push({
          tree,
          field,
          package: name,
          kind: 'range-differs',
          manifestRange: declared[name],
          lockRange: locked[name]
        });
      }
    }
  }
  return disagreements;
}
