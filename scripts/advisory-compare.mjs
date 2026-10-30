// Feature 249 (FR-R4-F21) — which commit is the base, and which class each advisory finding of a
// candidate lands in against it.
//
// PURE. `selectBase` is pure over a git seam and `compareTrees` over the captures, the two
// lockfiles and a blob seam, so every rule is testable without git, npm or the network. Compare
// makes no network call and needs no credential. The contract is
// `specs/249-dependency-advisory-baselines/contracts/comparison.md` and `data-model.md` in the
// workspace.
//
// NO ARBITRARY BASE. The default base is the merge-base of the candidate and `refs/heads/<target>`,
// and no other ref is ever asked for: no fallback to a remote-tracking branch, no pick among
// several merge-bases. A base that cannot be chosen is a reason, never a guess.
//
// ONE DECISION TABLE. A finding is grouped with the base and candidate findings of its package
// whose advisory identifier sets intersect, transitively, and each group lands in exactly one class
// by the first row of the table that matches. A matching identifier never by itself makes a group
// pre-existing: a new location or newly direct or production use is worse, and says so.
import {
  CLASSES,
  FRESHNESS_BUDGET_MS,
  PAIRING_BUDGET_MS,
  TREES,
  TREE_NAMES,
  byCodeUnit,
  checkCapture,
  compareFindings,
  highestSeverity,
  identifierSet,
  isObjectId,
  mergeIds,
  parseInstant,
  severityRank
} from './advisory-model.mjs';

/** The branch a candidate is compared against when none is named. */
const DEFAULT_TARGET = 'develop';

function notSelected(rule, target, detail) {
  return { commit: null, rule, target, reason: 'base-not-selected', detail };
}

function isRevision(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('-');
}

/**
 * Select the base commit of a candidate (K1). The default is the single merge-base with
 * `refs/heads/<target>`; an explicit `base` is taken as given. Every way of finding none is a
 * `base-not-selected` result naming its detail, with no commit.
 *
 * Operator input is refused before it can be read as an option: a candidate or target beginning
 * with `-` throws without calling git, a target git rewrites or rejects throws after one call, and
 * a `base` beginning with `-` is an unresolved base.
 *
 * @param {{ candidate: string, target?: string, base?: string }} request
 * @param {import('./advisory-compare.d.mts').GitSeam} git
 * @returns {import('./advisory-compare.d.mts').BaseSelection}
 */
export function selectBase({ candidate, target, base }, git) {
  if (!isRevision(candidate)) throw new TypeError('the candidate must be a revision, not an option');
  if (base !== undefined && target !== undefined) {
    throw new TypeError('--target and --base are mutually exclusive');
  }
  if (base !== undefined) {
    if (!isRevision(base)) return notSelected('explicit', null, 'base-unresolved');
    const resolved = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
    return isObjectId(resolved)
      ? { commit: resolved, rule: 'explicit', target: null }
      : notSelected('explicit', null, 'base-unresolved');
  }
  const name = target ?? DEFAULT_TARGET;
  if (!isRevision(name)) throw new TypeError('--target must be a branch name');
  // `--branch` expands forms such as `@{-1}` to the branch they name. Only a name git leaves
  // unchanged is one the operator wrote.
  if (git(['check-ref-format', '--branch', name]) !== name) {
    throw new TypeError('--target is not a usable branch name');
  }
  const ref = `refs/heads/${name}`;
  if (!isObjectId(git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]))) {
    return notSelected('merge-base', name, 'target-missing');
  }
  const output = git(['merge-base', '--all', candidate, ref]);
  const commits = (output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (commits.length > 1) return notSelected('merge-base', name, 'several-merge-bases');
  if (!isObjectId(commits[0])) return notSelected('merge-base', name, 'no-merge-base');
  return { commit: commits[0], rule: 'merge-base', target: name };
}

function pairKey(location, version) {
  return `${location}\u0000${version}`;
}

function bySide(side) {
  return (item) => item.side === side;
}

function byPair(a, b) {
  return byCodeUnit(a.location, b.location) || byCodeUnit(a.version, b.version);
}

/**
 * Every pair (location, version) the lockfile installs, for each package name, as the version at each
 * location. A location is a key of the lockfile's `packages`, so it holds one entry and one version,
 * and a pair is found by one lookup however many pairs a finding names.
 */
function lockfilePairs(lockfile) {
  const byPackage = new Map();
  const packages = lockfile?.packages;
  if (packages === null || typeof packages !== 'object') return byPackage;
  const marker = 'node_modules/';
  for (const [location, entry] of Object.entries(packages)) {
    if (location === '' || entry === null || typeof entry !== 'object') continue;
    if (typeof entry.version !== 'string') continue;
    const name =
      typeof entry.name === 'string' ? entry.name : location.slice(location.lastIndexOf(marker) + marker.length);
    if (!byPackage.has(name)) byPackage.set(name, new Map());
    byPackage.get(name).set(location, entry.version);
  }
  return byPackage;
}

/**
 * The findings of one side of a group as one: union of locations, highest known severity, usage as
 * the any of them, and the sorted union of dependents and notes. `null` when the side has none.
 */
function summarizeSide(findings) {
  if (findings.length === 0) return null;
  const pairs = new Map();
  for (const finding of findings) {
    for (const location of finding.locations) {
      pairs.set(pairKey(location.location, location.version), location);
    }
  }
  const locations = [...pairs.values()].sort(byPair);
  const ordered = [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      byCodeUnit(a.ids.canonical, b.ids.canonical)
  );
  return {
    locations,
    direct: findings.some((finding) => finding.direct),
    production: findings.some((finding) => finding.production),
    severity: highestSeverity(findings.map((finding) => finding.severity)),
    title: ordered[0].title,
    dependents: findings.flatMap((finding) => finding.dependents),
    notes: findings.flatMap((finding) => finding.notes)
  };
}

/**
 * Cluster the items of one package by transitive identifier-set intersection. An item joins every
 * earlier cluster that holds one of its identifiers, found through an index of identifiers and not by
 * comparing it with each earlier item, so the work is in proportion to the identifiers read and a
 * capture of many unrelated findings costs no more than its size. A capture is untrusted and its only
 * bound is its byte size.
 *
 * A cluster is headed by the item that last joined it. Clusters come out in the order their heads
 * were added, and each lists its head, then the clusters the head joined, in that order and each in
 * turn. `summarizeSide` breaks the ties of its sorts by that order, so it is part of the result.
 */
function clusterItems(items) {
  // `parent` links a cluster's earlier heads to its current head, with path compression; `joined`
  // keeps each head's children as they were first joined, which compression leaves alone.
  const parent = items.map((_, index) => index);
  const joined = items.map(() => []);
  const holder = new Map();
  const headOf = (index) => {
    let head = index;
    while (parent[head] !== head) head = parent[head];
    for (let node = index; node !== head; ) {
      const next = parent[node];
      parent[node] = head;
      node = next;
    }
    return head;
  };

  items.forEach((item, index) => {
    const identifiers = identifierSet(item.finding.ids);
    const touched = new Set();
    for (const identifier of identifiers) {
      if (holder.has(identifier)) touched.add(headOf(holder.get(identifier)));
    }
    for (const head of [...touched].sort((a, b) => a - b)) {
      parent[head] = index;
      joined[index].push(head);
    }
    for (const identifier of identifiers) holder.set(identifier, index);
  });

  const clusters = [];
  items.forEach((_, head) => {
    if (parent[head] !== head) return;
    // Preorder, with a stack of indexes: a chain of overlapping findings is as deep as it is long.
    const members = [];
    const pending = [head];
    while (pending.length > 0) {
      const index = pending.pop();
      members.push(items[index]);
      const children = joined[index];
      for (let child = children.length - 1; child >= 0; child -= 1) pending.push(children[child]);
    }
    clusters.push(members);
  });
  return clusters;
}

/** Group the findings of both sides by package, then by transitive identifier-set intersection. */
function groupFindings(baseFindings, candidateFindings) {
  const byPackage = new Map();
  const add = (side, finding) => {
    if (!byPackage.has(finding.package)) byPackage.set(finding.package, []);
    byPackage.get(finding.package).push({ side, finding });
  };
  for (const finding of baseFindings) add('base', finding);
  for (const finding of candidateFindings) add('candidate', finding);

  const groups = [];
  for (const [name, items] of byPackage) {
    for (const cluster of clusterItems(items)) {
      groups.push({
        package: name,
        base: cluster.filter(bySide('base')).map((member) => member.finding),
        candidate: cluster.filter(bySide('candidate')).map((member) => member.finding)
      });
    }
  }
  return groups;
}

function sideView(summary) {
  if (summary === null) return null;
  return { locations: summary.locations, direct: summary.direct, production: summary.production };
}

function reason(code, pairs) {
  return pairs === undefined ? { code } : { code, pairs };
}

/**
 * Both sides present: uncertain when only the severity moved over identical pairs (row 3), else
 * worsened by each cause, else pre-existing with the ways it narrowed (rows 5, 6).
 */
function classifyBoth(base, candidate) {
  const basePairs = new Set(base.locations.map((l) => pairKey(l.location, l.version)));
  const candidatePairs = new Set(candidate.locations.map((l) => pairKey(l.location, l.version)));
  const added = candidate.locations.filter((l) => !basePairs.has(pairKey(l.location, l.version)));
  const bothKnown = severityRank(base.severity) >= 0 && severityRank(candidate.severity) >= 0;

  // Row 3. The same pairs on both sides, so the lockfiles say the candidate changed nothing about
  // where the package is installed: a different or unknowable severity is the database's doing.
  const samePairs = basePairs.size === candidatePairs.size && added.length === 0;
  if (samePairs && (!bothKnown || base.severity !== candidate.severity)) {
    return {
      class: 'uncertain',
      reasons: [reason(bothKnown ? 'severity-revised' : 'severity-not-comparable')]
    };
  }

  const worsened = [];
  if (bothKnown && severityRank(candidate.severity) > severityRank(base.severity)) {
    worsened.push(reason('severity-raised'));
  }
  if (added.length > 0) {
    worsened.push(reason('new-pair', added.map((l) => ({ location: l.location, version: l.version }))));
  }
  if (candidate.direct && !base.direct) worsened.push(reason('newly-direct'));
  if (candidate.production && !base.production) worsened.push(reason('newly-production'));
  if (worsened.length > 0) {
    if (!bothKnown) worsened.push(reason('severity-not-comparable'));
    return { class: 'worsened', reasons: worsened };
  }

  const narrowed = [];
  if (bothKnown && severityRank(candidate.severity) < severityRank(base.severity)) {
    narrowed.push(reason('severity-lowered'));
  }
  if (base.locations.some((l) => !candidatePairs.has(pairKey(l.location, l.version)))) {
    narrowed.push(reason('fewer-pairs'));
  }
  if (base.direct && !candidate.direct) narrowed.push(reason('no-longer-direct'));
  if (base.production && !candidate.production) narrowed.push(reason('no-longer-production'));
  return { class: 'pre-existing', reasons: narrowed };
}

/**
 * The first matching row of the decision table, for one group (data-model §4). `lock` holds the
 * pairs each lockfile installs for the group's package, as the version at each location, which rows
 * 1, 2 and 4 read.
 */
function classifyGroup(base, candidate, lock) {
  if (base === null) {
    const inBase = candidate.locations.filter((l) => lock.base.get(l.location) === l.version);
    // Row 1: every pair was already installed on the base, so the finding is most likely an advisory
    // disclosed between the two observations, not something the candidate brought.
    if (inBase.length === candidate.locations.length) {
      return { class: 'uncertain', reasons: [reason('disclosed-between-captures')] };
    }
    // Row 4, with the overlap named when some, but not all, of the pairs were already installed.
    const reasons = [reason('new-on-candidate')];
    if (inBase.length > 0) {
      reasons.push(reason('partly-in-base-lockfile', inBase.map((l) => ({ location: l.location, version: l.version }))));
    }
    return { class: 'introduced', reasons };
  }
  if (candidate === null) {
    // Row 2: any of the finding's versions still installed at any of its locations on the
    // candidate means the advisory may simply have been withdrawn or revised, not fixed.
    const versions = new Set(base.locations.map((l) => l.version));
    const stillInstalled = base.locations.some((l) => versions.has(lock.candidate.get(l.location)));
    return stillInstalled
      ? { class: 'uncertain', reasons: [reason('still-installed-on-candidate')] }
      : { class: 'resolved', reasons: [reason('absent-on-candidate')] };
  }
  return classifyBoth(base, candidate);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(byCodeUnit);
}

/** One classified finding, in the contract's key order (K3). */
function classified(tree, group, base, candidate, decision, sides) {
  const ids = mergeIds([...group.base, ...group.candidate].map((finding) => finding.ids));
  return {
    class: decision.class,
    ...(sides === undefined ? {} : { sides }),
    tree,
    package: group.package,
    ids,
    severity: { base: base?.severity ?? null, candidate: candidate?.severity ?? null },
    base: sideView(base),
    candidate: sideView(candidate),
    reasons: [...decision.reasons].sort((a, b) => byCodeUnit(a.code, b.code)),
    notes: sortedUnique([...(base?.notes ?? []), ...(candidate?.notes ?? [])]),
    title: (candidate ?? base).title,
    dependents: sortedUnique([...(base?.dependents ?? []), ...(candidate?.dependents ?? [])]),
    disposition: { verdict: 'not-recorded', entries: [] }
  };
}

function classifyTree(tree, baseFindings, candidateFindings, lockfiles) {
  const installed = { base: lockfilePairs(lockfiles.base), candidate: lockfilePairs(lockfiles.candidate) };
  return groupFindings(baseFindings, candidateFindings)
    .map((group) => {
      const base = summarizeSide(group.base);
      const candidate = summarizeSide(group.candidate);
      const lock = {
        base: installed.base.get(group.package) ?? new Map(),
        candidate: installed.candidate.get(group.package) ?? new Map()
      };
      return classified(tree, group, base, candidate, classifyGroup(base, candidate, lock));
    })
    .sort(compareFindings);
}

function zeroTotals() {
  return Object.fromEntries(CLASSES.map((name) => [name, 0]));
}

function totalsOf(findings) {
  const totals = zeroTotals();
  for (const finding of findings) totals[finding.class] += 1;
  return totals;
}

/** A capture's subject and provenance, never its findings (K5). */
function provenanceOf(capture) {
  return {
    commit: capture.commit,
    objectFormat: capture.objectFormat,
    manifest: capture.manifest,
    lockfile: capture.lockfile,
    tool: capture.tool,
    toolVersion: capture.toolVersion,
    command: capture.command,
    registryHost: capture.registryHost,
    observedAt: capture.observedAt,
    reportFormat: capture.reportFormat,
    outcome: capture.outcome,
    limitations: capture.limitations
  };
}

/** The findings of an incomplete tree that could be read, each with the sides it was read from. */
function listNotDetermined(tree, baseFindings, candidateFindings) {
  return groupFindings(baseFindings, candidateFindings)
    .map((group) => {
      const sides = [group.base.length > 0 ? 'base' : null, group.candidate.length > 0 ? 'candidate' : null].filter(
        (side) => side !== null
      );
      const base = summarizeSide(group.base);
      const candidate = summarizeSide(group.candidate);
      return classified(tree, group, base, candidate, { class: 'not-determined', reasons: [] }, sides);
    })
    .sort(compareFindings);
}

function sideReason(code, side, detail) {
  return detail === undefined ? { code, side } : { code, side, detail };
}

/** The major version of a tool version, or the whole text when it does not start with a number. */
function majorOf(version) {
  const match = /^v?(\d+)/.exec(version);
  return match === null ? version : match[1];
}

/**
 * The capture's reason, if its subject is not the one this side names (K2 step 3). The tree, the
 * commit and both blob ids are compared with what git says at the side's commit; a path git does
 * not have there is `tree-missing`. When no base was selected there is no commit to compare with,
 * so the base side's subject is not checked.
 */
function subjectReasons(tree, side, capture, commit, blobAt) {
  if (commit === null) return [];
  const reasons = [];
  if (capture.tree !== tree) reasons.push(sideReason('mismatch', side, 'tree'));
  if (capture.commit !== commit) reasons.push(sideReason('mismatch', side, 'commit'));
  let absent = false;
  for (const file of ['manifest', 'lockfile']) {
    const expected = blobAt(commit, TREES[tree][file]);
    if (expected === null) absent = true;
    else if (capture[file].blob !== expected) reasons.push(sideReason('mismatch', side, file));
  }
  if (absent) reasons.push(sideReason('tree-missing', side));
  return reasons;
}

/** The reason a capture whose audit did not succeed gives (K2 step 4). */
function outcomeReason(side, outcome) {
  if (outcome.status === 'failed') return sideReason('audit-failure', side, outcome.reason);
  if (outcome.status === 'rejected') {
    return sideReason(outcome.reason, side, outcome.reason === 'over-bound' ? outcome.bound : undefined);
  }
  return null;
}

/** Freshness against the evaluation time (K2 step 5, R9): `[at - 24 h, at]`. */
function staleReason(side, capture, evaluatedMs) {
  const observed = parseInstant(capture.observedAt);
  if (observed > evaluatedMs) return sideReason('stale', side, 'observed-after-evaluation');
  if (observed < evaluatedMs - FRESHNESS_BUDGET_MS) return sideReason('stale', side, 'older-than-budget');
  return null;
}

/**
 * Check one capture, in K2's order, stopping at the first step it fails. `readable` is a capture that
 * parsed and has the contract's shape, so its provenance can be shown. `usable` is one that also
 * describes the right subject and succeeded: its findings can be listed and it is paired with the
 * other side, whether or not it is fresh.
 */
function inspectCapture({ tree, side, file, commit, blobAt, evaluatedMs }) {
  const missing = side === 'base' ? 'missing-baseline' : 'missing-candidate';
  const none = { reasons: [], capture: null, readable: false, usable: false };
  if (file === null || file === undefined) return { ...none, reasons: [sideReason(missing, side)] };
  if ('overBound' in file) return { ...none, reasons: [sideReason('over-bound', side, 'capture-bytes')] };
  if ('unreadable' in file) return { ...none, reasons: [sideReason('malformed', side, 'unreadable')] };
  let parsed;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return { ...none, reasons: [sideReason('malformed', side)] };
  }
  const shape = checkCapture(parsed);
  if (!shape.ok) return { ...none, reasons: [sideReason(shape.reason, side)] };
  const subject = subjectReasons(tree, side, parsed, commit, blobAt);
  if (subject.length > 0) return { ...none, reasons: subject, capture: parsed, readable: true };
  const outcome = outcomeReason(side, parsed.outcome);
  if (outcome !== null) return { ...none, reasons: [outcome], capture: parsed, readable: true };
  const stale = staleReason(side, parsed, evaluatedMs);
  return { reasons: stale === null ? [] : [stale], capture: parsed, readable: true, usable: true };
}

/** The reasons two usable captures give as a pair (K2 steps 6 and 7): comparability, then pairing. */
function pairReasons(base, candidate) {
  const reasons = [];
  if (base.tool !== candidate.tool) reasons.push({ code: 'not-comparable', detail: 'tool' });
  if (majorOf(base.toolVersion) !== majorOf(candidate.toolVersion)) {
    reasons.push({ code: 'not-comparable', detail: 'tool-major' });
  }
  if (base.registryHost !== candidate.registryHost) {
    reasons.push({ code: 'not-comparable', detail: 'registry-host' });
  }
  const skew = Math.abs(parseInstant(base.observedAt) - parseInstant(candidate.observedAt));
  if (skew > PAIRING_BUDGET_MS) reasons.push({ code: 'observation-skew' });
  return reasons;
}

function byReason(a, b) {
  return (
    byCodeUnit(a.code, b.code) ||
    byCodeUnit(a.side ?? '', b.side ?? '') ||
    byCodeUnit(a.detail ?? '', b.detail ?? '')
  );
}

/** Compare one tree: validate both captures, then classify when every check passes (K2, K4). */
function compareTree(tree, input, evaluatedMs) {
  const captures = input.captures[tree] ?? {};
  const { blobAt } = input;
  const base = inspectCapture({ tree, side: 'base', file: captures.base, commit: input.base.commit, blobAt, evaluatedMs });
  const candidate = inspectCapture({
    tree,
    side: 'candidate',
    file: captures.candidate,
    commit: input.candidate.commit,
    blobAt,
    evaluatedMs
  });
  const reasons = [...base.reasons, ...candidate.reasons];
  if (base.usable && candidate.usable) reasons.push(...pairReasons(base.capture, candidate.capture));
  if (input.base.commit === null) reasons.push({ code: 'base-not-selected', detail: input.base.detail });
  // Rows 1, 2 and 4 read the two lockfiles. A side whose lockfile could not be read cannot be
  // classified against, so its tree is incomplete rather than classified on a guess.
  if (reasons.length === 0) {
    for (const side of ['base', 'candidate']) {
      if (input.lockfiles[tree]?.[side] === null || input.lockfiles[tree]?.[side] === undefined) {
        reasons.push(sideReason('tree-missing', side));
      }
    }
  }
  reasons.sort(byReason);

  const provenance = (side) => (side.readable ? provenanceOf(side.capture) : null);
  if (reasons.length === 0) {
    const findings = classifyTree(tree, base.capture.findings, candidate.capture.findings, input.lockfiles[tree]);
    return {
      tree,
      complete: true,
      reasons,
      base: provenance(base),
      candidate: provenance(candidate),
      totals: totalsOf(findings),
      findings
    };
  }
  const listable = (side) => (side.usable ? side.capture.findings : []);
  return {
    tree,
    complete: false,
    reasons,
    base: provenance(base),
    candidate: provenance(candidate),
    totals: null,
    findings: listNotDetermined(tree, listable(base), listable(candidate))
  };
}

/**
 * Compare both trees' base and candidate captures into classified findings, per tree and overall
 * (K3, K4). A tree is complete only when every check on its two captures passed; otherwise it
 * names each reason, lists what it could read as not determined, and states no totals. The result
 * is complete only when every tree is, and its totals are `null` otherwise, never zero.
 *
 * @param {import('./advisory-compare.d.mts').CompareInput} input
 * @returns {import('./advisory-compare.d.mts').ComparisonResult}
 */
export function compareTrees(input) {
  const evaluatedMs = parseInstant(input.evaluatedAt);
  if (Number.isNaN(evaluatedMs)) throw new RangeError('evaluatedAt is not a UTC instant');
  const trees = TREE_NAMES.map((tree) => compareTree(tree, input, evaluatedMs));
  const complete = trees.every((tree) => tree.complete);
  const reasons = [];
  if (input.base.commit === null) {
    reasons.push({ tree: null, code: 'base-not-selected', detail: input.base.detail });
  }
  for (const tree of trees) {
    for (const reason of tree.reasons) {
      if (reason.code !== 'base-not-selected') reasons.push({ tree: tree.tree, ...reason });
    }
  }
  let totals = null;
  if (complete) {
    totals = zeroTotals();
    for (const tree of trees) for (const name of CLASSES) totals[name] += tree.totals[name];
  }
  return { complete, reasons, totals, trees };
}
