import { describe, expect, it } from 'vitest';

import { plausiblePackagedNames } from './authored-boundaries';
import { archive, type ArchiveEntry } from './vsix-archive-fixture';

/**
 * FR-R4-F09 (FR-012; contract AC2; research R8; test T5) -- the SBOM in the archive came from the
 * build beside it.
 *
 * The SBOM is packaged INSIDE the VSIX so a recipient holding one file has it. Nothing used to tie
 * that document to the code next to it: a stale SBOM from an earlier build, or one regenerated
 * after the bundle changed, packaged without complaint. `assertSbomMatchesArchive` closes that by
 * comparing the SBOM's shipped-file components, each with its SHA-256, with the `extension/dist/`
 * entries of the archive: same file set, same digests, and a build identity present and shaped.
 *
 * Archives are assembled with the shared byte-level builder, so every byte is chosen here. The
 * agreeing archive is the control: each failure below changes exactly one thing in it and must
 * name that thing, and none of them changes anything the allowlist reads, because the allowlist is
 * a different check.
 */
async function loadPolicy() {
  return import('../../../scripts/check-vsix-smoke.mjs');
}
async function loadDigest() {
  return import('../../../scripts/release-digest.mjs');
}

const SBOM_ENTRY = 'extension/schegent-sbom.cdx.json';
const LABEL = 'candidate.vsix';
const COMMIT = 'e'.repeat(40);
const DIST_PREFIX = 'extension/dist/';

type SbomShape = {
  components: Array<{
    type: string;
    name: string;
    hashes: Array<{ alg: string; content: string }>;
  }>;
  metadata: { properties: Array<{ name: string; value: string }> };
};

/** An archive whose SBOM lists every `extension/dist/` entry with the digest of its bytes. */
async function agreeing(): Promise<{ entries: ArchiveEntry[]; sbom: SbomShape }> {
  const { sha256Hex } = await loadDigest();
  const names = await plausiblePackagedNames();
  const entries: ArchiveEntry[] = names.map((name) => ({
    name,
    data: name.startsWith(DIST_PREFIX) ? Buffer.from(`bytes of ${name}`, 'utf8') : Buffer.alloc(0)
  }));
  const sbom: SbomShape = {
    components: entries
      .filter((entry) => entry.name.startsWith(DIST_PREFIX))
      .map((entry) => ({
        type: 'file',
        name: entry.name.slice('extension/'.length),
        hashes: [{ alg: 'SHA-256', content: sha256Hex(entry.data) }]
      })),
    metadata: {
      properties: [
        { name: 'schegent:build.commit', value: COMMIT },
        { name: 'schegent:build.dirty', value: 'false' },
        { name: 'schegent:build.mode', value: 'development' }
      ]
    }
  };
  return { entries, sbom };
}

/** The archive with its SBOM entry set to `sbomText`, or removed when `null`. */
function build(entries: ArchiveEntry[], sbomText: string | null): Buffer {
  const withSbom = entries
    .filter((entry) => entry.name !== SBOM_ENTRY)
    .concat(sbomText === null ? [] : [{ name: SBOM_ENTRY, data: Buffer.from(sbomText, 'utf8') }]);
  return archive(withSbom);
}

describe('assertSbomMatchesArchive', () => {
  it('accepts an archive whose SBOM lists exactly its dist files with their digests', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries, sbom } = await agreeing();
    expect(() => assertSbomMatchesArchive(build(entries, JSON.stringify(sbom)), LABEL)).not.toThrow();
    // The control the failures below depend on: the archive really does hold dist files.
    expect(sbom.components.length).toBeGreaterThan(5);
  });

  it('accepts an unknown build commit, which the release path refuses on its own', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries, sbom } = await agreeing();
    const unknown = {
      ...sbom,
      metadata: {
        properties: sbom.metadata.properties.map((entry) =>
          entry.name === 'schegent:build.commit' ? { ...entry, value: 'unknown' } : entry
        )
      }
    };
    expect(() => assertSbomMatchesArchive(build(entries, JSON.stringify(unknown)), LABEL)).not.toThrow();
  });

  it('names an extra dist file the SBOM does not list', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries, sbom } = await agreeing();
    const extra: ArchiveEntry = {
      name: 'extension/dist/webview/chunks/smuggled.js',
      data: Buffer.from('not in the SBOM')
    };
    expect(() =>
      assertSbomMatchesArchive(build([...entries, extra], JSON.stringify(sbom)), LABEL)
    ).toThrow(/\[policy\].*dist\/webview\/chunks\/smuggled\.js/s);
  });

  it('names a dist file the SBOM lists and the archive lacks', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries, sbom } = await agreeing();
    const without = entries.filter((entry) => entry.name !== 'extension/dist/extension.js');
    expect(() => assertSbomMatchesArchive(build(without, JSON.stringify(sbom)), LABEL)).toThrow(
      /\[policy\].*dist\/extension\.js/s
    );
  });

  it('names a file whose bytes differ from the digest the SBOM records', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries, sbom } = await agreeing();
    const changed = entries.map((entry) =>
      entry.name === 'extension/dist/extension.js'
        ? { ...entry, data: Buffer.from('rebuilt after the SBOM was written') }
        : entry
    );
    expect(() => assertSbomMatchesArchive(build(changed, JSON.stringify(sbom)), LABEL)).toThrow(
      /\[policy\].*dist\/extension\.js.*SHA-256|\[policy\].*SHA-256.*dist\/extension\.js/s
    );
  });

  it('refuses an archive with no SBOM entry, naming it', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries } = await agreeing();
    expect(() => assertSbomMatchesArchive(build(entries, null), LABEL)).toThrow(
      /\[policy\].*extension\/schegent-sbom\.cdx\.json/s
    );
  });

  it('refuses an SBOM that is not JSON', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries } = await agreeing();
    expect(() => assertSbomMatchesArchive(build(entries, 'this is not json'), LABEL)).toThrow(
      /\[policy\].*extension\/schegent-sbom\.cdx\.json.*JSON/s
    );
  });

  it.each(['schegent:build.commit', 'schegent:build.dirty', 'schegent:build.mode'])(
    'refuses an SBOM missing the build property %s, naming it',
    async (missing) => {
      const { assertSbomMatchesArchive } = await loadPolicy();
      const { entries, sbom } = await agreeing();
      const trimmed = {
        ...sbom,
        metadata: { properties: sbom.metadata.properties.filter((entry) => entry.name !== missing) }
      };
      expect(() => assertSbomMatchesArchive(build(entries, JSON.stringify(trimmed)), LABEL)).toThrow(
        new RegExp(`\\[policy\\].*${missing.replace('.', '\\.')}`, 's')
      );
    }
  );

  it.each(['abc1234', 'E'.repeat(40), 'e'.repeat(39), ''])(
    'refuses a build commit that is neither 40 lowercase hex nor unknown (%j)',
    async (commit) => {
      const { assertSbomMatchesArchive } = await loadPolicy();
      const { entries, sbom } = await agreeing();
      const bad = {
        ...sbom,
        metadata: {
          properties: sbom.metadata.properties.map((entry) =>
            entry.name === 'schegent:build.commit' ? { ...entry, value: commit } : entry
          )
        }
      };
      expect(() => assertSbomMatchesArchive(build(entries, JSON.stringify(bad)), LABEL)).toThrow(
        /\[policy\].*schegent:build\.commit/s
      );
    }
  );

  it('carries the label of the archive in its message, as the other checks do', async () => {
    const { assertSbomMatchesArchive } = await loadPolicy();
    const { entries } = await agreeing();
    expect(() => assertSbomMatchesArchive(build(entries, null), 'my-candidate.vsix')).toThrow(
      /^my-candidate\.vsix: \[policy\]/
    );
  });
});
