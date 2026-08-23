# Principal architecture, code, security, reliability, and strategy review

**Repository:** Schegent VS Code extension
**Review date:** 2026-08-23
**Reviewed repository commit:** fb60815ed2020e497d600d8d98ed965041d69276
**Reviewed branch:** develop, exactly synchronized with origin/develop at review time
**Review role:** Independent principal architecture, systems, security, performance, SRE, privacy, and developer-experience review
**Release-gate decision:** **Criterion 8 is not met. Keep the engineering-preview label and architecture-expansion freeze.**

## Executive summary

Schegent is a local-first VS Code extension that turns versioned Spec Driven Development definitions into queued, recoverable CLI-backed workflow runs. Its intended users are local developers and small engineering teams operating one trusted workspace, not a remote or multi-tenant control plane. The implemented architecture is recognizable and mostly coherent: the extension host is authoritative, the Svelte webviews are projections, definitions are versioned, run plans are frozen, subprocesses are adapter-driven, and state, ownership, evidence, and recovery have explicit stores.

The repository is also unusually well tested for a pre-1.0 extension. A fresh full local CI pass was green, both dependency audits reported zero known vulnerabilities, package and release mechanics are strong, and the code contains many carefully stated invariants. Those strengths do not close the release gate. Independent adversarial inspection found High-severity defects and architectural risks in the core execution boundary, plus a separate release-evidence gap, that the current test oracles do not exercise:

1. Default Claude execution, and Agy execution, deliberately disable approval prompts without an OS containment boundary.
2. Evidence, transport, diagnostic, input, output, and sidecar paths have symlink and check/use gaps that can cross the stated workspace boundary.
3. Multiple logical-line buffers, write queues, and file readers remain unbounded even though the compressed capture buffer is bounded.
4. Asynchronous child-stdin EPIPE is unhandled and can terminate the extension host; this behavior was reproduced safely with Node 24.
5. Cancellation signals only the direct CLI process, so tool descendants can survive a canceled or timed-out run.
6. Ownership verification and the protected state write are separate operations; overlapping heartbeat/release work can also resurrect a released holder.
7. The sanitizer removes a private-key header but leaves the key body and footer in line-oriented logs.
8. The declared VS Code 1.85 compatibility floor is neither compiled nor integration-tested against that version.

No Critical issue was established. Seven High findings remain release-blocking because they affect containment, host availability, cancellation truthfulness, multi-window correctness, or privacy on ordinary execution paths. The VS Code floor is a separate Medium-severity release-evidence gap: no break on 1.85 was established, but the advertised claim is unqualified. Documentation disclosure of unrestricted execution is valuable, but disclosure changes informed consent, not technical likelihood or impact; it therefore does not reduce that boundary to a non-High risk.

The repository is best characterized as **fundamentally coherent, but not yet safe to expand and materially drifting in documentation and a few critical runtime boundaries**. The right next move is a narrow hardening cycle, not another backend, MCP integration, remote mode, framework rewrite, or larger workflow surface.

## Decision at a glance

| Item | Assessment |
|---|---|
| Critical findings | 0 established |
| High findings affecting core execution | 7 finding groups |
| Additional release-evidence gap | Minimum VS Code compatibility is declared but unqualified |
| Criterion 8 | **Not met** |
| Broad release / external pilot | **Block** |
| New backend, MCP, remote/multi-user, broker, or UI rewrite | **Keep frozen** |
| Local engineering-preview use | Reasonable only by informed operators in trusted workspaces, with the risks in this report accepted |
| Implementation coherence | Mostly coherent, with important boundary failures |
| Test posture | Broad and disciplined, but not adversarial enough at process, filesystem, ownership, and compatibility boundaries |
| Documentation posture | Rich but semantically inconsistent; several operator pages teach retired behavior |

### Stakeholder implications

| Stakeholder | Practical conclusion |
|---|---|
| Maintainers | Stop feature expansion and spend the next cycle on process, filesystem, ownership, and schema/default hardening; the architecture is salvageable without a rewrite |
| New contributors | The code and test tooling are unusually navigable, but current documentation requires knowing which lock/catalog/backend page supersedes another |
| Operators / SRE | Evidence and recovery are rich, but cancellation, ownership, containment, and audit ordering are not yet strong enough for unattended production reliance |
| Security / privacy reviewers | CSP, environment filtering, and supply-chain policy are strong; default agent capability, symlinked host I/O, and incomplete PEM redaction keep residual risk High |
| Product / business | Schegent has a differentiated local SDD orchestration position; a premature external pilot would convert known technical risks into support and trust costs |
| End users | Engineering-preview use can be useful in a trusted workspace, but users must expect provider dependency, local unredacted failure evidence, and potentially broad agent side effects |

The criterion referenced above came from the accepted engineering-preview
release posture formerly recorded at
`docs/architecture/release-posture-engineering-preview.md`: an independent
repeated review must return no Critical and no High finding in core execution.
That source document is absent from the current implementation tree, so this
historical review retains its former path as inline evidence instead of
retargeting the claim to a different decision. H-01 through H-07 keep the
criterion open. H-08 is separately release-blocking until the support claim is
qualified, but is not counted as a demonstrated core-execution High.

## Evidence language and severity model

This report uses the following markers:

- **Observed:** directly supported by source, configuration, tests, command output, or an official source.
- **Inference:** a reasoned consequence of observed behavior. It is not presented as a repository fact.
- **Unknown:** evidence was unavailable or the claim was not exercised.

Severity means:

- **Critical:** immediate, broadly reachable catastrophic compromise or irreversible loss with minimal prerequisites.
- **High:** credible loss of a core security, availability, integrity, privacy, or compatibility guarantee.
- **Medium:** material defect or blind spot requiring a narrower precondition, or with bounded impact.
- **Low:** maintainability, clarity, or defense-in-depth weakness with limited immediate impact.

Confidence rates the evidence, not the severity.

## Scope, method, and limitations

### Reviewed surfaces

The review covered first-party TypeScript and Svelte source, tests, fixtures, scripts, package manifests and lockfiles, VS Code contribution metadata, CI and release workflows, ADRs, threat-model and operations documentation, persistence and migration code, IPC validators, catalog and workflow orchestration, backend runners, evidence sinks, webviews, accessibility tests, packaging policy, and release-posture records.

Generated bundles, coverage output, VSIX contents, and vendored dependencies were excluded from code-quality judgments except when package policy or runtime behavior depended on them.

### Verification snapshot

**Observed:**

- develop was clean and exactly 0 commits ahead / 0 behind origin/develop.
- Node was 24.19.0 and npm was 11.17.0.
- A complete unsandboxed npm run ci finished successfully after an initial sandbox-only loopback failure. The first attempt reached visual testing and failed because the review sandbox prohibited binding 127.0.0.1:4173; that was an environment denial, not an application assertion failure.
- The passing chain included host and webview type checks, lint, default host tests, webview coverage, deterministic evals, 18 visual tests, 14 performance tests, 3 end-to-end tests, build, a 51-file VSIX policy check, and 12 live Electron integration modules.
- Webview coverage was 85.12% statements/lines, 79.58% branches, and 81.24% functions, above its 79/74/76/79 floors.
- Root and webview npm audit --audit-level=low both returned zero known vulnerabilities on 2026-08-23.
- The local package smoke result was 51 files, approximately 958 KB compressed and 2.66 MB uncompressed.

### Missing evidence

**Unknown:**

- GitHub Actions status was not observable from this environment. Local branch synchronization is not evidence that the remote three-OS, Node-22-floor, CodeQL, dependency-review, or scheduled gates are green.
- No fresh host coverage percentage was produced by the local npm run ci path; host coverage is a Linux-only GitHub CI step. The fresh percentage reported here is webview coverage only.
- The review did not run a destructive symlink proof of concept or a live-provider execution.
- Real Claude, Codex, and Agy protocol/authentication compatibility was not exercised; the gated end-to-end tests use fake subprocesses.
- Windows process-tree termination and filesystem behavior were not reproduced locally.
- Accessibility was assessed through source and automated tests, not a manual screen-reader, keyboard-only, or cognitive-accessibility session.
- No maximum-concurrency, maximum-retention, or long-duration production workload profile was captured.

## Phase 1 — comprehension and architecture

### Core objective

Schegent is a VS Code-hosted orchestration control plane for local Spec Driven Development work. Its stated audience is developers and technical leads (PRODUCT.md:7-13). It accepts operator-authored, runtime-only phase/pipeline/workflow definitions, freezes them into queued runs, invokes a selected local CLI backend phase by phase, and persists state, audit evidence, diagnostics, and recovery metadata in or beside the workspace.

Its deployment model is a local VS Code extension host with subprocess-based integrations. The control plane can continue to display and edit local state offline, but most AI execution depends on whichever network/provider behavior the selected CLI requires.

### Implemented system context

~~~mermaid
flowchart LR
  Operator --> WV["Svelte webviews<br/>Sidebar and Dashboard"]
  WV <-->|"Typed IPC and projected snapshots"| Host["VS Code extension host"]

  subgraph HostModules["Authoritative host process"]
    IPC["Contracts, validators,<br/>MessageRouter"]
    Services["Application services<br/>catalog, request, enqueue, drain"]
    Controller["WorkflowController<br/>one RunSession per queue"]
    Runner["Backend registry<br/>Claude, Codex, Agy"]
    Parser["Monitor, stream parser,<br/>outcome classifier"]
    Projectors["UI projectors"]
    IPC --> Services --> Controller --> Runner
    Runner --> Parser --> Controller
    Controller --> Projectors --> IPC
  end

  Runner -->|"shell false; prompt on stdin"| CLI["CLI subprocess"]
  CLI -->|"tools and provider calls"| External["Workspace, child tools,<br/>provider or network"]
  Host --> State["VS Code workspaceState<br/>queues, runs, history, journals"]
  Host --> Catalog[".schegent/catalog<br/>manifest and immutable versions"]
  Host --> Evidence[".schegent evidence<br/>audit, syslog, sessions, transport, rollup"]
  Host --> Ownership[".schegent/ownership<br/>primacy and queue fences"]
  Host --> Recovery["VS Code globalStorage<br/>recovery checkpoints"]
~~~

### Primary data, state, and control flow

~~~mermaid
sequenceDiagram
  actor O as Operator
  participant W as Webview
  participant R as Validator and Router
  participant G as GuardedRunService
  participant S as workspaceState and Queue
  participant D as AutoDrainCoordinator
  participant L as Ownership registry
  participant C as Controller and RunSession
  participant P as PhaseRunner and CLI
  participant E as Evidence sinks
  participant T as Terminal journal

  O->>W: Enqueue request
  W->>R: Typed command plus correlation ID
  R->>R: Shape, trust, primacy, and upstream request checks
  alt Validation, ownership, or lifecycle rejected
    R-->>W: Typed rejection; no queue mutation
  else Intent accepted
    R->>G: Validated scheduling intent
    G->>G: Description, references, lifecycle, and scheduling validation
    G->>S: Persist pending task and optional FrozenRunPlan
    D->>S: Check lifecycle, queue occupancy, and global cap
    D->>L: Acquire and verify queue execution fence
    D->>C: Admit new run or resume
    C->>C: Resolve and deep-freeze pipeline if no frozen plan exists
    C->>S: Persist run and mark task in flight
    loop Each phase and iteration
      C->>P: Frozen definition plus live controls
      P->>E: Required phase-start event
      alt Required evidence cannot be persisted
        P-->>C: Fail closed before phase progress
        C->>S: Pause or fail with recoverable state
      else Backend timeout, cancellation, or failure
        P->>P: Terminate and classify
        P->>E: Failure/cancel evidence and diagnostics
        C->>S: Retry later, pause, or transition terminal
      else Clean classified completion
        P->>P: Stream, monitor, parse, and classify
        P->>E: Transport, transcript, diagnostic, and phase-end evidence
        C->>S: Persist next-phase transition
      end
    end
    C->>T: Persist terminal intent
    T->>S: Commit terminal run, queue finish, and history
    T->>E: Best-effort metrics rollup
    T->>T: Clear terminal intent
    C->>L: Release queue execution lease
    C->>D: Sweep eligible queues
    Note over L: Window primacy remains until host disposal
  end
  opt Activation after an interrupted terminal transition
    T->>T: Replay persisted terminal intent
    T->>S: Repair terminal run, queue, and history projections
  end
~~~

### Subsystems, ownership, and trust boundaries

| Boundary | Owner of truth | Ingress and validation | Material trust assumption |
|---|---|---|---|
| Webview to host | Extension host | Runtime validators in src/ui/sidebar/sidebar-view-provider.ts:128-150, then routing and trust/primacy gates in src/ui/sidebar/message-router.ts:60-110 | A compromised webview must still be treated as untrusted input; several phase-log path fields are not strong semantic identifiers |
| Intent to admission | GuardedRunService and AutoDrainCoordinator | src/services/guarded-run-service.ts:84-90,135-203 and src/services/auto-drain-coordinator.ts:311-389,409-462 | Validation results can become stale before filesystem use |
| Definitions to runs | Catalog and WorkflowRunFactory | Immutable version records, manifest, and deep-frozen snapshot at src/catalog/catalog-store.ts:1-38 and src/services/workflow-run-factory.ts:78-113 | Catalog files and workspace content are operator-controlled |
| Host to CLI | Backend runner | shell is false; prompt is stdin; environment is built from an allowlist by default | Claude and Agy deliberately receive broad unprompted capability; CLI output and descendants are untrusted |
| Host to filesystem | State/evidence/path services | Mix of lexical checks, realpath checks, final-leaf O_NOFOLLOW, and plain path writes | Workspace paths can change after validation and may contain symlinks |
| Window to window | Ownership registry | Exclusive-create generations, holder/fence records, heartbeats | Filesystem replacement and VS Code memento writes do not provide one cross-process transaction |
| Model output to workflow state | Monitor and parser | JSONL parsing, audit block parsing, termination tokens, fatal/rate-limit classification | The same agent whose work is judged emits the evidence that advances the workflow |
| Local control plane to provider | CLI process | Outside host protocol | Provider availability, auth, retention, pricing, and network behavior are not controlled by Schegent |

### Technical approach

**Observed:**

- Host code is strict TypeScript bundled for a VS Code extension; UI code is Svelte 5 and TypeScript built with Vite.
- Host and webview declare no separately installed production npm dependency tree; build/test dependencies and their bundled code still contribute to the shipped VSIX and its supply-chain surface.
- Typed contracts and runtime validators guard IPC, catalogs, settings, workflow state, and evidence records.
- Application flow is service-oriented rather than framework-driven. Constructors and explicit dependencies provide practical inversion of control.
- Queue scheduling is in-process and persistent rather than broker-backed. One RunSession is owned per queue, with a workspace-wide concurrency cap defaulting to 1 and allowing up to 20.
- The catalog is append/version oriented: immutable version record first, mutable manifest second, then pruning.
- State schema is versioned and migrated; the reviewed schema is 13 at src/contracts/state-schema.ts:155-178.
- Terminal transitions use a journal before applying terminal projections at src/services/terminal-transition-coordinator.ts:18-37,52-126.
- Backend adapters share lifecycle logic where possible, but Claude retains a specialized stream path.

### Architectural decisions and trade-offs

| Decision | Benefit | Cost or constraint | Assessment |
|---|---|---|---|
| VS Code host as the control plane | Excellent local ergonomics, no daemon deployment, direct workspace context | Lifecycle tied to extension activation; one host failure takes orchestration and UI down | Appropriate for the stated local product |
| Runtime-only, versioned definitions | Extensible without privileged built-ins; frozen runs are reproducible | Empty-catalog first-run friction; docs must not promise defaults | Strong design, inconsistently documented |
| In-process persistent queues | Low operational burden and fast local feedback | No durable external broker, horizontal scale, or multi-user lease service | Appropriate while remote/multi-user expansion remains frozen |
| Same-working-tree parallelism | No clone/worktree setup; changes are immediately visible | Agents can interfere with each other's files and git state | Keep default cap at 1; require worktree isolation before broader concurrency |
| Structured audit required, raw evidence best-effort | Progress is evidence-bearing while storage failure can degrade diagnostics | Audit is an ordinary mutable file; raw privacy/correctness paths differ | Good layering, but current sinks are not safely contained |
| Multi-backend registry | Clear extension seam and operator choice | Permission, output protocol, session, model, and effort semantics differ by backend | Useful seam; do not add another backend until the shared contract is hardened |
| Documented unprompted Claude/Agy execution | Enables unattended workflow operation | Removes human approval without adding equivalent OS isolation | High accepted risk; disclosure is not mitigation |

## Documentation assessment

| Document | Purpose | Strengths | Gaps | Staleness risk | Missing critical information |
|---|---|---|---|---|---|
| README.md | Product overview and first orientation | Correctly states zero shipped definitions, concurrent queues, three backends, empty catalog, versioned catalog, and the backend permission boundary at lines 19-23, 46-56, 74-83, 142-155, 267-275,317-333 | Top description and package description remain Claude-only; one section implies definitions are settings; on-disk tree omits current ownership/transport/rollup artifacts | High | Exact persistence tree, last-qualified backend/platform versions, and supported VS Code evidence |
| ARCHITECTURE.md | Normative system design | Strong trust-boundary, ownership, state, and reliability intent | Lists nonexistent src/engine at lines 62-85 and later says it was removed at 129-140; labels queue registry single-active-run; says environment inheritance is default despite package default allowlist | High | A mechanically generated current module map and one unambiguous source of defaults |
| docs/README.md | Documentation index | Broad navigation and useful topic taxonomy | Advertises built-in phases, one-run lock semantics, Claude-only execution, and a default pipeline at lines 35-41,113-120 | High | Current-definition and multi-queue conceptual entry point |
| docs/concepts/architecture-overview.md | Conceptual architecture | Explains local evidence and control flow | Describes run-scoped single locking and no parallelism at lines 61-70,92-97; contradicts itself on tamper evidence | High | Dual ownership, current catalog, and accurate audit assurance |
| docs/concepts/workspace-lock.md | Ownership model | Accurately explains primacy, per-queue leases, pause retention, and multiwindow behavior at lines 17-68 | Correct content competes with older contradictory pages | Medium | A supersession banner pointing readers away from old terminology |
| docs/concepts/queue-and-runs.md | Queue/run behavior | Later sections describe current multi-queue capacity | Opens with single queue and says pause frees its queue slot at lines 3,25-32 | High | Accurate paused-run occupancy and global-cap semantics |
| docs/getting-started/first-pipeline.md | Onboarding | Correct empty-catalog prerequisite and example import | Says a lock is acquired per run and prevents concurrent runs at lines 30-40,108-115; remains Claude-centric | High | Backend choice, dual leases, and uncontained-execution consent |
| docs/reference/file-layout.md | Persistence reference | Attempts exhaustive operator mapping and includes an ownership directory | Omits the catalog, describes ownership as window primacy rather than per-queue execution resources, and reports schema 6 at lines 25-26,263-268 while code is schema 13 | High | Current paths, resource semantics, retention, sensitivity, atomicity, and recovery owner per file |
| docs/reference/settings.md | Configuration reference | Raw transcript modes are accurately described at lines 547-577 | Other pages do not inherit the same defaults | Medium | Generated parity with package/schema/UI fallbacks |
| docs/operations/schedule-multiple.md and intervention.md | Scheduling and recovery runbooks | Useful operational intent | Teach one-workflow/run-scoped-lock semantics and a nonexistent event; pause/cancel ownership claims are wrong | High | Current capacity accounting, lease tenure, and verified event names |
| docs/operations/backends.md | Backend troubleshooting | Publishes adapter expectations and supported bands | Says Claude probes transport though code removed it; says Agy maps xhigh/max to high though src/runner/agy-cli.ts:10-19 throws | High | Last-qualified CLI versions and automated canary status |
| SECURITY.md and docs/security/threat-model.md | Security boundary and non-defenses | Candidly identifies powerful agents, prompt-injection exposure, local evidence, and non-compliance audit | SECURITY says raw transcripts are always written and omits Agy in scope; threat model contains overbroad statements that other workspaces cannot be affected | High | Symlink/confused-deputy paths, descendant-process behavior, and sanitizer limits |
| ADRs | Decision history | Unusually explicit scope, alternatives, limitations, and re-evaluation triggers | Older accepted records retain present-tense falsehoods; local-parallelism record says no fencing tokens after fencing landed | Medium | Formal supersedes links and a concise current-state decision index |
| CONTRIBUTING.md and RELEASE.md | Contributor and release procedure | Extensive commands, packaging, provenance, and release sequencing | Contributor install uses mutable nested npm install; release's exact-SHA full-gate dependency is procedural | Medium | Minimum supported VS Code qualification and automated release gate binding |

## Phase 2 — implementation reality check

### Structural scan

**Observed:**

- The repository contains 412 first-party host TypeScript files and roughly 353,000 TypeScript/Svelte/script lines across src, webview-ui/src, tests, and scripts.
- Test inventory is exceptionally large: approximately 383 unit, 158 integration, 98 lint/invariant, 19 contract, 5 parity, 5 performance, 1 end-to-end suite, 1 eval corpus, plus Playwright visual specifications.
- Layering is visible: contracts/config/state/catalog/services/controller/runner/monitor/audit/UI modules have recognizable ownership.
- The largest host files are structural risk concentrations: src/state/workspace-state.ts is about 2,512 lines, src/queue/queue-manager.ts about 1,820, src/extension.ts about 1,333, src/services/run-driver.ts about 1,159, and src/controller/workflow-controller.ts about 968.
- Host/webview snapshot contracts are duplicated across src/ui/sidebar/snapshot.ts and webview-ui/src/lib/snapshot-types.ts; the raw-transcript fallback drift proves those mirrors can diverge.
- Six shipping Svelte components are deliberately recorded as unreachable: HoverText, ControlPanel, QueueList, PhaseTracker, LiveActivityHeader, and StatusHeader. webview-ui/vitest.config.ts:41-68 classifies 407 statements as dead rather than merely untested.
- No Dockerfile, devcontainer, remote service, database, or deployment manifest is part of the product surface. That matches the local VS Code deployment model; it is a portability option, not missing server infrastructure.
- No production circular-dependency failure was reported by the repository's checks. This review did not independently prove the complete import graph acyclic.

### Coherence conclusion

The repository is **fundamentally coherent, with significant drift and several unsafe boundary implementations**. It is not structurally inconsistent: requests, scheduling, runs, phases, evidence, ownership, and projections have legible owners. The problem is that some boundary guarantees are stronger in comments and documents than the actual syscall, subprocess, or cross-window commit point.

### Architecture drift register

| Type | Intended design | Observed reality | Evidence | Impact | Severity | Recommended fix |
|---|---|---|---|---|---|---|
| Doc Drift | Window primacy plus per-queue execution leases | Several concepts/onboarding/runbooks still describe one run-scoped workspace lock | docs/concepts/architecture-overview.md:61-70,92-97; docs/getting-started/first-pipeline.md:30-40,108-115; src/state/lock.ts:33-50 | Operators misunderstand capacity, pause, cancellation, and multiwindow recovery | High | Make workspace-lock.md canonical; add forbidden-phrase semantic checks and supersession banners |
| Doc Drift | Runtime-only versioned definitions, no built-ins | Docs index and concepts promise built-in phases/default pipeline | README.md:19-23,142-155 versus docs/README.md:35-41,113-120 | Broken onboarding expectations and invalid support guidance | High | Rewrite entry points from the catalog source of truth |
| Operational Drift | Raw transcripts default to errors-only; invocation timeout defaults to 5400 seconds | Security/concept docs and idle mirrors report always; webview idle timeout reports 1800 | package.json:208-213,280-289; src/config/general-settings.ts:155-160,291-296; src/ui/sidebar/snapshot.ts:1150-1203; webview-ui/src/lib/snapshot-types.ts:1064-1128 | Misleading privacy UI, retention guidance, and timeout projection | Medium | Generate defaults from one schema and test every projection |
| Design Drift | Containment is enforced at use | Some paths are lexical, some check only the leaf, and log targets cache positive realpath verdicts | src/services/run-request/workspace-containment.ts:40-55; src/lib/runtime-log/runtime-log-sink.ts:195-214; src/monitor/cli-transport-sink.ts:302-311 | Host follows workspace-controlled symlinks outside the boundary | High | Introduce one FD-based safe-open primitive and migrate every sink/source |
| Design Drift | Fencing rejects stale writes at point of effect | Advisory-mirror verification and write are separate; ordinary Run effects do not carry the fence; heartbeat can overlap release | src/state/workspace-state.ts:726-780; src/state/lock.ts:221; src/state/execution-lease.ts:189-215,256-308 | Proven stale mirror/holder resurrection and inferred stale Run mutation after lease loss | High | Use an atomic commit protocol or fence every stored snapshot and reject stale generations |
| Boundary Drift | Privacy mode controls retention only | Absence of output sink changes wait-for-close behavior | src/runner/child-completion.ts:11-79; src/runner/process-lifecycle-runner.ts:95; src/audit/raw-transcript-writer.ts:245-285 | off mode or capture failure can lose late semantic output | Medium | Always wait for close with bounded grace, independent of capture |
| Boundary Drift | Bounded capture bounds memory | Monitor remainders, Claude line buffer, transport promises, whole-file reads, and tail deltas are separate and unbounded | src/monitor/claude-cli-monitor.ts:194-246,512-519; src/runner/claude-cli.ts:337-444; src/services/phase-log/phase-log-reader.ts:92-149 | Backend/workspace output can exhaust the host | High | One bounded streaming/framing layer with byte budgets and backpressure |
| Operational Drift | Application-scoped CLI settings can be edited in product UI | General settings writes every key to ConfigurationTarget.Workspace | package.json:129-191; src/config/general-settings.ts:485-553 | Real VS Code can reject or fail to apply CLI path edits | Medium | Route application settings to Global; integration-test with real VS Code |
| Operational Drift | VS Code 1.85 is supported | Types resolve to 1.118 and integration downloads latest stable only | package.json:9-12,437-440; package-lock.json:2089-2094; tests/integration/runTest.ts:38-40 | A package may pass every gate and still be incompatible with its untested floor; no break was established | Medium | Pin floor types and add floor/latest integration, or raise the manifest floor |
| Doc Drift | Current backend behavior is supportable | Backends guide documents removed Claude probing and nonexistent Agy effort downgrade | docs/operations/backends.md:14-16; src/runner/claude-cli.ts:146-148; src/runner/agy-cli.ts:10-19 | Troubleshooting directs users toward behavior they will not receive | Medium | Generate a backend capability table from adapter contract tests |
| Doc Drift | Persistence reference is exhaustive | Catalog omitted; ownership files are described as window-primacy artifacts rather than per-queue execution resources; schema is reported as 6 | docs/reference/file-layout.md:3-38,263-268; src/contracts/state-schema.ts:155-178 | Recovery, retention, and incident response are error-prone | High | Generate paths/schema number, resource semantics, and sensitivity classifications |

### Runtime, build, and release surface

**Observed strengths:**

- Two lockfile-v3 dependency trees are committed. CI installs both with npm ci --ignore-scripts, reducing lifecycle-script exposure at .github/workflows/ci.yml:35-44.
- CI declares an Ubuntu/macOS/Windows matrix and a separate Node 22.23.2 floor leg at .github/workflows/ci.yml:17-24,100-132.
- Actions are SHA-pinned. Permissions are read-only by default and widened only for the release job.
- Release verifies tag/version parity, repeats build/package/integration policy, generates a CycloneDX SBOM and SHA256SUMS, attests the VSIX and SBOM with OIDC provenance, and publishes durable release assets at .github/workflows/release.yml:37-68,84-168,181-212.
- The package smoke check enforces an exact file allowlist, path safety, and size budgets.

**Observed gaps:**

- .github/workflows/release.yml runs verify:all, build, package smoke, and integration, but does not mechanically require the exact commit's complete eval/e2e/perf/visual/full-coverage gate. RELEASE.md makes that a human assertion.
- ci.yml and pr.yml duplicate much of the same three-OS PR work; full-gate commentary no longer matches the actual split. This is cost/maintenance debt rather than a safety failure.
- Root postinstall launches a nested mutable npm install while CI deliberately uses two immutable npm ci operations.
- The advertised VS Code floor is unqualified, as described above.

## Phase 3 — deep code and control-boundary review

### Engineering strengths

The following are material strengths, not merely absence of findings:

- Incoming sidebar messages are runtime-validated before dispatch, and mutating commands pass workspace-trust and primary-host gates.
- Webview CSP is restrictive: default-src none, nonce-only scripts, styles restricted to the webview source or a nonce, and connect-src none at src/ui/sidebar/csp.ts:13-23. No production innerHTML, eval, new Function, or Svelte raw-HTML use was found.
- Backend processes use shell false and receive prompts on stdin instead of interpolated shell command lines.
- The default environment mode is allowlist, not ambient inheritance; package.json:141-160 and src/runner/spawn-env.ts:53-91 limit accidental forwarding of cloud, registry, and signing credentials.
- Definition versions and run snapshots are validated and frozen before execution.
- Terminal transition journaling, recovery checkpoints, queue repair, migrations, and required phase evidence provide substantially better crash recovery than a typical local extension.
- Structured audit payload projection is bounded and sanitizer mutations can cause rejection instead of silently changing a protected payload.
- Release supply-chain controls are unusually mature: no manifest-declared or separately installed production npm dependency tree, ignored install scripts in CI, SHA-pinned actions, exact VSIX policy, SBOM, checksums, and provenance attestation. Bundled third-party code still forms part of the shipped artifact and supply-chain surface.

### Top findings

| ID | Severity | Confidence | Finding | Primary evidence |
|---|---|---|---|---|
| H-01 | High | High | Default Claude and Agy execution disables approval prompts without equivalent OS containment | package.json:162-171; src/runner/claude-cli.ts:238-242; src/runner/agy-cli.ts:40-47 |
| H-02 | High | High | Host filesystem operations can follow ancestor/replaced symlinks outside the intended workspace boundary | src/audit/audit-log-writer.ts:107-109,216-235; src/lib/runtime-log/runtime-log-sink.ts:195-214; src/services/run-request/workspace-containment.ts:40-55 |
| H-03 | High | High | Output and diagnostic caps are bypassed by unbounded logical-line buffers, write queues, and whole-file reads | src/monitor/claude-cli-monitor.ts:194-246,512-519; src/runner/claude-cli.ts:337-444; src/services/phase-log/phase-log-reader.ts:92-149 |
| H-04 | High | High | Asynchronous child stdin EPIPE has no listener and can terminate the extension host | src/runner/process-lifecycle-runner.ts:55-65; src/runner/claude-cli.ts:298-308; independent Node 24 reproduction |
| H-05 | High | High | Cancel/timeout/deactivation terminates only the direct CLI, not its tool-process descendants | src/runner/process-lifecycle-runner.ts:132-139; src/runner/claude-cli.ts:573-590; src/runner/child-completion.ts:11-19 |
| H-06 | High | Medium | Advisory-mirror verification is separate from write, ordinary Run effects do not carry the fence, and release can overlap heartbeat | src/state/workspace-state.ts:749-780; src/state/ownership-registry.ts:238-306; src/state/execution-lease.ts:189-215,256-308 |
| H-07 | High | High | Private-key sanitization removes only the PEM header and preserves reconstructable body/footer lines | src/lib/logger.ts:32-36,130-135; tests/unit/lib/logger.test.ts:104-125 |
| H-08 | Medium release-evidence gap | High | VS Code 1.85 is declared but compile types and integration tests use newer/latest versions; an actual floor break is Unknown | package.json:9-12,437-440; package-lock.json:2089-2094; tests/integration/runTest.ts:38-40 |

### High finding H-01 — unrestricted agent execution is the default boundary

**Severity:** High
**Confidence:** High
**Classification:** Observed design plus inferred impact; core execution; release blocker

**Observed:** package.json:162-171 defaults the backend to Claude and explicitly says it is spawned with --dangerously-skip-permissions. src/runner/claude-cli.ts:238-242 adds that flag. src/runner/agy-cli.ts:40-47 does the same for Agy. Codex is the exception and requests workspace-write sandboxing at src/runner/codex-cli.ts:25-32. docs/concepts/unprompted-agent-not-contained.md and the threat model disclose that tool approval is disabled and that sideEffects metadata is consent/checkpoint information, not enforcement.

**Inference:** A prompt-injected or mistaken Claude/Agy process can exercise the OS-user capabilities available to its tools, including files outside the workspace and network/provider actions. Workspace Trust and an operator's initial run approval reduce accidental invocation; neither mediates each subsequent tool action. The capability already exists, so model-reported side-effect declarations do not form a ceiling.

**Unknown:** Provider-side protections, CLI-specific containment, and enterprise host controls may reduce exposure in a particular installation. They are not enforced or verified by Schegent.

**Why disclosure does not close the risk:** Clear disclosure is necessary for informed consent, but severity is based on reachability and consequence. The default core path remains an unprompted agent with no product-enforced OS boundary.

**Required response:** Before broader release, either default to a genuinely mediated/sandboxed execution provider, introduce a capability broker with explicit policy and audit, or make uncontained backends a separately enabled expert mode with unmistakable per-run consent. Do not add MCP tools before this ceiling is enforceable.

### High finding H-02 — filesystem containment can be bypassed through symlinks and check/use gaps

**Severity:** High
**Confidence:** High; individual exploit feasibility varies by path and platform
**Classification:** Observed implementation plus inferred confused-deputy impact; core execution; release blocker

**Observed default evidence path:**

- AuditLogWriter constructs workspace/.schegent/audit.log lexically at src/audit/audit-log-writer.ts:107-109 and uses plain mkdir/appendFile at 216-235. Append has no containment check.
- ensureSchegentGitignore follows .schegent and .gitignore path components at src/audit/schegent-gitignore.ts:22-39.
- CliTransportSink caches a positive containment verdict and explicitly documents that mid-session replacement remains accepted at src/monitor/cli-transport-sink.ts:302-311; it later writes through ordinary path calls at 399-420.
- RuntimeLogSink documents the same positive-cache window at src/lib/runtime-log/runtime-log-sink.ts:195-214 and appends at 455-487.
- VerboseDiagnosticWriter recursively creates and appends lexically composed, intentionally unredacted diagnostic paths at src/audit/verbose-diagnostic-path.ts:77-111 and src/audit/verbose-diagnostic-writer.ts:33-74.
- The shared containment helper explicitly acknowledges adjacent check-to-use TOCTOU at src/lib/path-containment.ts:33-37.

**Observed input/output/sidecar path:**

- resolveWithinWorkspace is lexical at src/services/run-request/workspace-containment.ts:40-55.
- Local-file validation uses O_NOFOLLOW for the final leaf, but intermediate directories can still be symlinks at src/services/run-request/local-input-validator.ts:153-175.
- Output validation and completion are lexically contained at src/services/run-request/output-target-validator.ts:91-148 and src/services/run-output/run-output-resolver.ts:65-95.
- Output collision identity is also lexical at src/services/run-request/output-target-validator.ts:99-111, so two symlink aliases to one real target can evade duplicate-output rejection.
- The phase sidecar protects only the final phase-message.env leaf; workspace-controlled ancestors remain traversable at src/controller/phase-sidecar-reader.ts:17-35,236-296.
- Raw transcript containment occurs after some directory/gitignore effects at src/audit/raw-transcript-writer.ts:397-421.

**Concrete paths:**

1. A pre-existing workspace/.schegent symlink to an external directory causes the next audit append to target the external audit.log. This does not need a race.
2. A transport or runtime log target can be validated once, replaced with a symlink, and then followed on subsequent writes because the positive verdict is cached.
3. workspace/linkdir can point outside while linkdir/file.md is a regular final leaf; final-leaf O_NOFOLLOW does not reject the linked ancestor.
4. A diagnostics or sidecar ancestor can be replaced while the final file remains regular.

**Inference:** This can corrupt or append to OS-user-writable files outside the workspace. It is particularly important for Codex: a workspace-confined model may be able to place a symlink which the more-privileged extension host later follows, turning the host into a confused deputy. This review did not establish arbitrary command execution from the constrained log record format.

**Required response:** Build one safe filesystem primitive at the actual syscall boundary. Walk trusted directory handles, reject symlinks at every component, open final targets with O_NOFOLLOW, verify with fstat, and retain the verified descriptor for writes. For absent outputs, canonicalize the nearest existing ancestor and use canonical identity for collision detection. Never cache a positive verdict for a mutable pathname. Apply the primitive to reads, writes, rename/promotion, mkdir/gitignore setup, sidecars, and output completion.

### High finding H-03 — nominal output caps are bypassed by unbounded buffers, queues, and reads

**Severity:** High
**Confidence:** High
**Classification:** Observed implementation plus straightforward availability impact; core execution; release blocker

**Observed:**

- ZippedStreamBuffer correctly limits each compressed capture stream to 64 MiB at src/runner/zipped-stream-buffer.ts:19-72.
- ClaudeCliMonitor separately concatenates unbounded stdout/stderr remainders at src/monitor/claude-cli-monitor.ts:194-246. splitLines retains the complete string if no newline appears at 512-519.
- Claude's specialized runner holds another unbounded stdoutLineBuffer and appends character-by-character at src/runner/claude-cli.ts:337-444.
- Verbose mode retains one promise per diagnostic chunk until exit at src/runner/claude-cli.ts:392-459.
- CliTransportSink creates a closure/promise/string per completed line and has no pending-byte high-water mark at src/monitor/cli-transport-sink.ts:331-360.
- Monitor terminal states remain in a long-lived map until extension disposal at src/monitor/claude-cli-monitor.ts:265-325,440-449.
- Phase sidecar calls readFile before applying the 4 KiB limit at src/controller/phase-sidecar-reader.ts:260-310.
- Phase-log read loads the whole stream.jsonl before keeping 500 entries at src/services/phase-log/phase-log-reader.ts:92-149.
- Tail allocates the entire new file delta at once at src/services/phase-log/phase-log-tail-session.ts:90-125; its parser concatenates the prior partial and splits to an array at src/services/phase-log/phase-log-jsonl-parser.ts:11-39.

**Failure scenarios:**

- One large newline-free JSONL record grows two independent logical-line buffers even after compressed capture truncates.
- A fast producer of many short lines creates an unbounded disk-write backlog.
- A model writes a huge sidecar or diagnostic file; the host allocates it before learning it violates the post-read limit.
- The workspace concurrency cap can multiply per-invocation exposure up to 20, although the safe default of 1 reduces normal amplification.

**Required response:** Use one bounded incremental framing layer, enforce a maximum logical-line and remainder byte size, stream/tail files in fixed chunks, stat before bounded reads, and retain only a bounded byte queue. Expose dropped/truncated bytes as structured health evidence. Add aggregate memory budgets across concurrent runs.

### High finding H-04 — asynchronous stdin failure can terminate the extension host

**Severity:** High
**Confidence:** High
**Classification:** Observed and independently reproduced; core execution; release blocker

**Observed:** Generic runners write and end stdin inside a synchronous try/catch at src/runner/process-lifecycle-runner.ts:55-65. Claude does the same at src/runner/claude-cli.ts:298-308. Neither installs an error listener on child.stdin before writing.

**Reproduction:** The primary reviewer ran this safe standalone Node 24 command:

~~~sh
node -e "const {spawn}=require('node:child_process'); const c=spawn('/usr/bin/true',[],{stdio:['pipe','ignore','ignore']}); c.stdin.write(Buffer.alloc(8*1024*1024)); c.stdin.end();"
~~~

It emitted asynchronous write EPIPE as an unhandled error and exited with status 1. A synchronous try/catch cannot intercept a later Writable error event.

**Inference:** A backend which starts and then exits early or closes stdin while a large prompt is queued can terminate the VS Code extension host. The permitted request/process document sizes make pipe-buffer overflow realistic.

**Required response:** Install the stdin error handler before the first write, use end(prompt, callback) or a properly awaited write path, and route the failure into the invocation result. Add a real child fixture that closes stdin immediately; the test must prove no uncaughtException/unhandled error and no host termination.

### High finding H-05 — cancellation does not terminate the backend process tree

**Severity:** High
**Confidence:** High; backend self-cleanup is Unknown
**Classification:** Observed implementation plus inferred side-effect continuation; core execution; release blocker

**Observed:** ProcessLifecycleRunner sends SIGTERM and later SIGKILL only to its direct ChildProcess at src/runner/process-lifecycle-runner.ts:132-139. Claude uses the same direct-child strategy at src/runner/claude-cli.ts:573-590. Spawns do not establish a POSIX process group or Windows Job Object. waitForChildCompletion explicitly handles descendants retaining inherited stdio by destroying only local pipe readers after a grace period at src/runner/child-completion.ts:11-19,57-64.

**Inference:** A CLI tool descendant can continue mutating the workspace after the parent is canceled, timed out, paused aggressively, or the extension deactivates. Schegent may then record a canceled/terminal phase while side effects continue and race rollback, retry, recovery, or the next phase.

**Required response:** Own the process tree. On POSIX, create and safely signal a dedicated process group/session. On Windows, use a Job Object or a well-audited equivalent. Finalize only after the group is gone or record an explicit degraded terminal state stating descendants may remain.

### High finding H-06 — ownership fencing is not atomic with the protected state change

**Severity:** High
**Confidence:** Medium
**Classification:** Observed race window plus reasoned interleavings; core concurrency; release blocker while multiwindow is supported

**Observed:**

- WorkspaceStateStore.writeGuarded verifies or heartbeats a claim and then separately awaits the supplied write at src/state/workspace-state.ts:749-780.
- A source search found one production caller, the primacy heartbeat at src/state/lock.ts:221. Its callback writes the advisory KEYS.lock mirror, not queue/run state; therefore the directly demonstrated verify-then-write race is a stale advisory-mirror write.
- Ordinary queue/run mutations do not use writeGuarded or carry a fence into each memento commit. Their ownership check is a separate preflight/admission condition, leaving a distinct point-of-effect gap if ownership changes during later work.
- Ownership heartbeat and release are read-judge-replace operations without cross-process compare-and-swap at src/state/ownership-registry.ts:238-306.
- Execution heartbeat snapshots local fences, awaits registry mutation, then updates its mirror at src/state/execution-lease.ts:189-215.
- Release clears the local fence and writes release state at src/state/execution-lease.ts:256-266.
- Timer callbacks are fire-and-forget at src/state/execution-lease.ts:304-308 and src/state/lock.ts:257; release does not drain an already-running heartbeat.

**Reasoned interleavings:**

1. Window A verifies fence N for the advisory mirror and stalls. A expires or releases; B acquires N+1. A resumes and writes a stale KEYS.lock mirror because verification and effect are not one transaction. This mirror is advisory, so this interleaving alone does not establish duplicate execution.
2. A heartbeat reads a valid holder. Concurrent release writes holder null. The delayed heartbeat then replaces the record with A and rewrites the mirror, resurrecting the claim until it becomes stale again.
3. Because queue/run effects do not carry their execution fence, a Run which stalls and loses its lease can in principle resume later mutation before another ownership check. Continuing stale mutation or duplicate execution is an inference from the missing point-of-effect guard, not a reproduced outcome in this review.

**Unknown:** Exact VS Code memento serialization across processes and filesystem behavior can change timing, but they cannot make two visibly separate operations atomic.

**Required response:** Choose an authoritative atomic protocol. Options include a CAS-capable store/lock around ownership and state commit, or storing the fence with every mutable snapshot so readers reject older generations. Add a local closing epoch, await in-flight heartbeat work before release, and force all three interleavings with deferred test seams.

### High finding H-07 — private-key sanitization preserves the secret body

**Severity:** High
**Confidence:** High
**Classification:** Observed privacy/security defect; default evidence path; release blocker

**Observed:** The standalone PEM regex at src/lib/logger.ts:32-36 matches only the BEGIN PRIVATE KEY marker. sanitize directly replaces matches at 130-135, so the base64 body and END marker survive. Unit tests at tests/unit/lib/logger.test.ts:104-125 assert only that the BEGIN marker disappeared. CliTransportSink sanitizes already split lines at src/monitor/cli-transport-sink.ts:370-373, so even a future multiline expression would not protect that sink without state.

**Concrete example:** If a CLI emits a complete OpenSSH private key, the first line becomes REDACTED while all reconstructable key material remains in the following log lines.

The expression also omits BLOCK from the standard PGP PRIVATE KEY BLOCK marker, while the test uses a nonstandard marker at tests/unit/lib/logger.test.ts:120-125. A standard PGP private-key block may therefore receive no header redaction at all.

**Required response:** Whole-string sinks must replace the complete matching BEGIN-to-END block. Line-oriented sinks need bounded per-stream redaction state that suppresses every line until the matching END marker; EOF or a cap before END must redact conservatively. Tests must assert absence of body and footer across chunk and line boundaries.

### Release-evidence finding H-08 — the advertised VS Code floor is not qualified

**Severity:** Medium
**Confidence:** High on the missing gate; actual runtime incompatibility is Unknown
**Classification:** Observed gate gap; release blocker, not a demonstrated core-execution defect

**Observed:** package.json:9-12 declares VS Code ^1.85.0. The @types/vscode declaration uses a caret and package-lock.json:2089-2094 resolves 1.118.0. tests/integration/runTest.ts:38-40 downloads the latest stable VS Code when no version is supplied; the local run used 1.134.0. CI matrices operating system and Node, not minimum VS Code. esbuild.config.mjs:11-13 targets a runtime below the declared Node 22 engine floor without demonstrating that the target matches the extension-host runtime bundled in VS Code 1.85.

**Inference:** A newer API call, type surface, or emitted runtime construct may pass all current gates yet fail activation or execution on the declared minimum. This review did not identify a concrete incompatible call or reproduce a failure on 1.85.

**Required response:** Pin compile-time VS Code types to the minimum supported API and run integration on both the floor and latest stable, or raise engines.vscode to the oldest version actually qualified. The package claim and executable evidence must agree before release.

### Material Medium findings

| ID | Finding | Evidence | Impact | Confidence | Action |
|---|---|---|---|---|---|
| M-01 | Transcript off or capture failure changes subprocess completion semantics | src/runner/child-completion.ts:11-79; src/runner/process-lifecycle-runner.ts:95; src/runner/claude-cli.ts:478; src/audit/raw-transcript-writer.ts:245-285 | Late stdout can be lost, including result/session markers; a privacy choice changes correctness | High | Always wait for close with bounded grace, independent of output sink |
| M-02 | Audit append timeout does not cancel the append | src/audit/audit-log-writer.ts:216-235 and write chain at 171-203 | A late append can race rotation/later appends and reorder evidence after failure was reported | High | Keep an internal serialization barrier until the underlying append settles |
| M-03 | Run Request has no total/count/value byte budget | src/contracts/validators/run-request-shape.ts:26-129; src/services/run-request/run-request-validator.ts:211-234,361-430 | IPC, frozen state, prompt memory, stdin, tokens, and cost can be amplified | High | Enforce UTF-8 byte, item-count, and aggregate request budgets before persistence |
| M-04 | In-flight phase-log selectors are semantically weak | src/contracts/validators/phase-log.ts:39-95; src/services/phase-log/phase-log-service.ts:109-129; src/activation/phase-log-tail-wiring.ts:145-169 | Forged webview tuples or symlinked legitimate paths can select unintended files | Medium | Derive IDs from host-side frozen run; validate strict path-segment grammar |
| M-05 | Application-scope settings are written at workspace scope | package.json:129-191; src/config/general-settings.ts:485-553 | CLI path edits exposed by the UI may be rejected by real VS Code | High | Split write targets by declared scope and test against real API behavior |
| M-06 | Idle/default mirrors drift | Raw transcript falls back from errors-only to always; webview idle invocation timeout is 1800 while package/host use 5400: package.json:208-213,280-289; src/config/general-settings.ts:155-160,291-296; src/ui/sidebar/snapshot.ts:1150-1157; webview-ui/src/lib/snapshot-types.ts:1064-1128 | Misleading privacy display and timeout behavior during idle/error projections | High | Generate defaults and parity tests from one source |
| M-07 | The model can self-certify a clean transition | src/parser/stdout-parser.ts:172-200,284-421; src/controller/phase-runner.ts:493-569 | Prompt injection or model error can emit the token/audit that advances the phase; clean nonzero exits can proceed | High | Separate trusted mechanical evidence from model assertions; require host-verifiable checks for sensitive gates |
| M-08 | Eval coverage is deterministic parser coverage, not model behavior evaluation | tests/evals/backend-outcome-corpus.test.ts:97-173 | Prompt/tool regressions, cost drift, and provider behavior are invisible | High | Add isolated scheduled canaries and versioned behavioral scenarios; keep PR tests deterministic |
| M-09 | Release does not mechanically bind to an exact-SHA full gate | RELEASE.md:37-44; .github/workflows/release.yml:69-90 | A tag can publish after a stale or unrelated full-gate run | High | Promote an artifact from, or require checks for, the exact release commit |
| M-10 | Long-lived monitor/transcript maps retain completed run state | src/monitor/claude-cli-monitor.ts:265-325,440-449; src/audit/raw-transcript-writer.ts:210-216,289-351 | Extension-host memory grows over long sessions | High | Delete settled entries or use bounded retention |

### Code quality and modularity

**Observed:** Naming is generally precise, comments often record the invariant and failure mode, functions use explicit result unions, and tests mirror operational rules. The codebase has avoided a generic framework/service-locator layer and instead uses concrete services with constructor dependencies. These are maintainability strengths.

**Observed risk:** Several files have become coordination hubs:

- workspace-state.ts combines schema migration, persistence, ownership access, guarded writes, and a very large method surface.
- queue-manager.ts owns a large set of transitions and repair behavior.
- extension.ts composes many long-lived services and lifecycle hooks.
- run-driver.ts and workflow-controller.ts coordinate enough policy that state-transition reasoning spans multiple large files.
- host and webview snapshot types duplicate a wide contract surface.

**Inference:** The problem is not raw line count by itself. It is that concurrency, persistence, and orchestration changes require reasoning across multiple high-churn hubs. The source-LOC budget test ratchets growth, but a high-water mark cannot establish cohesion.

The six unreachable Svelte components above are confirmed dead-code inventory, not a coverage artifact. Keeping them instrumented makes the debt visible, but deletion after one import/package verification pass is preferable to indefinite classification.

**Recommendation:** Remove confirmed dead components, extract pure transition functions and small repositories by aggregate rather than arbitrary utility files, and generate mirrored contracts/defaults. Do not perform a wholesale Clean Architecture rewrite; incrementally move one invariant at a time with characterization tests.

### State management and recovery

**Observed strengths:**

- Queue/run state is explicit and schema-versioned.
- One RunSession per queue and an explicit global cap make admission understandable.
- Runs snapshot versioned definitions, avoiding live catalog retargeting.
- Terminal intent journaling before projections gives a recoverable commit protocol.
- Recovery checkpoints live outside workspaceState and activation repairs stale/inconsistent projections.

**Observed weaknesses:**

- VS Code workspaceState is a convenient memento, not a cross-window transactional database.
- Same-working-tree concurrency isolates scheduling but not filesystem side effects.
- Ownership files and memento snapshots do not share an atomic commit boundary.
- Heartbeat, release, and mirror maintenance have overlapping asynchronous lifetimes.

### Error handling and resilience

The project has strong explicit timeouts, delayed retry states, rate-limit parsing, cancellation signals, SIGTERM-to-SIGKILL escalation, audit-required progress, and terminal recovery. The most serious gaps are below those abstractions: stdin stream error events, process descendants, unbounded framing/read paths, and non-cancelable timed-out I/O. These are classic cases where a well-modeled application state machine is undermined by a weaker operating-system boundary.

An additional semantic concern is src/controller/phase-runner.ts:516-569: a timed-out process may be treated as successful if output parsed cleanly, and a clean model token can override a nonzero exit with a warning. That can be appropriate for CLIs which complete work but fail teardown, but it lets the output producer participate in classifying its own success. Host-verifiable gates should remain authoritative for security, tests, outputs, and side-effect claims.

### Configuration, data contracts, and schema evolution

**Strengths:**

- Runtime validators and tagged unions are widespread.
- Catalog IDs, records, manifests, snapshots, state schema, audit records, and IPC messages have explicit contracts.
- State migrations reach schema 13 and are heavily tested.
- Settings document ranges and scope in package contributions.

**Gaps:**

- Authoritative defaults are duplicated in package.json, host fallback tables, idle snapshots, webview snapshots, docs, and tests.
- Phase-log identifiers validate mostly shape/length rather than a strict safe identifier grammar.
- Application/resource scopes are not carried into the UI write target.
- The file-layout reference is not generated from current path/schema definitions.

The raw-transcript mismatch is a concrete demonstration that parity tests currently sample defaults rather than proving all of them.

### AI/LLM-specific assessment

| Area | Observed posture | Assessment |
|---|---|---|
| Prompt management | PromptBuilder assembles frozen definitions, request inputs/outputs, phase instructions, iteration state, and sidecar contract | Legible and testable, but large unbounded user values amplify memory/token cost |
| Tool boundary | Claude/Agy disable approvals; Codex requests workspace-write sandbox | Largest strategic weakness; backend selection changes the effective security model |
| Context routing | Versioned catalog plus frozen run snapshot; optional session reuse | Strong reproducibility within a CLI/provider version, not across provider/model updates |
| Outcome evaluation | Parser recognizes audit regions, tokens, issues, rate limits, fatal signatures, truncation | Good protocol engineering, but the agent still emits the success evidence |
| Prompt injection | Threat model recognizes it; no content-level defense is claimed | Honest, but broad tool capability makes successful injection high impact |
| Data leakage | Default environment allowlist is strong; prompts and outputs can be retained unredacted on errors | Retention is disclosed, but PEM sanitizer and symlinked sinks undermine controls |
| Model fallback | Backends are selectable and phase-overridable; runner switch is evaluated deterministically | No automatic safe fallback or version qualification; semantics differ |
| Cost control | Iteration/retry/cap/timeout controls exist | Run Request and total context have no aggregate byte/token budget |
| Evals | Versioned 13-case deterministic outcome corpus | Tests parser/control mapping, not actual model task quality, injection resistance, or cost |

### Testing strategy and gap analysis

| Area | Existing coverage | Missing or weak evidence | Why it matters | Priority / proposed test |
|---|---|---|---|---|
| Filesystem containment | Final-leaf symlinks and some in-tree links are tested | Ancestor symlink, absent target below link, positive-cache swap, and check/open race | Host can cross the workspace boundary | P0: adversarial safe-open matrix on POSIX and Windows |
| Stream memory | 64 MiB compressed buffers and about 9.6 MB combined sustained stdout/stderr are performance-tested | Multi-megabyte no-newline record, millions of short lines, blocked disk writer, concurrent aggregate memory | OOM bypasses nominal caps | P0: child fixtures plus heap/bounded-queue assertions |
| Child stdin | Unit mocks cover spawn/lifecycle | Real child exits/closes stdin during large prompt | Unhandled EPIPE can kill host | P0: subprocess regression executed in isolation |
| Cancellation | Direct-child TERM/KILL behavior | Grandchild continues writing after parent cancellation on POSIX/Windows | Terminal state can lie while side effects continue | P0: process-tree fixture per OS |
| Ownership | Extensive election/fence tests | Forced verify-then-stall-then-reclaim and heartbeat/release overlap | Existing mocks avoid the decisive interleavings | P0: deferred replace/memento seams |
| Sidecar/phase log | Shape, tail, projection, and caps after parse | Oversized file before allocation, huge tail delta, symlinked ancestor | Limits applied after read do not bound memory or containment | P0: sparse/large file and safe-FD tests |
| Transcript privacy mode | always/errors-only/off retention behavior | exit-before-final-output with no output sink or failed capture | Privacy option changes semantic output correctness | P0: wait-for-close without sink |
| Sanitization | Many token patterns and BEGIN headers | PEM body/footer, split markers, multiline line-oriented state | Private keys remain recoverable | P0: corpus spanning chunks and streams |
| VS Code compatibility | Latest stable Electron integration and three OS CI | Declared 1.85 floor | Advertised platform may fail despite green CI | P0: floor/latest integration matrix |
| General settings | Permissive fake configuration updates | Real application-scope write from the webview route | Test oracle accepts an API call real VS Code may reject | P1: live-host settings integration |
| AI behavior | Fake CLI E2E and 13 deterministic parser cases | Live version/provider canaries, injection/cost/task-quality scenarios | Upstream CLI/model drift is invisible | P1: isolated scheduled non-PR qualification |
| Documentation semantics | Link, parity, minimum-length, and selected string checks | Retired lock/pause/catalog/schema/default statements | Incorrect runbooks passed all doc gates | P1: generated facts plus forbidden retired claims |
| Accessibility | 18 Playwright visual tests, themes, touch targets, ARIA/focus unit tests | Systematic axe/WCAG scan, keyboard journeys, focus return/traps, screen reader | Complex seven-route UI can regress semantically | P1: axe per route/theme and keyboard E2E |
| Performance/soak | Five performance files, 14 tests, weekly 20,000-record evidence soak | Max-20 concurrency, long-host lifetime, phase-log worst case, startup/bundle memory | Current budgets emphasize synthetic steady paths | P1: aggregate heap/event-loop/FD soak |
| Release evidence | Package policy, integration, provenance | Exact-SHA full-gate dependency | Release can outrun required evidence | P1: reusable/promoted full-gate workflow |

### Observability and operability

**Observed strengths:**

- Structured audit events, runtime log, CLI transport, raw transcripts, verbose diagnostics, evidence health, metrics rollup, and live projections provide multiple diagnostic layers.
- Sanitized/default evidence is separated conceptually from explicitly unredacted evidence.
- Required phase-start/end evidence makes missing durable audit visible to the controller.
- Metrics and diagnostics are local; no separate Schegent telemetry service was found.

**Limits:**

- The audit file is ordinary mutable local evidence, not tamper-evident or compliance-grade.
- A timeout can let the underlying audit append outlive its serialization slot.
- Containment and sanitizer defects undermine confidentiality/integrity of evidence.
- There is no distributed trace because there is no distributed control plane; correlation IDs and run/phase identifiers are the appropriate local mechanism.
- Health does not currently express bounded-queue drops, descendant-process uncertainty, or containment cache invalidation because those protections do not yet exist.

## Phase 4 — ecosystem and strategic positioning

### Modernization decisions

| Candidate | Recommendation | Concrete benefit | Cost / reason to defer |
|---|---|---|---|
| Stronger domain/application/infrastructure separation | Incrementally extract pure transitions and repositories from the largest state/queue/controller modules | Smaller proof surface for migrations, concurrency, and recovery; easier property testing | A wholesale rewrite would stall hardening and introduce migration risk |
| Generated typed contracts/defaults | Adopt now for settings, host/webview snapshots, backend capabilities, paths/schema facts, and docs tables | Eliminates demonstrated default/scope/document drift | Requires generator ownership and reviewable generated artifacts |
| Reactive UI state framework | Do not replace Svelte's current model | Current UI is already Svelte, typed, and well tested | A framework rewrite has no evidence-backed payoff |
| External event broker | Do not add for the local single-host product | None needed for current scale | Adds deployment, recovery, auth, and split-brain burden; revisit only with remote/multi-user architecture |
| MCP | Keep frozen until capability mediation exists | Could standardize external tool/context routing later | Today it would widen the tool and credential surface before the existing boundary is safe |
| Container/remote execution provider | Strategic investment for untrusted or broader use | Real filesystem/process/network isolation and reproducible environments | Startup/resource/OS integration cost; should be an execution boundary, not a containerized UI |
| Per-run git worktrees | Add before raising practical concurrency beyond 1 | Separates working files and git state between queues | Clone/worktree lifecycle, disk, merge, and cleanup complexity |
| Local-model adapter | Optional later capability | True offline phase execution for suitable models | Model installation, hardware, capability discovery, quality, and support matrix are substantial |

### Alternative approaches

This comparison uses official project documentation available during the review. It is architectural, not a benchmark.

| Alternative | Extensibility and ergonomics | Privacy / isolation | Operational burden and performance | Comparison with Schegent |
|---|---|---|---|---|
| [GitHub Spec Kit](https://github.github.com/spec-kit/reference/core.html) | Agent-neutral Spec → Plan → Tasks → Implement artifact lifecycle with extensible commands and integrations | Primarily a specification workflow; execution safety depends on the chosen agent | Lightweight repository workflow | Schegent's advantage is durable queueing, snapshots, evidence, retries, recovery, and UI around the SDD lifecycle. Spec Kit should remain the artifact substrate rather than be reimplemented. |
| [Cline](https://docs.cline.bot/usage/ide) | Broad interactive coding-agent experience with Plan/Act, checkpoints, approvals, and extensibility | Human approval and checkpoints provide a different safety/rollback model; auto-approve can widen risk | More interactive and less opinionated about Schegent's durable SDD queues | Cline demonstrates the user-safety value of per-action approval and checkpoints. Schegent differentiates through unattended, frozen, auditable pipelines, but its unprompted default needs stronger containment. |
| [Continue](https://docs.continue.dev/) and its [MCP tool documentation](https://docs.continue.dev/customize/mcp-tools) | Broad editor/model/tool ecosystem, multiple modes, local models, MCP | More configurable trust surface; local-model options improve privacy/offline capability | Greater configuration and integration complexity | Schegent is narrower and more deterministic. MCP is justified only when external tool routing is a roadmap requirement and a capability policy exists. |
| [OpenHands sandbox architecture](https://docs.openhands.dev/openhands/usage/sandboxes/overview) | SDK/server/runtime choices, local Docker and remote workspaces | Docker is recommended for isolation; process sandbox is documented as unsafe | Heavier startup, resource, deployment, and remote-control burden | For current local preview, Schegent's in-process host is simpler. If it expands to untrusted, remote, or multi-user execution, an isolated workspace boundary inspired by OpenHands is safer than scaling current host-process orchestration. |

### Strategic positioning

**Differentiators:**

- Durable, versioned, frozen Spec Driven Development runs rather than a free-form chat session.
- Queue, pause, retry, recovery, terminal-journal, and evidence semantics integrated into VS Code.
- Backend-neutral phase contract with three adapters.
- Local control-plane state and evidence with no Schegent-hosted service.
- Strong package/release hygiene and an unusually broad invariant test suite.

**Critical weaknesses:**

- Safety varies dramatically by backend; the default is the least contained.
- The same-tree concurrency story protects scheduling ownership, not agent file interference.
- Runtime correctness depends on untrusted subprocess framing and self-reported success.
- Documentation accretion has left multiple contradictory operator truths.
- The current extension-host boundary is not suitable for multi-user, remote, or adversarial workspace execution.

## Phase 5 — security, privacy, reliability, performance, DevEx, and edge cases

### Extensibility seams and brittle areas

| Extension surface | Current seam | Ease | Constraint / safe next step |
|---|---|---:|---|
| New phase, pipeline, or workflow | Runtime catalog records, validators, immutable versions, and frozen snapshots | High | Keep schema/version gates and remove stale built-in assumptions from docs |
| New backend | BackendRunner contract, registry/factory, shared ProcessLifecycleRunner | Medium | Runner kind, settings, UI, sessions, output parsing, effort/model semantics, docs, and eval corpus are still cross-cutting; harden the shared boundary before adding one |
| New webview route or panel | Typed IPC plus host snapshot/projectors and Svelte route components | Medium | Host/webview contract duplication and large snapshot modules make changes broad; generate the shared contract |
| New persistence backend | WorkspaceStateStore and filesystem services are concrete, not repository-neutral | Low | First extract aggregate repositories and transaction semantics; do not introduce a database only to satisfy a pattern |
| New evidence sink | Audit/runtime/transport/transcript writer interfaces provide examples | Medium-Low | Existing writers do not share one safe-open, retention, backpressure, and redaction layer; build that substrate first |
| MCP/plugin/tool integration | No product boundary; explicitly frozen by release posture | Low today | Requires authenticated capability policy, per-tool consent, schema/versioning, secret routing, and audit before adoption |
| Local server or remote/multi-user mode | No listener, daemon, identity, tenant, or authorization model | Intentionally unsupported | Requires a separate architecture: authn/authz, tenancy, durable broker/store, isolation, reconciliation, and threat model |
| Local/offline model | Backend adapter is a plausible seam | Medium technically | Hardware/capability discovery, model lifecycle, quality/cost evals, and no-network proof are the real product work |

### Lightweight threat model

#### Assets

- Workspace source, git metadata, generated outputs, and operator credentials reachable through tools.
- Catalog definitions and frozen run plans.
- Queue/run/history/recovery state.
- Structured audit, transport, raw transcripts, diagnostics, and metrics.
- CLI/provider credentials and data carried by the selected backend.
- Integrity of cancellation, phase success, ownership, and release evidence.

#### Threat actors and inputs

- Malicious or merely surprising workspace content in a trusted workspace.
- Prompt injection embedded in source, documents, tool output, or supplemental inputs.
- A faulty, compromised, or protocol-drifting CLI/backend.
- A stale/rival VS Code window.
- An operator misconfiguration, accidental symlink, disk-full/slow filesystem, or interrupted upgrade.
- A compromised webview or malformed restored state.

#### Control assessment

| Threat | Existing control | Residual issue |
|---|---|---|
| Webview XSS / direct network | Strong CSP, restricted local resource roots, no raw HTML/eval found, runtime host validation | Compromised extension bundle remains privileged; phase-log tuple semantics are weak |
| Shell/argument injection | shell false, prompts on stdin, structured argv | CLI path/config is operator-controlled; tool actions occur inside the backend |
| Ambient secret forwarding | Default environment allowlist | Prompts/workspace may contain secrets; chosen allowlist names forward live values |
| Prompt injection | Explicit threat-model disclosure, frozen prompt contract | No enforceable tool capability ceiling for default Claude/Agy |
| Path traversal / symlink | Lexical checks, some realpath, some final O_NOFOLLOW | Ancestor links, cached verdicts, and check/use gaps remain |
| Unsafe deserialization | Runtime validators, explicit schema/migrations | Large values/counts can consume resources before bounded use |
| SSRF | Host/webview have no ordinary network client surface; CLI is external integration | Broad agents can make network/tool requests outside host mediation |
| CSRF/authz | No HTTP control plane; workspace-trust and primacy gates | Not applicable as web auth; multiwindow authorization relies on non-atomic ownership |
| Evidence tampering | Gitignore, structured records, required progress evidence | Ordinary files are mutable and not tamper-evident; symlink/timeout issues weaken integrity |
| Supply chain | No separately installed production npm tree, lockfiles, ignore-scripts CI, pinned Actions, SBOM/provenance | Bundled third-party/dev tooling remains a large transitive surface; Marketplace trust still requires release verification |
| Lateral movement | Codex workspace sandbox; environment allowlist | Default Claude/Agy and extension-host confused-deputy writes can reach beyond workspace |
| Secret sanitization | Broad regex corpus and structural sanitizer | Multiline PEM bodies survive; raw/error transcripts are intentionally unredacted |

Authentication, authorization, CSRF, and traditional server-side SSRF are not primary categories because there is no network listener or remote user model. They become first-order requirements if remote/multi-user mode is introduced; the existing primacy lease is not a substitute for identity, policy, tenancy, or authorization.

### Privacy and data minimization

**Observed:**

- Raw transcripts can contain prompts, source, model output, and secrets. The default is errors-only, with age and byte retention controls; off is supported.
- Verbose diagnostics are unredacted and opt-in.
- Structured/runtime/transport evidence is intended to be sanitized.
- The webview cannot make network connections under its CSP; Schegent's host does not implement a telemetry service.

**Assessment:**

- errors-only is a reasonable diagnosis/privacy compromise, but failures often contain the most sensitive source and tool output. Thirty-day and 512 MiB defaults still need prominent disclosure and one-click purge.
- No encryption-at-rest boundary was found. Local OS account/filesystem protections are the confidentiality boundary.
- PEM sanitization is presently ineffective for complete private keys in line-oriented logs.
- The always fallback drift can mislead operators even if the contributed VS Code default normally returns errors-only.
- Audit evidence is diagnostic, not a compliance audit trail; documents must not imply tamper evidence.

**Compliance implication:** Operators may place personal, proprietary, credential, or regulated data in prompts/transcripts. Retention, provider processing, deletion, access, and incident response remain the operator's responsibility. This is a technical risk assessment, not legal advice.

### Local-first versus offline-first

The control plane is genuinely local-first: catalogs, queue/run state, evidence, UI, and recovery are local, and the webview cannot egress. It is not generally offline-first because Claude/Codex/Agy may require provider authentication and network service. Offline browsing/editing/history can work; phase execution may fail or stall.

True offline execution would require a local-model/backend adapter, capability discovery, model/artifact installation, predictable resource budgets, quality/eval qualification, and explicit no-network enforcement. This should remain a later product track, not a release-gate distraction.

### Performance assessment

**Strengths:**

- Blocking performance budgets cover catalog/state/projection/evidence paths.
- A sustained fixture emits about 9.6 MB combined across stdout and stderr and passes current bounds/recovery tests.
- Visual tests are deterministic; Playwright uses one worker and fixed environment.
- Default concurrency 1 limits aggregate CPU, memory, and working-tree contention.
- Package size is modest.

**Bottlenecks and failure amplifiers:**

- Cold activation composes many long-lived services, migrates/repairs state, and schedules evidence retention work; integration/performance gates provide some activation evidence, but no maximum-history cold-start profile was captured.
- Character-by-character concatenation in the Claude line buffer can approach quadratic copying for a very large line.
- Multiple duplicate stream representations coexist: compressed buffers, monitor remainders, Claude line buffer, transport strings/promises, and optional diagnostics.
- Whole phase-log/sidecar/tail-delta allocation makes file size an attacker-controlled heap request.
- Synchronous compression or large JSON serialization on extension-host paths can increase event-loop latency.
- Twenty concurrent runs multiply subprocesses, buffers, evidence writes, catalog/state events, and shared-tree contention; current tests do not establish an aggregate heap/FD/latency budget.
- Long-lived completed-run maps create slow memory growth that short CI runs will not reveal.
- tests/perf/budgets.json:2-4 explicitly says inline assertions are authoritative and the JSON file is a human index. Without generation or a parity gate, that index can drift even while the executable budgets remain correct.

### Reliability and recovery

**Strong mechanisms:** versioned migrations, terminal intent journal, stale-state repair, frozen plans, per-queue sessions, delayed retry policy, timeout/cancel escalation, required audit events, checkpoints, package tests, and multi-OS CI design.

**Release-relevant weaknesses:** an unhandled stream event can kill the host; direct-child cancellation can leave side effects running; memory caps do not cover all paths; privacy mode affects close semantics; stale ownership can commit after reclaim; audit timeout can break ordering; and minimum VS Code is unqualified.

Rollback is mostly forward-fix. That is reasonable for Marketplace extensions, but the release runbook should state emergency disable/unpublish/advisory steps and state-schema compatibility expectations for downgrades. Catalog record/manifest sequencing is recoverable but not one cross-file transaction; repair behavior should remain tested under interruption at every step.

### Developer experience and maintainability

**Strengths:**

- AGENTS guidance, CONTRIBUTING, architecture records, English-only product-string decision, and extensive verification scripts give contributors a serious operating manual.
- Type checking, lint baselines, coverage floors/headroom, contract/parity tests, visual regression, performance budgets, integration, package smoke, and release checks provide excellent local feedback.
- No separately installed production npm tree is needed after bundling.

**Friction and debt:**

- Full CI is comprehensive but expensive; ci.yml and pr.yml duplicate large PR matrices.
- The lint baseline still contains hundreds of warnings, including keyless Svelte loops/reactivity concerns and unused bindings. Ratchets prevent regression but should not be presented as zero debt.
- Root postinstall differs from immutable CI installation.
- Contradictory documentation makes new contributors learn which page is current.
- Very large state/queue/composition modules raise the cost of safe changes.

Use one reusable workflow and a deliberate fast-PR/full-merge policy. Preserve evidence-bearing redundancy, but avoid running the same semantic gate repeatedly without a stated reason.

### Accessibility, internationalization, and portability

**Accessibility observed:** Playwright covers light/dark/high-contrast themes, route recovery, mobile/coarse-pointer sizing, one main region, horizontal overflow, named form controls, and 44-pixel targets. Unit tests include substantial targeted ARIA and focus behavior.

**Accessibility gap:** There is no systematic axe/Pa11y/Lighthouse scan, complete keyboard journey, dialog focus-trap/return journey, or manual assistive-technology evidence. For a complex multi-route webview, this is Medium risk, not proof of nonconformance.

**Internationalization:** Schegent is explicitly English-only by decision in docs/concepts/english-only-not-localizable.md. Literal user-facing strings are therefore coherent with policy. This narrows addressable markets and accessibility for non-English users but is not accidental localization debt.

**Portability strengths:** Full CI jobs are designed for Ubuntu, macOS, and Windows on the .nvmrc Node 24 version; a separate Ubuntu Node 22.23.2 leg runs verify:all only. Platform process telemetry has POSIX/Windows adapters, and integration handles platform-specific temporary/socket constraints.

**Portability gap:** The minimum VS Code/API/runtime claim is unqualified. Symlink and process-tree fixes must have Windows-specific designs rather than assuming POSIX open/process-group semantics.

### Edge cases and surprising failure modes

- Backend exits before prompt delivery: asynchronous stdin EPIPE can escape.
- Backend emits one enormous line: logical buffers keep growing after capture truncation.
- Backend emits millions of tiny lines faster than disk: transport promise backlog grows.
- Backend spawns a tool child then exits/cancels: descendant keeps modifying files.
- workspace/.schegent is a symlink before activation: default audit/gitignore side effects leave the workspace.
- A validated log file is swapped to a symlink after first write: cached positive containment remains.
- A selected local file has a regular leaf below a linked ancestor: final O_NOFOLLOW gives false confidence.
- A sidecar or phase log is huge: host reads/allocates before applying logical caps.
- Raw capture is off or initialization fails: child completion stops waiting for pipe close.
- Window A verifies a fence then stalls while window B reclaims: A can resume its separate state write.
- Heartbeat overlaps release: a late heartbeat can restore a released holder.
- Model emits a clean token despite nonzero exit or timeout: parser may accept success by design.
- General settings UI writes an application-scoped CLI path to workspace scope: actual VS Code behavior differs from the permissive test double.
- Extension is installed on VS Code 1.85: current gates cannot say whether it activates.
- Disk append times out but later completes: evidence may arrive out of order or in a different rotation.
- Operator trusts stale runbooks: pause/capacity/lock recovery actions do not match current implementation.

## Phase 6 — risk register and recommendations

### Consolidated risk register

| ID | Risk scenario | Category | Impact | Likelihood / reachability | Severity | Confidence | Release posture |
|---|---|---|---|---|---|---|---|
| R-01 | Prompt-injected or mistaken default Claude/Agy acts with OS-user tool capability and no approval boundary | Security / product architecture | Workspace or external file/network side effects beyond operator intent | Default Claude core path after run consent | High | High | Block broad release; accepted disclosure is insufficient |
| R-02 | Workspace-controlled symlink redirects host evidence, diagnostics, sidecar, input, or output access outside workspace | Security / filesystem | External append/truncation, data ingestion, privacy breach, confused deputy | Trusted workspace or in-run mutation; several default sinks | High | High | Block |
| R-03 | Large/no-newline output, fast-line backlog, or huge sidecar/log exhausts extension-host memory | Reliability / performance | Host crash, lost orchestration, partial state | Every invocation or diagnostic read; malformed backend/workspace output | High | High | Block |
| R-04 | Child closes stdin while a large prompt is queued | Reliability | Unhandled EPIPE terminates extension host | Every invocation; early backend exit | High | High | Block |
| R-05 | Canceled CLI leaves tool descendants alive | Integrity / reliability | Side effects continue after terminal/cancel state | Any backend that spawns descendants | High | High | Block |
| R-06 | Stale advisory mirror, released-holder resurrection, or an unguarded Run effect after lease loss | Concurrency / integrity | Incorrect ownership projection and potential stale Run mutation; duplicate execution was not reproduced | Multi-window contention and adverse timing | High | Medium | Block advertised multiwindow guarantee |
| R-07 | Private-key header is redacted but body/footer persist | Privacy / security | Recoverable private key in local evidence | CLI prints key material; sanitizer active by default | High | High | Block |
| R-08 | VS Code 1.85 package passes current gates but may fail on the floor | Compatibility evidence | Potential activation/runtime failure for advertised users | Any API/runtime incompatibility; no actual break established | Medium | High | Qualify or raise floor before release |
| R-09 | Raw transcript off/capture failure loses late stdout | Correctness / privacy | Wrong phase/session classification | Nondefault off or storage failure | Medium | High | Fix in hardening cycle |
| R-10 | Model-generated token/audit self-certifies phase success | AI control integrity | False advancement or incomplete work | Any injected/mistaken output; mitigated by fatal/truncation parsing | Medium | High | Add host-verifiable gates |
| R-11 | Run Request lacks aggregate resource budget | Availability / cost | Memory, persistence, stdin, token, and provider-cost amplification | Local operator/webview input | Medium | High | Bound before persistence |
| R-12 | Audit append timeout races later writes/rotation | Evidence integrity | Reordered or misplaced evidence | Slow/wedged filesystem | Medium | High | Preserve internal barrier |
| R-13 | Release tag is not mechanically tied to exact-SHA full gate | Supply chain / release | Provenance for an insufficiently tested artifact | Human procedural miss | Medium | High | Automate exact-SHA requirement |
| R-14 | Operator docs teach retired locks, pause, catalog, schema, transcript, and backend behavior | Operations / DevEx; not core code | Incorrect recovery, support, and privacy choices | High: current published docs | High | High | Must reconcile before external users |
| R-15 | Real CLI/provider protocol drifts | Integration | Runs fail or classify incorrectly despite green PR CI | Upstream update/auth/provider behavior | Medium | High | Scheduled isolated canaries |
| R-16 | Same-tree concurrency causes agent interference | Product integrity | Cross-run file/git conflicts and nondeterminism | Cap above 1 with overlapping outputs | Medium | High | Keep default 1; isolate before expansion |

### Prioritized recommendations

| Priority | Recommendation | Why it matters | Evidence | Expected impact | Effort | Time horizon |
|---|---|---|---|---|---|---|
| P0 | **Harden the shared process boundary:** handle stdin errors before write, always wait for close, enforce bounded JSONL framing/queues, stream bounded files, and terminate full process trees | Closes host-crash, OOM, output-loss, and false-cancellation paths shared by every backend | H-03, H-04, H-05, M-01 | Largest immediate reliability gain; makes backend failures containable | Medium | Quick fixes in days for EPIPE/close; complete runner hardening in weeks |
| P0 | **Create and mandate one syscall-level safe filesystem layer** for every workspace read/write/mkdir/rename/append | Lexical/realpath checks cannot protect mutable paths; the extension host is a confused deputy | H-02 and phase-log/sidecar evidence | Restores a meaningful workspace boundary and consistent path policy | Medium-High, including Windows design | Weeks |
| P0 | **Replace verify-then-write ownership with an atomic/fence-bearing commit protocol** and drain heartbeat work on release | Multiwindow correctness depends on the fence being checked at effect, not before it | H-06 | Prevents stale state commits and released-holder resurrection | High | Weeks |
| P0 | **Choose an enforceable agent capability posture:** sandboxed default, mediated capability broker, or separately enabled expert uncontained mode | The default backend currently has the broadest privilege and no per-tool approval | H-01; package.json:162-171 | Materially reduces prompt-injection and lateral-movement impact | High | Strategic investment over 1-3 months; product-policy change can begin in days |
| P1 | **Close the remaining release evidence as one executable program:** fix multiline secret redaction; qualify VS Code floor/latest; add adversarial process/path/lease tests; bind release to exact-SHA full gate; generate defaults/capability/doc facts | Private keys remain in default logs, platform support is only declared, current tests miss the decisive interleavings, and semantic docs drift passes structural checks | H-07, H-08, M-06, R-13, documentation and testing tables | Makes release claims auditable, prevents regression, and corrects operator/privacy guidance | Medium-High | Quick secret/default fixes in days; complete gate and documentation program in weeks |

### Recommended implementation sequence

1. Land the small correctness fixes first: stdin error handling, close waiting independent of transcript capture, PEM block redaction, stat-before-read, strict phase-log segment validation, and correct settings targets/defaults.
2. In parallel, design the safe-open abstraction and process-tree lifecycle for POSIX and Windows. Require adversarial fixtures before migrating sinks one by one.
3. Choose the ownership atomicity mechanism and prove forced stale-write and heartbeat/release interleavings.
4. Re-run the independent criterion-8 review against the remediated commit, including a full local gate and observable remote floor/OS evidence.
5. Only after the core gate passes, decide whether the next strategic investment is contained execution or isolated worktree concurrency. Do not spend the hardening window on MCP, a new backend, remote mode, or a UI rewrite.

### Do-not-ignore release blockers

The following conditions should block a Marketplace release, tagged external release, external pilot, or architecture expansion:

- Unhandled child stdin errors can terminate the extension host.
- Unbounded stream/queue/file-read paths can exhaust the host.
- Cancellation does not establish that tool descendants stopped.
- Workspace containment is not enforced at the syscall across all readers/writers.
- Multiwindow fencing is not atomic with protected state mutation.
- Complete private keys are not removed from sanitized line-oriented evidence.
- Default unprompted agent capability remains uncontained without a release-appropriate product policy.
- The advertised VS Code minimum is not qualified or raised.

Documentation High findings do not by themselves prove a core execution defect, but they must be corrected before external users rely on operator, recovery, security, and privacy guidance.

## Final judgment

Schegent has the bones of a serious local orchestration product and substantially more engineering discipline than its 0.2.0 version suggests. The current problem is not a lack of features or test volume. It is that a handful of operating-system and trust-boundary details sit below the abstractions the tests prove.

**Criterion 8 remains open.** The release posture should stay engineering preview, and architecture expansion should stay frozen, until a repeated independent review finds no Critical or High defect in core execution and the minimum supported platform is backed by executable evidence.

## Final scorecard

| Area | Score (1-5) | Justification |
|---|---:|---|
| Documentation | **2** | Extensive and often thoughtful, but current operator pages contradict implementation on locks, pause/capacity, catalog, schema, transcript retention, environment, and backend behavior. |
| Architecture | **3** | Clear host-centric boundaries, frozen definitions, explicit queues/evidence/recovery; containment, capability, ownership atomicity, and same-tree concurrency remain material design gaps. |
| Code Quality | **3** | Strong types, names, invariants, and explicit results, offset by several oversized coordination modules, duplicated contracts/defaults, and unsafe low-level boundaries. |
| Testing | **4** | Exceptional breadth across unit/integration/contract/parity/visual/perf/e2e/package; misses adversarial syscall/process/race cases, minimum VS Code, live providers, and systematic accessibility. |
| Security | **2** | Strong CSP, shell discipline, environment allowlist, supply-chain controls, and candid threat model; uncontained default agents and symlink/confused-deputy paths are High. |
| Privacy | **2** | Data tiers and errors-only retention are well conceived, but unredacted failure data, no encryption boundary, default-display drift, and reconstructable PEM keys materially weaken posture. |
| Reliability | **2** | Journaling, recovery, retries, and state tests are strong, but EPIPE host termination, OOM paths, descendant survival, output-loss mode coupling, and fence races affect core execution. |
| Performance | **3** | Blocking budgets and soak tests are strong for normal paths; unbounded logical lines, queues, whole-file reads, long-lived maps, and untested cap-20 aggregation remain. |
| Observability | **4** | Rich local audit, transport, transcript, diagnostics, metrics, health, and correlation; evidence is not tamper-proof and current sink integrity/redaction need repair. |
| Extensibility | **3** | Catalog/versioning and backend adapters are useful seams; the three-runner union, backend semantic differences, duplicated contracts, and lack of a safe capability boundary constrain safe growth. |
| DevEx | **4** | Excellent verification scripts, guidance, lockfile-driven installs, repeatable build checks, and exact package policy; contradictory docs, CI duplication, mutable nested install, lint debt, and large hubs add friction. |
