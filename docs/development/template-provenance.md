# Spec Kit template provenance

**Captured**: 2026-11-01 · **Feature**: 259 (`FR-R4-F12`, FR-019) · **Provenance id**: `spec-kit-1.2.3+schegent-1`

**Measured at**: workspace `0be7f0e`, `repo/` `62265e71` plus the uncommitted work of feature 259 (none of
which touches a file listed below).

**Refresh obligation**: whoever changes a file listed below, or re-installs Spec Kit, re-measures with the
command at the foot of this page and updates this table and the hashes in
`tests/evals/artifacts/criteria.json` in the same change. `tests/lint/template-provenance-parity.test.ts`
holds the two to the same hashes; it cannot know a template changed unless the table is re-measured.

## Why this page exists

The artifact-structure criteria in `tests/evals/artifacts/criteria.json` are derived from three Spec
Kit templates. A criterion that quietly drifts from the template it was derived from measures nothing, so
this page records which templates were read, at which bytes, and what is **not** known about where they came from.

## The authority, and what it is not

- **The only version authority** is `.specify/init-options.json`, `speckit_version: "1.2.3"`.
- `.specify/integration.json` and `.specify/integrations/*.manifest.json` are the install's own per-file
  hashes. They say what the installer wrote. They do not say what the upstream project published.
- **Not known**: the upstream source revision that Spec Kit 1.2.3 was cut from. It is **pending
  qualification** (see the last section).

## The record

Hashes are SHA-256 of the file's bytes. "Manifest hash" is the installer's recorded value, or "not in a
manifest". "State" is one of `matches 1.2.3`, `locally adapted (<commits>)`, `local override`, or
`repo-authored (<repo commit>)`.

| Path | Version authority | Manifest hash | Measured hash | State | Upstream source revision |
|---|---|---|---|---|---|
| `.specify/templates/spec-template.md` | `speckit_version` 1.2.3 | `sha256:3945437fc35cd30a5b2bf7beea680337c3516826d3efa5a6b92c4a7eca1ba28e` | `sha256:3945437fc35cd30a5b2bf7beea680337c3516826d3efa5a6b92c4a7eca1ba28e` | matches 1.2.3 | pending qualification |
| `.specify/templates/plan-template.md` | `speckit_version` 1.2.3 | `sha256:7e637502d41eccf0ca672496636365691fdca62ef37b27ec07fcb412dbfa90d4` | `sha256:7e637502d41eccf0ca672496636365691fdca62ef37b27ec07fcb412dbfa90d4` | matches 1.2.3 | pending qualification |
| `.specify/templates/tasks-template.md` | `speckit_version` 1.2.3 | `sha256:fb7a30a6e8e7319b7134bd52a26dd52fb7dd9106ab8fa08b6fb551d704dac498` | `sha256:0c6462e7b74688ddce42cdf5877434d50083e1459e44b1bf5a42d350784f9c43` | locally adapted (`bc53879`, `1f3f506`, `6a4c5f9`) | pending qualification |
| `.specify/templates/checklist-template.md` | `speckit_version` 1.2.3 | `sha256:856532b3cb66171c662cc16f16b31a5856e4655a8666aad1e545bbfc7f603ca1` | `sha256:856532b3cb66171c662cc16f16b31a5856e4655a8666aad1e545bbfc7f603ca1` | matches 1.2.3 | pending qualification |
| `.specify/templates/constitution-template.md` | `speckit_version` 1.2.3 | `sha256:ce7549540fa45543cca797a150201d868e64495fdff39dc38246fb17bd4024b3` | `sha256:ce7549540fa45543cca797a150201d868e64495fdff39dc38246fb17bd4024b3` | matches 1.2.3 | pending qualification |
| `.specify/templates/overrides/checklist-template.md` | none | not in a manifest | `sha256:e38d2051505616cd15537f616ec2069e12cf1a9984e7e405762f0a03999a7a02` | local override | not applicable |
| `repo/examples/speckit-new-feature.workflow.yaml` | none | not in a manifest | `sha256:1c621a5b303f81746f1a4e70974e8a80aab617eef4f0e1054741552ea879ebf7` | repo-authored (`repo/` `0dc779a0`) | not applicable |
| `repo/examples/speckit-bugfix.workflow.yaml` | none | not in a manifest | `sha256:934bf0552a70d19514daace9895334e48ae275f25b07f7d728866ef9ee19cf30` | repo-authored (`repo/` `0dc779a0`) | not applicable |
| `repo/examples/example-two-node.workflow.yaml` | none | not in a manifest | `sha256:9d83a99004e1f5a6f048748ec840d8c9def9d2f481b02c0668b6421af749f4c6` | repo-authored (`repo/` `0dc779a0`) | not applicable |
| `repo/examples/example-nested-delivery.workflow.yaml` | none | not in a manifest | `sha256:a4a787b652b8714ad73e2e5fd492058a8f73c4abdc9f9af4a90133191b52b619` | repo-authored (`repo/` `0dc779a0`) | not applicable |
| `repo/examples/model-catalog.yaml` | none | not in a manifest | `sha256:f727213b8b19d7013373b07e0d37d935a162ca290ab2e00fd85f1a556d4cbb01` | repo-authored (`repo/` `62265e71`) | not applicable |

Reading the table:

- **Eleven of the twelve** files the `speckit` manifest lists match their recorded hash; the
  twelfth, `tasks-template.md`, differs, and its three local commits are named in the row. The `claude`
  manifest (10 files) and the `codex` manifest (10 files) match in full.
- The criteria for the **tasks** artifact were derived from the *adapted* `tasks-template.md`, not from an
  upstream original this page cannot show.
- The override and the four example files belong to no manifest. They are listed so that nothing a Phase
  or an author reads as a template is left unaccounted for.

## The upstream revision: pending qualification

The commit that the 1.2.3 release was cut from needs network access to the upstream repository, which no
agent phase may use. It is recorded as **pending qualification**.
The prerequisite is: **read the v1.2.3 tag's commit from the upstream repository**.
That step is run by a maintainer, and until it has been run this page claims no upstream revision. When it is
run, record the commit and the date in the last column and in this paragraph. It is never marked passed by an agent.

## Re-measuring

From the workspace root, hash every file the three manifests list and compare. Expected at capture:
`speckit` 11 match and 1 `DIFFERS` (`.specify/templates/tasks-template.md`), `claude` and `codex` all match.

```sh
node -e "const fs=require('fs'),c=require('crypto');for(const m of ['speckit','claude','codex']){const j=JSON.parse(fs.readFileSync('.specify/integrations/'+m+'.manifest.json','utf8'));for(const [p,h] of Object.entries(j.files)){const g=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log(m,g===h?'match':'DIFFERS',p)}}"
```

The measured hashes of the rows without a manifest come from `sha256sum` (or the same `createHash` call) over
the file named in the row.
