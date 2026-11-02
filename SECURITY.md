# Security policy

## Supported versions

This repository does not declare a supported-version window, long-term-support line, or backport policy. `package.json` identifies the current source version as `0.2.0`, but neither the disclosure policy nor the release workflow promises that this version—or any older line—receives security fixes. Do not infer support from a tag or version number; report the affected version or commit so the maintainers can triage it.

<!-- Source: package.json -->
<!-- Source: .github/SECURITY.md -->
<!-- Source: docs/release/actions-terminal-record.md -->

## Report a vulnerability

Do not publish suspected vulnerabilities in an issue, discussion, or pull request. Use one of the two private channels:

1. Submit a [private GitHub Security Advisory](https://github.com/lehoa1806/schegent/security/advisories/new). This is the preferred channel.
2. If GitHub private reporting is unavailable to you, email [hoalee1806@gmail.com](mailto:hoalee1806@gmail.com).

Include a description, reproduction steps, and the affected version or commit. The maintainers target acknowledgement within 7 calendar days and resolution within 90 calendar days. Resolution may be a shipped patch, a documented mitigation, or an explained close-as-won't-fix; a complex or coordinated case may receive an agreed extension before day 90.

<!-- Source: .github/SECURITY.md -->
<!-- Source: .github/ISSUE_TEMPLATE/security.yml -->
<!-- Source: .github/ISSUE_TEMPLATE/config.yml -->

## Scope

Reports about the code shipped by this repository are in scope, including the extension host, webviews, host/webview IPC, local state and ownership gates, audit and log handling, central redaction, process-definition import/export, and the Claude, Codex, and Agy runner adapters. Documentation that materially misstates a security-sensitive behavior is also useful to report privately.

<!-- Source: src/extension.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/lib/logger.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/process-yaml/import-planner.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->

The upstream Claude, Codex, and Agy CLIs are outside this repository's implementation scope. So are VS Code itself, unrelated extensions, and a workstation compromise that already grants the attacker the operator's local permissions. Reports about those components should go to their maintainers; when uncertain, report privately here and the maintainers can redirect it.

<!-- Source: .github/SECURITY.md -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

## Permission posture

Claude is the default backend. Claude and Agy are launched with their CLI approval prompts off, so the agent acts without asking; their adapters unconditionally include `--dangerously-skip-permissions`. Codex is the exception: it runs with the OS-enforced `--sandbox workspace-write` bound, which leaves `.git` read-only. A Phase's `sideEffects` declaration selects consent and rollback behavior and causes a Git-writing Phase to be refused on a runner that is not Git-capable; it does not restrict the spawned subprocess. Point Schegent at a repository you can restore.

<!-- Source: package.json -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->
<!-- Source: src/activation/git-approval.ts -->

The operator threat catalog in [the threat model](docs/security/threat-model.md#threat-catalog) is the complete set, lettered entries such as T5a and T5b included. It records mitigations and residual risk; it is not a claim that local autonomous execution is safe against every input.

The audit log is hash-chained, with a head checkpoint. The chain detects edits, reorders and unrecorded removals in the retained chain. It does not prevent the same OS user from rewriting the log, recomputing the chain and replacing the checkpoint: [the audit-log entry of the threat model](docs/security/threat-model.md#t3--audit-log-tampering-or-non-append-writes) states what is detected and what is not.

<!-- Source: tests/lint/threat-id-anchor-parity.test.ts -->
<!-- Source: src/runner/prompt-builder.ts -->
<!-- Source: src/audit/audit-chain.ts -->
<!-- Source: src/audit/audit-checkpoint.ts -->

## Automated security checks

> **GitHub Actions were retired on 2026-08-26 by operator decision, for budget**
> (`FR-R3-099`). Every scheduled and pull-request-triggered control below is
> therefore **withdrawn**, and the eight workflow files are deleted from the tree.
> They are not dormant and they are not pending a restart: the run history they
> produced is read once, in
> [`docs/release/actions-terminal-record.md`](docs/release/actions-terminal-record.md),
> and what each control was is recorded in
> [`docs/release/withdrawn-ci-controls.md`](docs/release/withdrawn-ci-controls.md).
> The single-platform, single-machine limit that follows is **permanent**, not a
> state awaiting a push.

### What runs

Three of the five controls below — the secret scan, the workflow-pin check and the
license check — run inside the attested gate command (`npm run gate`), which is what a
release is bound to. The other two do not, and the difference matters more than the
count: `npm audit` runs locally but only when an operator invokes it, for the reason its
row states; Dependabot does not run here at all, it runs on GitHub, and it opens pull
requests that nothing then checks. What governs those is a merge rule the operator follows,
not a check: see [gate recording](docs/operations/gate-recording.md). There is no remote
enforcement point, so a control outside the gate is a control nothing runs for you.

> **This sentence was false for ~32 hours, from 2026-08-27 00:15 +0700 to 2026-08-28, and
> `FR-R3-135` is why it is true now.** The controls were inside the `gate` script chain the
> whole time, but the commit that pointed the release binding at `npm run gate` left the
> recorder spawning `npm run ci` — and `ci` reaches none of the four controls below that
> the five release-only stages provide. So "inside the attested gate command" named a
> command no attestation had ever observed, and a release could have been attested past a
> failing secret scan even though the scan was in the chain. The recorder now spawns one
> frozen argument vector from which the recorded label is *rendered*, every record carries
> that vector as its own witness, and the release check refuses both a label the vector
> does not support and a vector that is not this gate's. The attestation schema moved to
> version 2, so every record written in that window is refused by version rather than by
> name.
>
> **The window is not the reassuring part.** It was short because the defect was found by a
> code audit within a day, not because anything detected it: the label was a free constant
> the recorder wrote unconditionally, so no test and no gate stage could have. One
> attestation was written inside it. The control that now exists is the argument vector
> being asserted in the suite, which is what makes the short window repeatable rather than
> fortunate.
> <!-- Source: scripts/gate-attestation.mjs --><!-- Source: scripts/gate-recorder.mjs -->

| Control | Coverage and trigger | Enforcement |
|---|---|---|
| Secret scan | Every git-tracked file, **including `tests/**`**, scanned by secretlint's recommended ruleset with its AWS id scan switched on, the dotenv rule and one local rule | `scripts/scan-secrets.mjs` via `npm run security:secrets`, inside `npm run gate`. Findings are exempted per entry with a stated reason in `.secretlintignore`, never by excluding a directory. One measurement, on 2026-11-01: **38 s** over 2,933 tracked files (2,929 scanned). <!-- Source: package.json --><!-- Source: scripts/scan-secrets.mjs --> |
| npm audit | Root and `webview-ui` lockfiles, **operator-invoked** (`npm run security:audit`) | `npm audit --audit-level=low`; it does not auto-fix or commit. **Not in the attested gate**, and the reason is stated rather than left to inference: it queries the npm registry, so a gate containing it would fail for want of a network — and a gate that fails for reasons unrelated to the tree is a gate people learn to bypass with `--no-verify`. Before this item it had no local home at all: the deleted `security-audit.yml` was its only caller. It is **not release evidence**: the release path reads feature 249's captures instead, which override the npm settings that let this audit pass falsely. <!-- Source: package.json --> |
| Advisory comparison | Root and `webview-ui` lockfiles at the base and candidate commits, **operator-invoked** (`npm run security:advisory-diff`) | Report-only and not part of `npm run gate`. The capture step queries the registry for the same reason given for `npm audit`. The comparison is offline, exits 0 whatever it finds, and is neither a waiver nor permission to integrate; `npm run security:audit` is unchanged. See [the operator page](docs/operations/dependency-advisory-comparison.md). <!-- Source: package.json --><!-- Source: scripts/advisory-diff.mjs --> |
| Release advisory evidence | One capture per tree (`npm run security:advisory-diff -- capture`) and the tracked list [`docs/release/advisory-dispositions.json`](docs/release/advisory-dispositions.md), read by `npm run release` | `scripts/release-advisory.mjs` reads files and spawns nothing, so it has no network and the gate never reaches it. Release preparation refuses a capture that is `incomplete` or `unavailable` (the audit gave no report), one made for a different lockfile than HEAD holds, one observed after the preparation time, one older than **seven days** (exactly seven is accepted), and a list it cannot use. A finding with no covering disposition is reported with its verdict, not refused, and `accepted` is a label, not a waiver. <!-- Source: scripts/release-advisory.mjs --><!-- Source: scripts/advisory-dispositions.mjs --> |
| Workflow pin check | Any workflow file that reappears | `scripts/check-workflow-pins.mjs` requires immutable 40-character SHA pins. With no workflows present it reports *nothing to pin* rather than *passed* — a latent guard against a re-added, unpinned workflow. <!-- Source: package.json --><!-- Source: scripts/check-workflow-pins.mjs --> |
| License check | Root manifest and the license operations record | `scripts/check-licenses.mjs` checks that `LICENSE.md` and `docs/operations/licenses.md` exist and that the manifest has a truthy `license` field; it does not inspect dependency licenses. <!-- Source: package.json --><!-- Source: scripts/check-licenses.mjs --> |
| Dependabot | Root and `webview-ui` npm manifests; weekly Monday minor/patch updates; major updates ignored | Still configured, and it opens pull requests — but **nothing runs checks on them any more**. A Dependabot pull request now arrives unverified. It is merged into `develop` only from a commit that carries a passing `npm run gate:record` record naming that commit, and that is a rule the operator follows, not a check ([gate recording](docs/operations/gate-recording.md)). <!-- Source: .github/dependabot.yml --><!-- Source: docs/operations/gate-recording.md --> |

### Durability of the evidence writes

`.schegent/audit.log` is durable against a **process crash** and not against **power loss**: entries
written in the seconds before an abrupt power failure may be absent, and the last entry may be
truncated mid-line. The parser tolerates a truncated final line, so the loss is bounded to recent
entries rather than to the file.

The gate attestation a release is bound to **does** carry an explicit durability barrier — it is
written once per gate run, so the cost is negligible against a four-minute gate. The
terminal-transition journal is a VS Code `Memento` key, so a barrier is **unavailable** there rather
than declined.

The measurement that split that decision three ways — an `fsync` costs 289× a plain append on this
machine — and what is deliberately out of scope are recorded in
[the durability decision](docs/architecture/durability-decision.md).

### The secret scan: what it is, and what it is not

**What changed, 2026-08-26 (`FR-R3-109`).** Until this date the scan was four regular
expressions — a PEM header, `AKIA…`, `gh[pousr]_…`, `sk-ant-…` — over tracked files
**with `tests/**` and `package-lock.json` filtered out**. Meanwhile `@secretlint/node`
sat in `devDependencies` wired to nothing, so anyone inventorying the toolchain saw a
real scanner and reasonably concluded it scanned. It did not.

Wiring it found **23 findings the four expressions never saw**, every one in the test
tree the old scan excluded. That is the exclusion's cost, stated as a number: a real
credential pasted into a test file was invisible **by construction** rather than
missed.

**What it does now.** secretlint's `preset-recommend` with its AWS id scan switched on, `no-dotenv`, and one
local rule (`scripts/secretlint-rule-schegent.mjs`, declared in `.secretlintrc.json`, so that file stays
the whole ruleset), over `git ls-files`, **including `tests/**`**. One run on 2026-11-01 took **38 seconds** over 2,933 tracked files, 2,929 of them scanned and 4 skipped by `.secretlintignore` (Darwin arm64, load average near 5); it is a single measurement and not a bound. The earlier figure, about 39 seconds, was taken over 1,947 files.
Scoped to tracked files so an untracked scratch file is not read and `node_modules` is never walked; the
previous scan used the same scope and the measurement is why it was kept. A finding is reported by rule and
location with its value masked, so the report is safe to leave in a terminal or a log: open the file at that
location to see what matched. A run that finds no file to scan, such as one outside a repository of its own,
is refused rather than passed.

**Two modes, one ruleset.** Tree mode (`npm run security:secrets`, in the gate) reads the tracked files on
disk. **Staged mode** (`npm run security:secrets:staged`, which is `node scripts/scan-secrets.mjs --staged`)
reads what a commit would carry **from the Git index, never from the working tree**: a secret staged and then
edited out of the working copy passes the tree scan and is committed, and staged mode closes that. It scans
every added, modified, renamed, copied and type-changed path at its new path, whatever a rename's similarity,
and reads the configuration and the ignore list as staged, so a commit that weakens the ignore list is judged
by the list it commits. It skips, and counts, a deletion, a gitlink, a path the ignore list names, and a path
whose staged content is the base's (a mode-only change). It never writes the index, the working tree or the
stash, and takes no lock. A scan that cannot answer is a refusal, not a pass: an unmerged path, a missing or
unparseable staged configuration, a blob git cannot read, an engine that will not load, an unknown argument.
A commit with nothing to scan says "nothing staged needed scanning" and exits 0.

**What it detects.** One planted case per family, in each mode, in `tests/fixtures/secret-scan-corpus.ts`:

| Family (`PLANTED.family`) | What it is | Reported by |
|---|---|---|
| `1password`, `aws`, `basicauth`, `gcp`, `github`, `linear`, `npm`, `openai`, `privatekey`, `sendgrid`, `shopify`, `slack` | the preset's twelve families | `secretlint-rule-<family>` |
| `no-dotenv` | a file named exactly `.env` | the dotenv rule |
| `aws-access-key-id` | a lone AWS access key id (`AKIA…`, `ASIA…`), which the preset reports only with its id scan on; the AWS documentation example is ignored | `secretlint-rule-aws` |
| `aws-account-id` | a 12-digit account id after an `account`-type key; the same option enables it | `secretlint-rule-aws` |
| `anthropic` | `sk-ant-`, a version tag such as `api03-`, then a body of at least 32 characters | the local rule |
| `jwt` | three base64url segments whose header and payload both begin `eyJ` | the local rule |
| `password-assignment` | a name ending in a password word, `=`, then an unquoted value of at least 8 characters on an env-style line | the local rule |
| `password-assignment-quoted` | a name ending in a password word, `:` or `=`, then a quoted literal of at least 8 characters that holds no `${` | the local rule |
| `dotenv-variant`, `dotenv-variant-nested` | a file whose base name is `.env.<suffix>`, such as `.env.local` or `config/.env.production`; not `.env.example`, `.env.sample` or `.env.template` | the local rule |
| `anthropic-in-template` | an Anthropic key inside one of those three templates: a template is not reported by name, and its content still passes through every rule | the local rule |

**What it does not detect**, each recorded in the same fixture, as an unsupported shape or as a dropped family, with its reason:

- a TOKEN or SECRET code constant: names ending in `TOKEN` or `SECRET` are not matched, because the tree holds
  constants with such names whose values are not credentials (the runtime redactor covers them);
- a .envrc file, and a dotenv file with no leading dot (`env.local`);
- a secret split across two files;
- a bespoke internal token format;
- an Azure storage account key, as a connection string or as an assignment: the installed preset lists an Azure
  rule among its dependencies and does not register it, and the local rule has no Azure pattern (a synthetic key
  was not reported on 2026-11-01, where a GitHub-shaped control in the same run was).

**The commit hook.** `scripts/hooks/pre-commit` runs the staged scan on `git commit`. It is **local and
opt-in**: nothing installs it. Activate it once, inside `repo/`, with
`git config core.hooksPath scripts/hooks`. Its limits are stated here and not hidden:

- `git commit --no-verify` bypasses it, as it bypasses every client-side hook;
- git does not run it for a conflict-free merge (a merge that commits by itself runs `pre-merge-commit`, not
  `pre-commit`), so the merged tree is covered only by the tree-mode gate;
- there is **no server-side check**, so a commit that reached a remote without the hook was not scanned;
- it needs `node` on `PATH`, and refuses with a named line when it is missing;
- whether it is active on a given clone is a property of that clone's `core.hooksPath`, and is observed, not assumed.

**What it does not do**, because an honest small control beats an implied large one:

- **It is not a general credential detector.** It matches the patterns its ruleset
  carries. A bespoke internal token format is not among them.
- **A lone AWS access key id is detected, since the id scan was switched on.** An earlier version of this
  section said the AWS rule needed a pair and did not flag a lone `AKIA…` id. That was true of the
  configuration, which never switched on the rule's `enableIDScanRule` option, and not of the rule: with it
  on, a lone access key id is reported (the documentation example `AKIAIOSFODNN7EXAMPLE` is ignored). The
  same option also enables the 12-digit account-id check. Do not read a green scan as "no AWS secret access
  key here" for a key that is not next to an id: the secret half is matched only after its own key name.
- **Four files are exempt at file scope**, listed with reasons in `.secretlintignore`:
  the private-key **redaction** fixtures. The rule matches the PEM *header*, and a real
  key's header is byte-identical to a fixture's, so there is no value to allow that
  would not allow every real key everywhere. The hole is covered from the other side by
  `tests/lint/key-fixture-bodies-are-filler.test.ts`, which asserts those files carry no
  base64 run long enough to be key material.
- **Two values are allowed by pattern** rather than by file, which is the granularity to
  prefer: `https://user:pass@example.com` and a sequential-alphabet `ghp_` dummy. A real
  credential does not match either.
- **History is not scanned.** A credential committed and later removed is still in the git history, and
  rotating it is the only remedy. Staged mode looks at the commit being made and nothing before it.
- **The two modes read a symlink differently.** Tree mode follows the link to its target file on disk; staged
  mode scans the link's own target text, because that is what the commit stores.
- **A bare `npx secretlint` run cannot load the configuration.** The local rule is declared by a `./` id, which
  `scripts/scan-secrets.mjs` resolves against its own root before it creates the engine; the engine's loader
  accepts a package name or an absolute path and nothing relative. Run `npm run security:secrets`.
- **Exact-value allowances: none for the new rules.** The local rule's `allows` list and the AWS rule's are
  empty, and `.secretlintignore` gained no entry. A fixture a new family reports is built at call time instead
  of being allowed. The two existing allowed values above are unchanged, and
  `tests/unit/build/secret-scan-corpus.test.ts` pins them, the ignore list and the order of the rules.
- **It is not a defence against the operator.** Anyone who can run the gate can edit
  `.secretlintignore`.

**If it ever finds a real one**, that is an incident with its own procedure — rotate
immediately, then audit for similar exposure. It is not a line item to allowlist.

### Runtime redaction: what it is, and what it is not

**What it is.** It is best-effort secret-pattern redaction, in one place (`src/lib/logger.ts`, `SECRET_PATTERNS`),
applied on the host before content reaches the audit log, the CLI transport log, the runtime log and the
output channel, the webview's log tail, and the evidence and diagnostics exports. It removes the value of a
key that names a secret (`password`, `passwd`, `pwd`, `secret`, `token`, `client_secret`; in text, and for a
string leaf under such a key in a structured record), the password in URL userinfo (`scheme://user:PASSWORD@host`,
keeping the scheme, the user and the host), the vendor tokens it has a pattern for (including `gho_`, `ghu_`,
`ghs_`, `ghr_` and `npm_`), and private-key blocks across records.

**What stays.** Ordinary content, file paths, and any secret format it has no pattern for stay in the clear:
the log is "redacted for secret patterns, otherwise raw". A keyed value shorter than 8 characters in text is not
removed (so `password: none` stays readable); an array or an object
under a key that names a secret is not replaced as a whole (only a string directly under such a key is), so a
string inside it in a format no pattern knows stays, while a vendor token inside it is still removed by
pattern; the shell's `PWD=` and `OLDPWD=` paths are not secrets and stay;
a count named `TOKEN_COUNT` is removed although it is benign, by a pattern that cannot be narrowed.
**The process-definition export is written without redaction:** the exported document's body does not pass through
the redactor; only the export's audit row does. Treat an exported definition as you would the file it was made from.

**The corpus is the statement.** `tests/fixtures/redaction-corpus.ts` lists 71 synthetic cases (the floor is 40), each with its
category, its expected outcome (redacted, preserved, over-redacted, or unsupported with a reason) and the sinks it
applies to; five tests drive every applicable case through the real writer of each sink and read what it wrote.

**The bounds.** One `sanitize()` call over a 1,048,576-unit line completes in under 250 ms, and over a 16 MiB
artifact in under 4,000 ms, with a full-over-half growth ratio of at most 3.0, on hostile input from fixed seeds
(`tests/perf/sanitize-bounded-work.test.ts`, in `test:perf`). Measured on one machine (Apple M1 Pro, macOS, Node
24.19.0); Linux and Windows are unobserved.

**Detection and redaction are separate mechanisms.** The secret scan above decides what may be committed; the
redactor decides what is written at run time. Neither one's result is evidence about the other.

### What no longer runs, and what it cost

| Withdrawn control | Last observed | Local substitute |
|---|---|---|
| **CodeQL** static analysis (`security-extended`, JS/TS) | **green at `2a885187`, 2026-08-26** | **None.** There is no static-analysis equivalent in this repository. This is a real reduction in coverage, and wiring the secret scan to a real scanner (`FR-R3-109`) does not replace it — a secret scanner finds credentials, not injection or taint |
| Dependency review on pull requests | failure, 2026-08-23 | `npm run security:audit`, operator-invoked. Narrower in two ways: it sees the lockfile rather than the diff, and nothing forces anyone to run it |
| Scheduled `npm audit` (Monday 03:00 UTC) | green at `b6993e80`, 2026-08-24 | The same audit as `npm run security:audit`, operator-invoked. **Not in the attested gate** and on no schedule, so it runs only when someone remembers |
| Release provenance (SBOM, checksums, attestation, GitHub Release) | never ran — no `v*` tag was ever pushed | Partial. `npm run package` reaches `npm run sbom`, so packaging does emit `schegent-sbom.cdx.json`, and it emits no digest. `npm run release` builds once, packages once, inspects those bytes and writes a local release record under `.release/` that names the candidate's SHA-256; it tags, publishes and uploads nothing. Neither emits a signature a consumer could check; `.gate-attestation.json` records that a gate ran on the releasing machine, which is a local record rather than provenance |
| Three-OS matrix and the Node version-floor job | `ci.yml` red at `2a885187` on the **Windows** leg | None. Windows remains a stated permanent limit |

No Snyk or Semgrep configuration or invocation exists in the repository.

What runs *today*, as opposed to what was withdrawn, is generated from the tree
into [current release controls](docs/release/current-release-controls.md). That
page is the single present-tense authority; this section is the security-facing
reading of it, and if the two ever disagree the generated one is right.

#### The SBOM, and what it says is shipped (FR-R4-F09)

`schegent-sbom.cdx.json` is generated from the module graphs the two builds write, joined with
the two lockfiles, and is packaged inside the VSIX. The extension declares **zero runtime
dependencies** and **does ship bundled third-party code**: the webview build bundles the Svelte
runtime (`svelte` today), and the SBOM lists it as `bundled` with `scope: required` although
`svelte` is a `devDependency` of the webview tree. `scope: excluded` means only that a package
is not in the shipped code. A module a graph cannot map to a lockfile entry is listed as unknown
provenance and is never dropped. The shipped files are listed with their SHA-256, and both
`npm run package:smoke` and the release driver compare that list with the archive's `dist/`
entries, so an SBOM left over from another build fails the check.

The document asserts what the graphs and the lockfiles recorded at generation time. It does not
claim that any component is exploitable, anything about licenses beyond the lock's `license`
field, or any signature, and the archive's own bytes are verified by the separate comparison
above.
<!-- Source: scripts/generate-sbom.mjs --><!-- Source: scripts/check-vsix-smoke.mjs -->

#### The static-analysis class is permanently absent — decided 2026-08-27

`FR-R3-115` required this disposition to be taken rather than left open: either name a
local substitute and wire it into the attested chain, or record that the class is gone.
**It is recorded as gone.**

The class CodeQL provided is **taint and dataflow security analysis** — tracking an
untrusted value from a source to a dangerous sink across function and module
boundaries. Nothing in this repository does that, and nothing is planned to.

**What partially overlaps, and why none of it is a substitute:**

| Present | Overlaps | Why it is not the class |
|---|---|---|
| `eslint` + `typescript-eslint` (type-aware rules) | catches some unsafe-`any` flows and floating promises within a file | no cross-procedural taint tracking, no source-to-sink model, no security rule pack |
| `secretlint` (`npm run security:secrets`, wired by `FR-R3-109`) | finds credentials in tracked files | a secret scanner finds credentials, not injection or taint |
| ~148 repository lint gates | enforce boundaries, contracts and shapes | they check structure, not data flow |

Naming any of these a CodeQL substitute would assert coverage that does not exist.
Adding a real one (Semgrep, or CodeQL locally) was considered and **not taken**: it is
a new dependency, a new gate, and a new maintenance surface, and it belongs to whoever
decides the security budget rather than to a documentation-correction cycle.

**What would change this:** a decision to add a local SAST tool, or a CI budget that
makes hosted analysis available again. Until then this is a stated, dated hole and not
an oversight.

<!-- Source: package.json -->
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: docs/release/withdrawn-ci-controls.md -->


## Who reviews security-sensitive changes

**One person. Recorded 2026-08-27 (`FR-R3-120`) as an accepted limit, not as an oversight.**

`.github/CODEOWNERS` routes every path to `@lehoa1806`, and the security-sensitive paths that
follow the catch-all — `src/lib/logger.ts`, `src/audit/`, `src/headless/`, `src/telemetry/`,
`src/runner/claude-cli.ts`, `docs/security/` and this file — resolve to the same reviewer. Since
`FR-R3-099` retired GitHub Actions, that person is also the only enforcement and the only platform
the code has been observed on.

**What this means concretely.** A four-eyes rule and an unbypassable gate are two independent
controls. This project currently has **neither**:

- there is no second reader on any path, so no change is reviewed by someone who did not write it;
- every surviving gate is a `pre-push` hook, which `git push --no-verify` skips and which a clone
  that never ran the `core.hooksPath` command does not have at all.

**Why this is recorded rather than fixed.** There is no second reviewer to name, and naming an
absent one would be worse than stating the fact. `FR-R3-120` T1445 offers "an accepted limit with
its rationale" as a legitimate completion; that is what this is. The failure being closed here is
the *unstated* version — a reader could previously infer from `CODEOWNERS` that review existed
without being told it was one person reviewing their own work.

**What would change it**: a second contributor with commit rights, or a budget for a runner that
enforces without depending on the author choosing to be enforced. `FR-R3-121` treats the first as
partly a documentation problem — a contributor base cannot grow past one person while the entry
cost is 16.6 MB of Markdown with no reading path — and that is why the two items share a cause.
<!-- Source: .github/CODEOWNERS -->
<!-- Source: docs/architecture/distribution-posture.md -->
