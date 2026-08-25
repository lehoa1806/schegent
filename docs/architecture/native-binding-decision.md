# Decision record: is a native binding acceptable for this product?

**Status: DECIDED — no. 2026-08-25.**
**Consequence: four residuals become permanent stated limits, not open follow-ups.**

`FR-R3-083` asks this question once, deliberately, because four residuals in three subsystems all
resolve to it. Filing them separately asked it four times and answered it inconsistently — one of them
said "stated as follow-on", another said "a dependency decision and not this item's to take", and a
third said nothing at all.

## The one question

Four checks cannot be written with what Node exposes. Each needs a compiled extension to the runtime:

| Residual | Site | Missing primitive |
|---|---|---|
| The component-swap race in the safe-open walk | [`src/lib/safe-open.ts`](../../src/lib/safe-open.ts) | `openat(2)` — a handle-relative walk. `/proc/self/fd` is Linux-only. |
| Atomic publish through `rename` | [`tests/lint/safe-open-migration.test.ts`](../../tests/lint/safe-open-migration.test.ts) `ATOMIC_PUBLISH_RENAME_RESIDUAL` | `renameat(2)`. A `rename` resolves both pathnames and cannot be made handle-relative. |
| An unescapable kill on Windows | [`src/runner/process-tree.ts`](../../src/runner/process-tree.ts) | A Job Object with kill-on-close. `taskkill /T` walks by parent pid and is escaped by re-parenting. |
| Reparse-tag inspection at the Windows leaf | [`src/lib/safe-open.ts`](../../src/lib/safe-open.ts) | `GetFileInformationByHandleEx` / `FSCTL_GET_REPARSE_POINT`. `O_NOFOLLOW` does not exist on Windows and Node ignores it. |

Every one of them is real, and none is exotic. The question is not whether they would be closed by a
native binding — they would. It is whether this product should have one.

## The branch that was rejected, and what it would have cost

**Ship a native addon** (`node-gyp` / `node-api-headers`, or a prebuilt-binary distribution).

- **A prebuild matrix.** A VS Code extension runs on the Electron ABI, not the system Node ABI, across
  macOS (x64, arm64), Windows (x64, arm64) and Linux (x64, arm64) — and across the VS Code versions
  the product supports. Every one is a binary to build, sign, ship inside the VSIX, and re-cut on
  every Electron bump. `docs/operations/vsix-allowlist-derivation.md` describes a package whose
  contents are derived and asserted; six-plus opaque binaries are the opposite of that.
- **A supply-chain surface the product has deliberately not had.** Installs run
  `npm ci --ignore-scripts` in [`ci.yml`](../../.github/workflows/ci.yml), and `FR-R3-090` exists to
  bring local installs to that same posture. A native module's whole install mechanism is the
  lifecycle script that `--ignore-scripts` suppresses. Adopting one means either abandoning that
  posture or shipping prebuilt binaries — which moves the trust from a build step to an artifact
  nobody in this repository can reproduce.
- **An install-time compiler dependency** for anyone the prebuild matrix misses: a C++ toolchain and
  Python, on a contributor's machine, to install a VS Code extension's dependencies.
- **It would be the first.** Measured 2026-08-25, re-read from the files rather than transcribed:
  [`package.json`](../../package.json) has **no `dependencies` key at all** — only `devDependencies`
  (18 entries) — and [`webview-ui/package.json`](../../webview-ui/package.json) likewise has none.
  The product ships **zero** runtime dependencies, in both trees. A native binding would not be one
  more entry on a list; it would create the list, and it would create it with a compiled artifact.
  This is the input that decides the question, and it is the reason the answer is not close.

  *(An earlier draft of this line said `dependencies` is `{}`. It is absent, which is a stronger
  statement of the same fact — but the sentence claimed a measurement, and a measurement that is
  approximately right is the drift this round exists to remove.)*

**What that branch would have bought:** the component-swap window closed on all platforms, atomic
publish restored for four sites, an unescapable kill on Windows, and true reparse-tag rejection. Real
gains against real residuals. They are not worth creating this product's first runtime dependency, as
a compiled one, on the terms above.

## What is bought instead, and what is not

The residuals are **stated permanently** rather than tracked as work. Concretely:

- The safe-open walk closes the **no-race** hole completely — a path that *is* a link, or that goes
  through one, is refused at every component and at the leaf. What remains open is only an adversary
  who wins the interval between one component's `lstat` and the next syscall, on a path already inside
  a trusted root.
- `taskkill /T` is the requirement's **own allowed** well-audited equivalent, not a defect. What it
  does not survive is a descendant that re-parents itself. On POSIX the equivalent gap is a descendant
  that calls `setsid` for itself.
- The Windows leaf now refuses a reparse point at the fidelity Node's `Stats` reaches, which is more
  than the `lstat`-only check it replaces and less than a reparse-tag inspection.

None of that is a guarantee, and this record does not offer one. It is risk reduction with a named
remaining edge.

## What would reverse this

State the trigger rather than leaving it to judgement:

1. **The product acquires a runtime dependency for another reason.** The decisive input above is that
   this would be the first. Once it is not the first, the marginal cost is a prebuild matrix rather
   than a change of kind, and this record should be re-argued on that narrower question.
2. **Node exposes the primitive.** `openat`/`renameat`-class handle-relative operations reaching
   stable `node:fs` removes the dependency question entirely for two of the four residuals.
3. **The threat model changes.** This product is local-first and single-operator
   (`docs/architecture/local-queue-parallelism-ratification.md`). An adversary with local code
   execution racing the walk already has the operator's authority. If Schegent ever runs work on
   behalf of a party that is not the workspace owner, the component-swap window stops being a
   sharp-edge residual and becomes a boundary, and this decision does not survive that change.

Any of the three is enough to reopen it. Absent them, these residuals are closed as *stated*, and
`FR-R3-083` §3 stage 2b is what governs how they are recorded.

## Related

- [Workspace ownership fencing](workspace-ownership-fencing.md) — the mount limit, which is the same
  class of permanent statement for a different primitive.
- [Backend operations](../operations/backends.md) — step 6 states the Job Object limit for operators.
- [Platform observation record](../operations/platform-observation-record.md) — which acceptance
  halves are observed and which are not.
- `tests/lint/safe-open-migration.test.ts` — the ledger, whose `PERMANENT_LIMIT` disposition consumes
  this decision.
- `tests/lint/native-binding-citation-parity.test.ts` — the gate that keeps every residual site
  pointing here.
