# Artifact structure evaluation

FR-R4-F12 (contract AE) adds an offline check of Spec Kit artifact **structure**. Twelve synthetic
documents (one conforming and three malformed specification, plan and task list) are judged by
`evaluate-artifact.ts` against the versioned criteria in `criteria.json`.

## What it measures, and what it does not

- It measures **structure against criteria version 1**: which headings are present, whether
  requirement and task ids are unique, whether a user story carries a priority, whether template
  residue is left, and similar machine-decidable properties. Each criterion names the artifact it
  judges, and each failure names its criterion.
- It does **not** measure quality. Quality is the rubric's (`rubric.md`): clarity, testability, scope
  discipline and traceability. The rubric is judged by a person, is never scored by any automated
  check, and the evaluator reads only its version line, to report it.
- It says nothing about **execution safety**. Every result carries the scope sentence "artifact
  structure, not execution safety".
- No result is an input to Phase advancement, save gates or any autonomous action. Nothing under the
  host source tree reads the evaluator, and `artifact-conformance.test.ts` asserts that with a control.

## Versions and provenance

Every result carries the criteria version, the rubric version and a template provenance id. The
criteria are derived from the three Spec Kit templates at the hashes recorded in
[`docs/development/template-provenance.md`](../../../docs/development/template-provenance.md), which
also records what is **not** known: the upstream source revision of Spec Kit 1.2.3 is pending
qualification. `tests/lint/template-provenance-parity.test.ts` holds the record and `criteria.json`
to the same hashes.

## Not delivered

Live-backend sampling and comparative benchmarks are not delivered. If they are ever added, they are
opt-in, versioned and outside the `gate` command.

## Running it

`npm run test:evals` runs it with the rest of the evals tier. It reads its fixtures with `readFileSync`
and needs no network or credential.
