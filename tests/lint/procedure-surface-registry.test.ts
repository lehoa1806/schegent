// FR-R3-088, follow-up (b) — a registry of procedure surfaces, replacing two
// single-instance doc-contradiction gates.
//
// THE CLASS. `user-quickstart.md` instructed F5 → **Run Extension** while the
// `developer-setup.md` it names as its prerequisite stated, with a verification
// marker, that no such launch configuration existed. The corpus contradicted
// itself in the reader's own path. `launch-procedure-doc-parity.test.ts` closed
// that one pair; `playwright-install-doc-parity.test.ts` closed another. Feature
// 152's own code review filed the shape:
//
//   "the launch-procedure doc gate is the second single-instance
//    doc-contradiction gate — the class-level shape is a registry of procedure
//    surfaces, the pattern `asserted-counts.test.ts` already models."
//
// WHAT A REGISTRY BUYS OVER TWO GATES. Two gates means the third contradiction
// needs a third file, and the person who writes the third document does not know
// that. **What is registered is checked, and what is registered is visible.**
// Adding a surface to the table below is what puts it under the gate; nothing
// else is needed, and `registering a surface has effect` proves that.
//
// NOTHING IS LOST IN THE MIGRATION. FR-030 forbids deleting a gate for being
// hard to control; neither deleted gate was hard to control and neither check is
// gone. Each producer's bespoke validation — JSONC parsing for `launch.json`,
// version resolution for the Playwright command — travels with its entry as a
// `verifyProducer` function, because a registry that could only compare fixed
// strings would have had to drop exactly the parts those gates were written for.
//
// IT READS CODE SPANS AND FIXED LITERALS, NEVER PROSE. Carried over verbatim
// from `playwright-install-doc-parity.test.ts`, whose reasoning has not changed:
// a gate that reads prose pressures authors to write worse prose.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** The grant list the first-run walkthrough changes (FR-R4-F11). The full key, never a suffix. */
const UNCONTAINED_BACKENDS_SETTING = 'schegent.backend.uncontainedBackends';

/** A document pair (or set) that must agree about one procedure. */
interface ProcedureSurface {
  /** Stable id, used in failure messages. */
  readonly id: string;
  /** The artifact the documents describe. */
  readonly producer: string;
  /** Documents that must agree about it. */
  readonly surfaces: readonly string[];
  /** Fixed strings every surface must contain. Never prose. */
  readonly literals: readonly string[];
  /** Strings no surface may contain — the contradiction, stated. */
  readonly forbidden?: readonly string[];
  /** Why this pair is registered. A reader must be able to act on it. */
  readonly reason: string;
  /** Producer-specific validation, where a fixed string cannot express it. */
  readonly verifyProducer?: (producerSource: string) => void;
}

const REGISTRY: readonly ProcedureSurface[] = [
  {
    id: 'extension-host-launch',
    producer: '.vscode/launch.json',
    surfaces: ['docs/tutorials/user-quickstart.md', 'docs/tutorials/developer-setup.md'],
    literals: ['Run Extension'],
    forbidden: ['no such launch configuration', 'no launch configuration exists'],
    reason:
      'FR-R3-073: the quickstart instructed F5 -> Run Extension while its own stated ' +
      'prerequisite asserted the configuration did not exist',
    verifyProducer: (source) => {
      // launch.json is JSONC (VS Code allows comments); strip line comments
      // rather than adding a JSONC dependency for a gate.
      const raw = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      const parsed = JSON.parse(raw) as {
        configurations?: ReadonlyArray<{ name?: string; type?: string; request?: string }>;
      };
      const configuration = (parsed.configurations ?? []).find(
        (candidate) => candidate.name === 'Run Extension'
      );
      expect(
        configuration,
        '.vscode/launch.json must define a configuration named "Run Extension" — it is the ' +
          'procedure the quickstart instructs; removing it re-creates the contradiction'
      ).toBeDefined();
      expect(configuration?.type).toBe('extensionHost');
      expect(configuration?.request).toBe('launch');
    }
  },
  {
    id: 'playwright-browser-install',
    producer: 'scripts/check-playwright-browser.mjs',
    surfaces: ['docs/tutorials/developer-setup.md', 'CONTRIBUTING.md'],
    literals: ['playwright install'],
    reason:
      'the preflight and the setup documents must offer the same install command; a ' +
      'documented command the preflight does not recognise sends a contributor in a circle',
    verifyProducer: (source) => {
      // The preflight declares the command it offers; the documents must offer
      // the same one. Comparing against the DECLARED command rather than
      // against what is installed on this machine — the manifest is the
      // contract, and `npm ci` is the remedy for a tree out of step with it.
      const constant = /const INSTALL_COMMAND = '([^']+)'/.exec(source);
      expect(
        constant,
        'scripts/check-playwright-browser.mjs must declare INSTALL_COMMAND — it is what the ' +
          'documents are held to'
      ).not.toBeNull();
      expect((constant as RegExpExecArray)[1]).toContain('playwright install');
    }
  },
  {
    // FR-R3-101 (FR-022, FR-023) — the install sequence, across every surface that teaches it.
    //
    // THE CLASS, AGAIN, AND WORSE. `.npmrc` set `ignore-scripts=true` (a deliberate hardening,
    // FR-R3-090), which disabled the root `postinstall` that installed `webview-ui`.
    // `CONTRIBUTING.md` was updated to the two-command sequence. **Four other surfaces were
    // not**, and two of them affirmatively stated the thing that had become false — "its
    // postinstall also installs webview-ui", "a single npm install prepares both package
    // trees". A contributor following the README, the tutorial, the how-to or the course got a
    // checkout whose first build failed, for months.
    //
    // WHY THE EXISTING SELFTEST DID NOT CATCH IT. `clean-install-selftest.sh` tests
    // CONTRIBUTING's sequence and only CONTRIBUTING's, in a chain that seldom runs. It verified
    // the one document that was right.
    //
    // WHAT IS REGISTERED IS CHECKED. That is the whole point of putting these five here rather
    // than fixing five documents: the next `.npmrc` change fails a gate instead of breaking
    // four documents for months.
    id: 'two-command-install',
    producer: '.npmrc',
    surfaces: [
      'CONTRIBUTING.md',
      'README.md',
      'docs/tutorials/developer-setup.md',
      'docs/how-to/developer-workflows.md',
      'docs/courses/develop-schegent.md',
      // FR-R4-F11 (FR-006): the operator course taught a bare `npm install` and was the one page
      // with a root-install block that this registry did not know about.
      'docs/courses/use-schegent.md',
      // Feature 217 (FR-R3-178): recording the gate starts by installing the committed tree,
      // because the record names a commit and cannot see `node_modules`.
      'docs/operations/gate-recording.md'
    ],
    // The second command IS the sequence: the first is unremarkable, and a surface that names
    // only the first is exactly the broken state this closes.
    literals: ['npm --prefix webview-ui ci'],
    // The claims that were false. Each was written when the postinstall did run, and each
    // survived the hardening that stopped it.
    forbidden: [
      'a separate webview install is unnecessary',
      'a single npm install prepares both package trees',
      'The root install also installs `webview-ui`'
    ],
    reason:
      'FR-R3-101: `.npmrc` ignore-scripts=true disables the postinstall that installed ' +
      'webview-ui, so every surface teaching a bare install hands a contributor a checkout ' +
      'whose first build fails. Four of five taught it, two of them affirmatively',
    verifyProducer: (source) => {
      // The hardening is what makes the second command necessary. If `ignore-scripts` is ever
      // turned off, this entry's premise is gone and the gate should be re-examined rather
      // than left asserting a command nobody needs — so the producer is checked, not assumed.
      const active = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(
        /^\s*ignore-scripts\s*=\s*true\s*$/m.test(active),
        '.npmrc no longer sets ignore-scripts=true. The two-command install sequence exists ' +
          'BECAUSE of that setting; if the hardening is gone, re-examine this registry entry ' +
          'rather than leaving the registered documents pinned to a command nobody needs.'
      ).toBe(true);
    }
  },
  {
    // FR-R4-F11 (FR-001 to FR-005) — the first run's consent, and what a rollback can undo.
    //
    // THE CLASS. The quickstart promised "to undo it entirely, close the window and delete the
    // directory", for a walkthrough whose first Run is refused until the operator grants the
    // default backend. That grant is an `application`-scoped User setting, so deleting the
    // folder does not remove it, and the promise was false for the one step that matters most.
    // The entry pins the setting id on both pages that walk a first run and forbids the old
    // promise. Each forbidden phrase sits on ONE source line of the quickstart, because
    // `checkSurface` reads raw source and a phrase that crosses the hard wrap never matches.
    id: 'uncontained-first-run',
    producer: 'package.json',
    surfaces: ['docs/tutorials/user-quickstart.md', 'docs/courses/use-schegent.md'],
    literals: [UNCONTAINED_BACKENDS_SETTING],
    forbidden: ['To undo it entirely', 'confined to that directory'],
    reason:
      'FR-R4-F11: the first Run on the default backend is refused until the operator grants it, ' +
      'in an application-scoped User setting, so deleting the walkthrough folder does not undo ' +
      'the grant and a rollback that says it does misstates what the operator changed',
    verifyProducer: (source) => {
      // The premise of the forbidden phrases is that the grant outlives the folder. If the
      // setting stops being an application-scoped list that defaults to empty, re-examine the
      // entry rather than leaving two pages pinned to a rollback that no longer applies. The
      // search term is the full setting key, never a value.
      const manifest = JSON.parse(source) as {
        readonly contributes?: {
          readonly configuration?: {
            readonly properties?: Readonly<
              Record<string, { readonly default?: unknown; readonly scope?: string }>
            >;
          };
        };
      };
      const setting = Object.entries(manifest.contributes?.configuration?.properties ?? {}).find(
        ([key]) => key === UNCONTAINED_BACKENDS_SETTING
      )?.[1];
      expect(
        setting,
        `package.json no longer contributes ${UNCONTAINED_BACKENDS_SETTING}. The first-run ` +
          'rollback text is written about it; re-examine this registry entry'
      ).toBeDefined();
      expect(setting?.default, 'the grant list must default to empty').toEqual([]);
      expect(
        setting?.scope,
        'the grant must stay application-scoped, or deleting a folder could undo it'
      ).toBe('application');
    }
  },
  {
    // FR-R4-F11 (FR-007) — the route to a VSIX, and the one that does not exist.
    //
    // THE CLASS. `RELEASE.md` records that GitHub Actions was retired on 2026-08-26 and that no
    // GitHub Release is created. The operator course went on telling a reader to "use a VSIX
    // attached to a tagged GitHub Release", and the docs index called tagged Releases "the durable
    // VSIX route". Both are the first thing a newcomer follows, and both pointed at nothing.
    //
    // The course links the words (`a tagged [GitHub Release](…)`), so the plain phrase alone would
    // miss it: the link form and the Releases URL path are forbidden too. Each phrase sits on one
    // source line, because `checkSurface` reads raw source and a phrase that crosses the hard wrap
    // never matches.
    id: 'vsix-route',
    producer: 'RELEASE.md',
    surfaces: ['docs/courses/use-schegent.md', 'docs/README.md'],
    literals: ['npm run package'],
    forbidden: [
      'tagged GitHub Release',
      'tagged [GitHub Release]',
      'schegent/releases',
      'release automation is the durable',
      'GitHub Releases are the durable'
    ],
    reason:
      'FR-R4-F11: RELEASE.md records that no GitHub Release is created since GitHub Actions was ' +
      'retired on 2026-08-26, so a page that sends a reader to a tagged Release sends them to a ' +
      'route that does not exist; the local `npm run package` build is the route that does',
    verifyProducer: (source) => {
      // The premise of the forbidden phrases. If RELEASE.md stops saying so, a Release route may
      // exist again: re-examine this entry rather than leaving two pages forbidden to mention it.
      expect(
        source.includes('no GitHub Release is created'),
        'RELEASE.md no longer says "no GitHub Release is created". The vsix-route entry forbids ' +
          'pages from sending a reader to a tagged Release on that basis; re-examine it'
      ).toBe(true);
    }
  },
  {
    // FR-R4-F11 (FR-008) — what the verification commands are, said by content.
    //
    // THE CLASS. `README.md` called `npm run ci` "broader" than `npm run verify:all`, and neither
    // it nor `AGENTS.md` named `npm run gate` at all. `gate` is the full verification: the five
    // repository checks and then `ci`. `ci` runs none of the five, and `verify:all` runs the five
    // but none of the browser-backed, packaging or integration suites, so neither is a superset
    // of the other. A page that calls one "broader" misleads a contributor into running the wrong
    // one before a push.
    //
    // The surfaces must name `npm run gate`. `checkSurface` matches literals with a raw `includes`,
    // so `npm run gate:record` would also satisfy it; none of the three surfaces relies on that,
    // and each shows the command on a line of its own.
    id: 'verification-commands',
    producer: 'package.json',
    surfaces: ['README.md', 'CONTRIBUTING.md', 'AGENTS.md'],
    literals: ['npm run gate'],
    forbidden: ['The broader `npm run ci`', 'superset of'],
    reason:
      'FR-R4-F11: `npm run gate` is the full verification (the five repository checks, then ci); ' +
      'ci runs none of the five and verify:all runs none of the integration suites, so a page ' +
      'that calls one broader than or a superset of the other tells a contributor the wrong thing',
    verifyProducer: (source) => {
      // The documents describe these compositions, so the manifest is checked, not assumed. Each
      // script is split on `&&` and matched as whole `npm run <name>` steps, never as substrings:
      // `test:integration` must not match `test:integration:compile`.
      const manifest = JSON.parse(source) as {
        readonly scripts?: Readonly<Record<string, string>>;
      };
      const scripts = new Map(Object.entries(manifest.scripts ?? {}));
      const stepsOf = (name: string): readonly string[] =>
        (scripts.get(name) ?? '').split('&&').flatMap((part) => {
          const step = /^npm run ([\w:-]+)$/.exec(part.trim())?.at(1);
          return step === undefined ? [] : [step];
        });
      const repositoryChecks = [
        'contracts:check',
        'docs:check',
        'security:secrets',
        'security:actions',
        'license:check'
      ];
      const gate = stepsOf('gate');
      const ci = stepsOf('ci');
      const verifyAll = stepsOf('verify:all');
      for (const check of [...repositoryChecks, 'ci']) {
        expect(gate, `the gate script no longer runs ${check}; the documents say it does`).toContain(check);
      }
      for (const check of repositoryChecks) {
        expect(ci, `the ci script now runs ${check}; the documents say it runs none of the five`).not.toContain(
          check
        );
      }
      expect(
        verifyAll,
        'verify:all now runs test:integration; the documents say it runs no integration suite'
      ).not.toContain('test:integration');
    }
  }
];

/** Code spans only — a gate that reads prose pressures authors to write worse prose. */
const codeSpans = (source: string): string =>
  [...source.matchAll(/`([^`]+)`/g), ...source.matchAll(/```[\w]*\n([\s\S]*?)```/g)]
    .map((match) => match[1] as string)
    .join('\n');

/** The shared check. Everything a registry entry means, in one place. */
function checkSurface(entry: ProcedureSurface, load: (path: string) => string): void {
  if (entry.verifyProducer) entry.verifyProducer(load(entry.producer));
  for (const surface of entry.surfaces) {
    const source = load(surface);
    const spans = codeSpans(source);
    for (const literal of entry.literals) {
      expect(
        `${spans}\n${source}`.includes(literal),
        `${entry.id}: ${surface} must state '${literal}' — ${entry.reason}`
      ).toBe(true);
    }
    for (const forbidden of entry.forbidden ?? []) {
      expect(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        `${entry.id}: ${surface} still asserts '${forbidden}', contradicting ${entry.producer}`
      ).toBe(false);
    }
  }
}

// FR-R4-F11 (FR-006, SC-003) — THE INSTALL CENSUS. Registering a surface puts it under the gate, and
// that is also the weakness: a page that teaches the install and is not registered is invisible to
// every check above. `docs/courses/use-schegent.md` was exactly that. So the census runs the other
// way round: it starts from every Markdown page in the repository, finds the ones that teach a root
// install, and requires each to be registered and to include the second command.

/** The second command of the sequence: `.npmrc` disables the root postinstall that did it. */
const WEBVIEW_INSTALL = 'npm --prefix webview-ui ci';

/** Directory names the census never enters. */
const CENSUS_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.tmp',
  '.vscode-test'
]);

/** A root-install line: `npm ci`, `npm install` or `npm i`, an optional `$ `, optional trailing flags. */
const ROOT_INSTALL_LINE = /^(?:\$\s+)?npm\s+(?:ci|install|i)(?:\s+\S+)*$/;

/** The fenced blocks of a page, each as its text. Fences may be indented (a list item's block). */
function fencedBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (current === undefined) {
        current = [];
      } else {
        blocks.push(current.join('\n'));
        current = undefined;
      }
      continue;
    }
    if (current !== undefined) current.push(line);
  }
  return blocks;
}

/**
 * The fenced blocks that contain a root-install line. A line that carries `--prefix` installs a
 * different package tree, so it is not a root install: that is how `npm --prefix webview-ui ci`,
 * the second command, stays out of this set. A trailing `# comment` is not part of the command.
 */
function rootInstallBlocks(source: string): string[] {
  return fencedBlocks(source).filter((block) =>
    block.split('\n').some((line) => {
      const command = line.replace(/\s+#.*$/, '').trim();
      return !command.includes('--prefix') && ROOT_INSTALL_LINE.test(command);
    })
  );
}

/** Every Markdown page under the repository root, repo-relative and POSIX. */
function markdownInRepo(directory: string = REPO_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (CENSUS_SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      markdownInRepo(full, found);
      continue;
    }
    if (entry.name.endsWith('.md')) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return found.sort();
}

interface InstallCensus {
  /** Pages that teach a root install and are not registered surfaces. */
  readonly unregistered: readonly string[];
  /** Registered pages with a root-install block that lacks the second command. */
  readonly missingWebviewInstall: readonly string[];
}

/** Pure: one body for the live tree and for the synthetic corpus of the NON-VACUITY case. */
function installCensus(
  pages: ReadonlyMap<string, string>,
  registered: ReadonlySet<string>
): InstallCensus {
  const unregistered: string[] = [];
  const missingWebviewInstall: string[] = [];
  for (const [page, source] of pages) {
    const blocks = rootInstallBlocks(source);
    if (blocks.length === 0) continue;
    if (!registered.has(page)) {
      unregistered.push(page);
      continue;
    }
    if (blocks.some((block) => !block.includes(WEBVIEW_INSTALL))) missingWebviewInstall.push(page);
  }
  return { unregistered, missingWebviewInstall };
}

const TWO_COMMAND_INSTALL_SURFACES: ReadonlySet<string> = new Set(
  REGISTRY.find((entry) => entry.id === 'two-command-install')?.surfaces ?? []
);

let liveInstallCensus: InstallCensus | undefined;
function liveCensus(): InstallCensus {
  liveInstallCensus ??= installCensus(
    new Map(markdownInRepo().map((page) => [page, read(page)] as const)),
    TWO_COMMAND_INSTALL_SURFACES
  );
  return liveInstallCensus;
}

describe('FR-R3-088 — registered procedure surfaces agree with their producer', () => {
  it('the registry is non-empty and every entry carries a reason a reader can act on', () => {
    // The rule applied to the rule: an empty registry would report perfect
    // compliance over nothing, which is the shape this tier exists to forbid.
    expect(REGISTRY.length).toBeGreaterThanOrEqual(2);
    for (const entry of REGISTRY) {
      expect(entry.surfaces.length, `${entry.id} must register at least two surfaces`).toBeGreaterThan(1);
      expect(entry.reason.length, `${entry.id} needs a reason`).toBeGreaterThan(40);
    }
  });

  it.each(REGISTRY.map((entry) => [entry.id, entry] as const))(
    '%s: every registered surface agrees with the producer',
    (_id, entry) => {
      checkSurface(entry, read);
    }
  );

  it('the two single-instance gates this replaces are gone, and their checks are not', () => {
    // A migration, not a removal (FR-030). Both producers and every surface each
    // gate covered are registered above; the deletion is only of the two files.
    const registeredProducers = REGISTRY.map((entry) => entry.producer);
    expect(registeredProducers).toContain('.vscode/launch.json');
    expect(registeredProducers).toContain('scripts/check-playwright-browser.mjs');
    const registeredSurfaces = REGISTRY.flatMap((entry) => entry.surfaces);
    expect(registeredSurfaces).toContain('docs/tutorials/user-quickstart.md');
    expect(registeredSurfaces).toContain('docs/tutorials/developer-setup.md');
  });

  it('NON-VACUITY: registering a surface is what makes it checked', () => {
    // A third entry, checked against an in-memory corpus rather than the tree,
    // so the proof needs no permanent third surface. Disagree -> red; agree ->
    // green. Both directions, which is what makes this a control rather than a
    // demonstration.
    const third: ProcedureSurface = {
      id: 'probe',
      producer: 'probe/producer.json',
      surfaces: ['probe/a.md', 'probe/b.md'],
      literals: ['Do The Thing'],
      forbidden: ['there is no such thing'],
      reason: 'a registered probe proving that registration is what puts a surface under the gate'
    };

    const agreeing = new Map([
      ['probe/producer.json', '{}'],
      ['probe/a.md', 'Run `Do The Thing` to start.'],
      ['probe/b.md', 'Its prerequisite is `Do The Thing`.']
    ]);
    expect(() => checkSurface(third, (path) => agreeing.get(path) as string)).not.toThrow();

    const contradicting = new Map(agreeing);
    contradicting.set('probe/b.md', 'There is no such thing as `Do The Thing`.');
    expect(() => checkSurface(third, (path) => contradicting.get(path) as string)).toThrow();

    const missing = new Map(agreeing);
    missing.set('probe/a.md', 'Run something else entirely.');
    expect(() => checkSurface(third, (path) => missing.get(path) as string)).toThrow();

    // And an UNREGISTERED surface is not checked at all — which is the other
    // half of "what is registered is checked".
    const unregistered = { ...third, surfaces: ['probe/a.md'] };
    expect(() => checkSurface(unregistered, (path) => contradicting.get(path) as string)).not.toThrow();
  });

  it('every page that teaches a root install is a registered two-command-install surface', () => {
    const { unregistered } = liveCensus();
    expect(
      unregistered,
      'these pages carry a fenced root-install block but are not in the two-command-install ' +
        'surfaces, so no check reads them: register each (and give its block the second command) ' +
        `or link to CONTRIBUTING.md instead — ${unregistered.join(', ')}`
    ).toEqual([]);
  });

  it('every root-install block on a registered surface also installs webview-ui', () => {
    const { missingWebviewInstall } = liveCensus();
    expect(
      missingWebviewInstall,
      `a root-install block lacks '${WEBVIEW_INSTALL}', so the first build fails (.npmrc sets ` +
        `ignore-scripts=true) — ${missingWebviewInstall.join(', ')}`
    ).toEqual([]);
  });

  it('NON-VACUITY: the install census reports each way a page can teach the install wrongly', () => {
    // The same function the two live cases call, over a synthetic corpus. Four inputs, each of
    // which the live cases must be able to see.
    const fence = (...lines: string[]): string => ['```bash', ...lines, '```'].join('\n');
    const registered: ReadonlySet<string> = new Set(['registered.md']);

    // An unregistered page whose block installs the root package: reported as unregistered.
    const withoutSecond = fence('npm ci', 'npm run build');
    expect(installCensus(new Map([['unregistered.md', withoutSecond]]), registered)).toEqual({
      unregistered: ['unregistered.md'],
      missingWebviewInstall: []
    });

    // The same block on a registered page: reported as missing the webview install.
    expect(installCensus(new Map([['registered.md', withoutSecond]]), registered)).toEqual({
      unregistered: [],
      missingWebviewInstall: ['registered.md']
    });

    // `npm ci` then the second command passes, on a registered page and in a `$ ` prompt form.
    const complete = fence('$ npm ci --offline', 'npm --prefix webview-ui ci  # second install');
    expect(installCensus(new Map([['registered.md', complete]]), registered)).toEqual({
      unregistered: [],
      missingWebviewInstall: []
    });

    // A block whose only install line is the second command is not a root install at all.
    const onlySecond = fence('npm --prefix webview-ui ci');
    expect(rootInstallBlocks(onlySecond)).toEqual([]);
    expect(installCensus(new Map([['unregistered.md', onlySecond]]), registered)).toEqual({
      unregistered: [],
      missingWebviewInstall: []
    });
  });
});
