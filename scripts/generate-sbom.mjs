#!/usr/bin/env node
// FR-R3-120 (FR-013) — the SBOM, generated from the lockfiles, with no dependency.
//
// WHY THERE IS NO GENERATOR HERE. `repo/package.json` declares no `dependencies`
// key at all — not an empty one, absent. The extension ships zero runtime
// dependencies, which is the single strongest thing this document says. Pulling in
// a CycloneDX generator to enumerate that would add the only supply-chain surface
// the SBOM exists to describe, so the script is written out instead. It is short
// because the answer is short.
//
// WHY IT SHIPS AT ALL, given the private-to-author posture. Evidence that is free to
// produce should be produced before it is needed, not when — see
// docs/architecture/distribution-posture.md. It is written beside the VSIX and
// packaged INSIDE it, because a recipient is handed one file and an SBOM on the
// builder's disk describes the artifact to nobody.
//
// WHAT IT ASSERTS, and the limit is in the document itself: it reports what the
// lockfiles record. It has not opened the VSIX, and it does not claim to have.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_BASENAME = 'schegent-sbom.cdx.json';

/** The lockfiles that describe what is installed to build and run this extension. */
const LOCKFILES = [
  { path: 'package-lock.json', scope: 'host' },
  { path: 'webview-ui/package-lock.json', scope: 'webview' }
];

function readJson(relative) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relative), 'utf8'));
}

/** A CycloneDX package URL for an npm component. */
function purlFor(name, version) {
  // Scoped names carry a `/` that must survive as a namespace separator; every
  // other character is percent-encoded by `encodeURIComponent`.
  const encoded = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function licensesFor(entry) {
  const raw = entry.license;
  if (typeof raw === 'string' && raw.length > 0) return [{ license: { id: raw } }];
  if (Array.isArray(raw)) {
    const ids = raw.filter((value) => typeof value === 'string' && value.length > 0);
    if (ids.length > 0) return ids.map((id) => ({ license: { id } }));
  }
  return undefined;
}

function collectComponents() {
  const byKey = new Map();
  for (const { path, scope } of LOCKFILES) {
    const lock = readJson(path);
    const packages = lock.packages ?? {};
    for (const [location, entry] of Object.entries(packages)) {
      // '' is the root package of that lockfile, described by metadata instead.
      if (location === '') continue;
      const name = entry.name ?? location.split('node_modules/').pop();
      const version = entry.version;
      if (typeof name !== 'string' || typeof version !== 'string') continue;
      const key = `${name}@${version}`;
      if (byKey.has(key)) {
        // Present in both trees. Record that rather than dropping one.
        const existing = byKey.get(key);
        if (!existing.properties.some((p) => p.value === scope)) {
          existing.properties.push({ name: 'schegent:tree', value: scope });
        }
        continue;
      }
      const licenses = licensesFor(entry);
      byKey.set(key, {
        type: 'library',
        name,
        version,
        purl: purlFor(name, version),
        scope: entry.dev === true ? 'excluded' : 'required',
        properties: [{ name: 'schegent:tree', value: scope }],
        ...(licenses ? { licenses } : {})
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
  );
}

function build(timestamp) {
  const pkg = readJson('package.json');
  const runtimeDependencies = Object.keys(pkg.dependencies ?? {});
  const components = collectComponents();

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp,
      component: {
        type: 'application',
        name: pkg.name,
        version: pkg.version,
        purl: purlFor(pkg.name, pkg.version),
        ...(typeof pkg.license === 'string' ? { licenses: [{ license: { id: pkg.license } }] } : {})
      },
      properties: [
        // The headline, stated rather than left to be inferred from an absence.
        {
          name: 'schegent:runtimeDependencyCount',
          value: String(runtimeDependencies.length)
        },
        {
          name: 'schegent:runtimeDependencies',
          value: runtimeDependencies.length === 0 ? '(none declared)' : runtimeDependencies.join(', ')
        },
        // FR-042 — what this document observed, and what it did not.
        {
          name: 'schegent:asserts',
          value:
            'What the two lockfiles record at generation time. Components marked ' +
            'scope=excluded are dev-tree entries that do not ship in the VSIX.'
        },
        {
          name: 'schegent:doesNotAssert',
          value:
            'The contents of the VSIX. This SBOM was generated from the lockfiles ' +
            'and has not opened the packaged archive; it is not a scan of the ' +
            'shipped bytes, and it carries no signature.'
        }
      ]
    },
    components
  };
}

function main() {
  const stamp = new Date().toISOString();
  const bom = build(stamp);
  const target = resolve(REPO_ROOT, OUTPUT_BASENAME);
  writeFileSync(target, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
  const runtime = bom.metadata.properties.find(
    (p) => p.name === 'schegent:runtimeDependencyCount'
  )?.value;
  console.log(
    `SBOM: ${OUTPUT_BASENAME} — ${bom.components.length} component(s) from ` +
      `${LOCKFILES.length} lockfile(s); ${runtime} declared runtime dependenc${runtime === '1' ? 'y' : 'ies'}.`
  );
}

main();
