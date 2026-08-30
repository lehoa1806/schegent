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

The detailed operator threat catalog covers T1–T27 in [the threat model](docs/security/threat-model.md). It records mitigations and residual risk; it is not a claim that local autonomous execution is safe against every input.

<!-- Source: tests/lint/threat-id-anchor-parity.test.ts -->
<!-- Source: src/runner/prompt-builder.ts -->

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
requests that nothing then checks. There is no remote enforcement point, so a control
outside the gate is a control nothing runs for you.

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
| Secret scan | Every git-tracked file, **including `tests/**`**, scanned by secretlint's recommended ruleset plus the dotenv rule | `scripts/scan-secrets.mjs` via `npm run security:secrets`, inside `npm run gate`. Findings are exempted per entry with a stated reason in `.secretlintignore`, never by excluding a directory. Measured **≈39 s** over 1,947 tracked files. <!-- Source: package.json --><!-- Source: scripts/scan-secrets.mjs --> |
| npm audit | Root and `webview-ui` lockfiles, **operator-invoked** (`npm run security:audit`) | `npm audit --audit-level=low`; it does not auto-fix or commit. **Not in the attested gate**, and the reason is stated rather than left to inference: it queries the npm registry, so a gate containing it would fail for want of a network — and a gate that fails for reasons unrelated to the tree is a gate people learn to bypass with `--no-verify`. Before this item it had no local home at all: the deleted `security-audit.yml` was its only caller. <!-- Source: package.json --> |
| Workflow pin check | Any workflow file that reappears | `scripts/check-workflow-pins.mjs` requires immutable 40-character SHA pins. With no workflows present it reports *nothing to pin* rather than *passed* — a latent guard against a re-added, unpinned workflow. <!-- Source: package.json --><!-- Source: scripts/check-workflow-pins.mjs --> |
| License check | Root manifest and the license operations record | `scripts/check-licenses.mjs` checks that `LICENSE.md` and `docs/operations/licenses.md` exist and that the manifest has a truthy `license` field; it does not inspect dependency licenses. <!-- Source: package.json --><!-- Source: scripts/check-licenses.mjs --> |
| Dependabot | Root and `webview-ui` npm manifests; weekly Monday minor/patch updates; major updates ignored | Still configured, and it opens pull requests — but **nothing runs checks on them any more**. A Dependabot pull request now arrives unverified. <!-- Source: .github/dependabot.yml --> |

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

**What it does now.** secretlint's `preset-recommend` plus `no-dotenv`, over
`git ls-files`, **including `tests/**`**. Roughly **39 seconds** for 1,947 files. Scoped
to tracked files so an untracked scratch file is not read and `node_modules` is never
walked; the previous scan used the same scope and the measurement is why it was kept.

**What it does not do**, because an honest small control beats an implied large one:

- **It is not a general credential detector.** It matches the patterns its ruleset
  carries. A bespoke internal token format is not among them.
- **The AWS rule wants a pair.** A lone `AKIA…` access key id was not flagged in
  testing; a GitHub `ghp_…` token in the same file was. Do not read a green scan as
  "no AWS key here".
- **Four files are exempt at file scope**, listed with reasons in `.secretlintignore`:
  the private-key **redaction** fixtures. The rule matches the PEM *header*, and a real
  key's header is byte-identical to a fixture's, so there is no value to allow that
  would not allow every real key everywhere. The hole is covered from the other side by
  `tests/lint/key-fixture-bodies-are-filler.test.ts`, which asserts those files carry no
  base64 run long enough to be key material.
- **Two values are allowed by pattern** rather than by file, which is the granularity to
  prefer: `https://user:pass@example.com` and a sequential-alphabet `ghp_` dummy. A real
  credential does not match either.
- **It scans the tree, not history.** A credential committed and later removed is still
  in the git history, and rotating it is the only remedy.
- **It is not a defence against the operator.** Anyone who can run the gate can edit
  `.secretlintignore`.

**If it ever finds a real one**, that is an incident with its own procedure — rotate
immediately, then audit for similar exposure. It is not a line item to allowlist.

### What no longer runs, and what it cost

| Withdrawn control | Last observed | Local substitute |
|---|---|---|
| **CodeQL** static analysis (`security-extended`, JS/TS) | **green at `2a885187`, 2026-08-26** | **None.** There is no static-analysis equivalent in this repository. This is a real reduction in coverage, and wiring the secret scan to a real scanner (`FR-R3-109`) does not replace it — a secret scanner finds credentials, not injection or taint |
| Dependency review on pull requests | failure, 2026-08-23 | `npm run security:audit`, operator-invoked. Narrower in two ways: it sees the lockfile rather than the diff, and nothing forces anyone to run it |
| Scheduled `npm audit` (Monday 03:00 UTC) | green at `b6993e80`, 2026-08-24 | The same audit as `npm run security:audit`, operator-invoked. **Not in the attested gate** and on no schedule, so it runs only when someone remembers |
| Release provenance (SBOM, checksums, attestation, GitHub Release) | never ran — no `v*` tag was ever pushed | Partial. `npm run package` reaches `npm run sbom`, so packaging does emit `schegent-sbom.cdx.json`. It emits no digest and no signature a consumer could check; `.gate-attestation.json` records that a gate ran on the releasing machine, which is a local record rather than provenance |
| Three-OS matrix and the Node version-floor job | `ci.yml` red at `2a885187` on the **Windows** leg | None. Windows remains a stated permanent limit |

No Snyk or Semgrep configuration or invocation exists in the repository.

What runs *today*, as opposed to what was withdrawn, is generated from the tree
into [current release controls](docs/release/current-release-controls.md). That
page is the single present-tense authority; this section is the security-facing
reading of it, and if the two ever disagree the generated one is right.

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
