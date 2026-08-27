#!/usr/bin/env node
// FR-R3-120 (FR-014) — the manifest/tag agreement check.
//
// `RELEASE.md` said it plainly: "Nothing mechanically checks the tag against the
// manifest any more." That check lived in the tag job `FR-R3-099` retired with the
// rest of Actions. This restores it locally, which is where every release now
// happens.
//
// FOUR FILES, NOT ONE. `RELEASE.md` names the set itself — "the two manifest
// versions, and both lockfiles" — and a lockfile records its package tree's version
// in two places, so a partial `npm version` leaves a tree that builds and ships the
// wrong number.
//
// UNTAGGED COMMITS ARE STILL CHECKED. Restricting this to tagged commits would make
// it useless in a repository that tags for bookkeeping only, which RELEASE.md says
// this one does — and mutual disagreement is introduced on ordinary commits, not on
// the tag.
//
// IT REFUSES RATHER THAN WARNS, and reports EVERY disagreement rather than the
// first: four files, and a partial fix is a second failed release.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that carries this package tree's version. */
export const VERSION_SITES = [
  { path: 'package.json', read: (j) => j.version },
  { path: 'package-lock.json', read: (j) => j.version },
  { path: 'package-lock.json', read: (j) => j.packages?.['']?.version, label: 'package-lock.json (packages[""])' },
  { path: 'webview-ui/package.json', read: (j) => j.version },
  { path: 'webview-ui/package-lock.json', read: (j) => j.version },
  {
    path: 'webview-ui/package-lock.json',
    read: (j) => j.packages?.['']?.version,
    label: 'webview-ui/package-lock.json (packages[""])'
  }
];

function readVersions(root = REPO_ROOT) {
  return VERSION_SITES.map((site) => {
    const label = site.label ?? site.path;
    let version;
    try {
      version = site.read(JSON.parse(readFileSync(resolve(root, site.path), 'utf8')));
    } catch (error) {
      return { label, version: undefined, error: error instanceof Error ? error.message : 'unreadable' };
    }
    return { label, version };
  });
}

/** `v*` tags pointing at HEAD. Absent git, or no tags, is not a failure. */
function tagsAtHead(root = REPO_ROOT) {
  try {
    return execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^v\d/.test(line));
  } catch {
    return [];
  }
}

export function decideManifestVersions({ sites, tags }) {
  const problems = [];

  const missing = sites.filter((s) => typeof s.version !== 'string' || s.version.length === 0);
  for (const site of missing) {
    problems.push(`${site.label}: no version found${site.error ? ` (${site.error})` : ''}`);
  }

  const present = sites.filter((s) => typeof s.version === 'string' && s.version.length > 0);
  const distinct = [...new Set(present.map((s) => s.version))];

  if (distinct.length > 1) {
    // Every disagreeing site, not the first.
    for (const site of present) problems.push(`${site.label}: ${site.version}`);
    return {
      ok: false,
      reason: 'manifests disagree',
      problems,
      detail: `${distinct.length} distinct versions across ${present.length} sites: ${distinct.join(', ')}`
    };
  }

  const agreed = distinct[0];

  if (tags.length > 1) {
    const distinctTags = [...new Set(tags)];
    if (distinctTags.length > 1) {
      // Ambiguous. A release must not pick one.
      return {
        ok: false,
        reason: 'ambiguous tags',
        problems: distinctTags.map((t) => `tag ${t}`),
        detail: `HEAD carries ${distinctTags.length} disagreeing v* tags; a release must not choose between them`
      };
    }
  }

  if (tags.length >= 1 && agreed !== undefined) {
    const tagVersion = tags[0].replace(/^v/, '');
    if (tagVersion !== agreed) {
      return {
        ok: false,
        reason: 'tag disagrees with manifests',
        problems: [`tag ${tags[0]} (${tagVersion})`, `manifests ${agreed}`],
        detail: `the tag on HEAD names ${tagVersion}; every manifest says ${agreed}`
      };
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: 'unreadable manifest', problems, detail: 'a version site could not be read' };
  }

  return {
    ok: true,
    version: agreed,
    tagged: tags.length === 1 ? tags[0] : null
  };
}

export function checkManifestVersions(root = REPO_ROOT) {
  return decideManifestVersions({ sites: readVersions(root), tags: tagsAtHead(root) });
}

function main() {
  const result = checkManifestVersions();
  if (result.ok) {
    console.log(
      `Manifest version check: ${VERSION_SITES.length} sites agree at ${result.version}` +
        `${result.tagged ? `, matching tag ${result.tagged}` : ', no v* tag on HEAD'}.`
    );
    return;
  }
  console.error(`Manifest version check FAILED — ${result.reason}.`);
  console.error(`  ${result.detail}`);
  for (const problem of result.problems) console.error(`    ${problem}`);
  console.error(
    '\n  A release must not ship a tree whose manifests disagree about what it is.\n' +
      '  `npm version <v> --workspaces-update=false` in each tree updates a manifest and its\n' +
      '  lockfile together; a partial bump is what this check exists to catch.'
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
