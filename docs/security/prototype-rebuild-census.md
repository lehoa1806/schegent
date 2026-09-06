# Prototype-rebuild census

Every place in `src/` that rebuilds an object by copying **enumerated keys** into a **plain object**
with a **computed-key assignment** — `target[key] = …`, where `target`'s prototype is
`Object.prototype`. That shape is the one `out[key] = value` cannot execute faithfully: for an own
key named `__proto__` the assignment creates no own property, it invokes the
`Object.prototype.__proto__` setter. A string value is discarded; an object value becomes the
target's prototype.

**Measured**: 2026-09-06, on `develop` plus the `205-sanitizer-proto-key` fix.
**Feature**: FR-R3-166 (`specs/205-sanitizer-proto-key`, 2026-09-05) — FR-010, FR-011, FR-012.
**Companion**: [threat-model.md](./threat-model.md) T1, T15, T20.

This is a census, not a gate. Nothing here is enforced by a test; re-derive it with the method below
rather than trusting the table's age.

<!-- Source: src/lib/logger.ts -->

---

## Method

Two steps, both re-runnable from `repo/`.

**Step 1 — every enumeration site.**

```sh
rg -n 'Object\.keys\(|Object\.entries\(|for \(const \w+ in ' src/
```

88 hits on the measured tree.

**Step 2 — keep only the rebuilds.** Read each hit's loop body and keep it only if the body
**assigns into a plain object by computed key**. "Plain object" means one whose prototype is
`Object.prototype`: an object literal, a `{} as T` cast literal, or a pre-existing plain object being
mutated. Dropped, each with its reason recorded in [What the method excluded](#what-the-method-excluded):
spreads, `Map`/`Set` targets, array pushes, `Object.fromEntries`, `Object.create(null)` targets,
string building, and assignment by a literal (non-computed) key.

**17 sites survive.** They are the population below.

A reading aid, not a substitute for step 2 — it finds the assignments, which you then match back to
an enumeration:

```sh
rg -n '\[[a-zA-Z_$][\w$.]*\]\s*=[^=>]' src/
```

Its extra hits are the subject of [What the method does not reach](#what-the-method-does-not-reach).

---

## The population

Reachability answers the FR-011 question — **reachable from model- or CLI-derived input** — derived
by reading each site's call chain, not inferred from the code's neighbourhood.

| # | Site | What it rebuilds | Key source | Reachable? |
|---|---|---|---|---|
| 1 | `src/lib/logger.ts:439-451` | every sanitized log record | any object a caller logs | **Was yes — repaired** |
| 2 | `src/services/phase-log/phase-log-display-projector.ts:24-30` | `toolArguments`, recursively | `JSON.parse` of a CLI `stream.jsonl` line | **Yes — unguarded** |
| 3 | `src/services/phase-log/phase-log-sanitizer.ts:81-89` | `toolArguments`, recursively | site 2's output | **Yes — unguarded** |
| 4 | `src/state/connected-run-migrator.ts:67-87` | the connected-run map | persisted workspace state | No — see [persisted state](#the-persisted-state-cluster) |
| 5 | `src/state/connected-workflow-run.ts:179-183` | a persisted run, deep-copied | persisted workspace state | No — same |
| 6 | `src/state/workspace-state.ts:1313-1329` | the run-state map, on read | persisted workspace state | No — same |
| 7 | `src/state/workspace-state.ts:1550-1552` | the queue-state map, on read | persisted workspace state | No — same |
| 8 | `src/state/workspace-state.ts:1673-1680` | the queue-state map, on write | site 7's output | No — same |
| 9 | `src/state/workspace-state.ts:2408-2411` | terminal-transition intents | persisted workspace state | No — same |
| 10 | `src/state/workspace-state.ts:2500-2502` | the history map | persisted workspace state | No — same |
| 11 | `src/state/queue-state-migrator.ts:711-713` | queue states, v9→v10 | persisted workspace state | No — same |
| 12 | `src/state/queue-state-migrator.ts:962-967` | collapsed queue states | site 11's output | No — same |
| 13 | `src/state/git-plan-grants.ts:106-111` | the plan-grant map | persisted workspace state | No — same, and see the note |
| 14 | `src/config/workflow-definition-validator.ts:131-135` | unknown authored fields, carried | a catalog row (`JSON.parse` of the catalog file) | No — see the note |
| 15 | `src/ui/sidebar/display-projection.ts:62-80` | the projected `display` map | `recognizedAuthoredDisplay`'s output | No — upstream key allowlist |
| 16 | `src/runner/spawn-env.ts:115-120` | the spawn environment | `process.env` | No — upstream name allowlist |
| 17 | `src/config/general-settings.ts:303-380` | the settings snapshot | `Object.keys(KEY_SPECS)` | No — a module constant |

Two of the seventeen are reachable from CLI output, and neither is guarded.

<!-- Source: src/services/phase-log/phase-log-display-projector.ts -->
<!-- Source: src/services/phase-log/phase-log-sanitizer.ts -->

---

## Site notes

### Sites 2 and 3 — the phase-log projector and sanitizer

The chain is short and has no guard in it:

```text
phase-log-jsonl-parser.ts:34   JSON.parse(line)
  → phase-log-display-projector.ts:145   projectStreamJsonlLine(parsed)
    → :43   buildToolArguments(input)
      → :25-28   out[k] = elideValueAtDepth(v, depth + 1)
```

Both `phase-log-reader.ts:203` and `phase-log-tail-session.ts:170` call the projector with a line the
parser produced with `JSON.parse`, so an own `__proto__` key is exactly what arrives when a tool call
carries an argument by that name. `elideValueAtDepth`'s object branch then rebuilds it, and the
sanitizer at site 3 rebuilds the projector's output the same way.

The consequence for an operator is the one FR-R3-166 named: an argument named `__proto__` disappears
from the Phase log with no marker, because `JSON.stringify` does not serialise a prototype. There is
no elevation here — the rebuilt object is local to one display entry, and the global
`Object.prototype` is untouched (measured; see `tests/unit/lib/logger-proto-key.test.ts`) — but the
displayed record is not what the CLI wrote.

One value shape behaves differently enough to name separately. When the incoming `__proto__` value
is JSON `null` rather than an object, the setter does not ignore it — it sets the *rebuilt object's*
prototype to `null`. That object then has no `hasOwnProperty`, no `toString` and no
`Symbol.toPrimitive`, so a later `value.hasOwnProperty(...)` or an implicit string coercion of that
one display value throws a `TypeError` rather than returning a wrong answer. Measured on Node
v24.19.0: `Object.getPrototypeOf(out)` is `null`, `out.hasOwnProperty` is not a function, and
`String(out)` throws `Cannot convert object to primitive value`. The blast radius is the same one
the paragraph above describes — a single display entry, no elevation, `Object.prototype` untouched
— but the failure mode is a throw in the render path, not a silently dropped field, and a reader
scoping the repair for these two sites should size it against both.

This census does not fix them. Site 1's repair is scoped to `src/lib/logger.ts` by FR-006, and these
two sit behind a different contract: their output feeds a renderer, not a durable audit sink, so the
disposition question (rename, preserve, or drop) has to be asked again against that contract rather
than answered by copying site 1's ruling.

### The persisted-state cluster

Sites 4–13 all enumerate a map the extension itself persisted — VS Code memento storage, read back as
parsed JSON, so an own `__proto__` key is producible in principle. It is not producible by model or
CLI output: nothing a run emits is written into these maps as a key. Producing one requires an actor
who can already write the extension's persisted state, and that actor has strictly better options.

Recorded, not repaired, and not ranked as a finding.

### Site 13 — the plan-grant map

Worth one extra line because its guard looks stronger than it is. `reject()`
(`git-plan-grants.ts:161-176`) requires `entry.fingerprint === key`, which reads like a
hash-shaped-key check but is only a self-consistency check: an entry whose `fingerprint` field is
literally `"__proto__"` satisfies it. The reachability answer is unchanged — the actor still has to
write the persisted map — but the guard is not what stops them.

### Site 14 — the unknown-field carry-over

`unrecognizedFields` keeps every key the format does **not** recognise (`workflow-definition-validator.ts:126-135`),
so it is an anti-allowlist: `AUTHORED_WORKFLOW_FIELDS.has('__proto__')` is false and the key is
therefore selected for the carry-over. Of its three callers, `workflow-catalog.ts:135` reads rows from
the catalog file on disk. The YAML import path (`workflow-document.ts:551`) cannot deliver such a key:
`package-reader.ts:98-107` builds its mapping with `Object.create(null)`, and `admitSection` copies
only allowlisted keys into the raw row, reporting anything else as an unknown field.

Not model- or CLI-derived. Notable anyway because the design intent — "an authored row must survive a
round trip without losing data" — is the one this shape silently defeats for exactly one key name.

### Sites 15, 16, 17 — guarded by their key sets

- **15**: the map it walks is always `recognizedAuthoredDisplay`'s output, whose keys come from
  `AUTHORED_PHASE_FIELDS` / `AUTHORED_WORKFLOW_FIELDS` / `AUTHORED_PIPELINE_FIELDS` — module constants.
- **16**: `selected[name]` runs only when `approved.has(name) || name.startsWith('LC_')`. `__proto__`
  is in no allowlist and starts with `_`. The result is then spread (`{...selected, ...overlay}`),
  which uses `CreateDataProperty` and is not subject to the setter at all.
- **17**: the loop enumerates `KEY_SPECS`, a module constant, and assigns `spec.typedField`. In the
  population by the letter of step 2; hazardous only if the constant itself declared the name.

---

## Prior art in this tree

Three strategies already exist here, and the differences between them are contract differences, not
taste.

**`Object.fromEntries` with the name skipped** — `src/audit/audit-payload.ts:315-330` and `:354-370`.
Feature 194's finding 24. `CreateDataProperty` makes a genuine own property, and the key is then
skipped outright so the literal name never reaches the audit log. The comment at `:316-322` records
why. This is the in-tree reference implementation for a **durable, read-back** sink.

**`Object.create(null)`** — `src/services/process-yaml/package-reader.ts:98-107` (with the reasoning at
`:92-97`) and `src/controller/phase-retry-evaluator.ts:306` (at `:304-305`). Correct where the result
is consumed internally and no caller inspects its prototype. Unavailable to site 1: `sanitizeRecord`
returns `T extends Record<string, unknown>` to callers whose acceptance boundary is
`Object.getPrototypeOf(result) === Object.prototype`, which `Object.create(null)` fails on *every*
input rather than fixing on one.

**Rename to `[__proto__]`** — `src/lib/logger.ts:439-451`, this feature. Keeps `Object.prototype`,
keeps the value, and carries an inert name into the sink. Chosen over `fromEntries` because
`fromEntries` alone would preserve the hazard-shaped name in durable evidence, which is what finding
24 declined.

<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/services/process-yaml/package-reader.ts -->
<!-- Source: src/controller/phase-retry-evaluator.ts -->

---

## What the method excluded

All 71 step-1 hits that step 2 dropped, grouped by the reason they were dropped.

**Derives a key set into an array or a `Set`; assigns nothing** (17):
`task-transition-decision.ts:73`, `ownership-fs.ts:310`, `execution-lease.ts:275`,
`queue-manager.ts:1736`, `:1740`, `queue-state-migrator.ts:993`,
`entry-point-dispositions.ts:137`, `:141`, `settings-schema.ts:436`,
`sidebar-command-metadata.ts:144`, `general-settings-keys.ts:423`, `run-state-migrator.ts:139`,
`history-state-migrator.ts:115`, `cmd-save-models.ts:51`, `workspace-state.ts:1559`,
`scheduled-work-wiring.ts:212`, `sidebar-ipc.ts:890`.

**Counts or length-tests the key set only** (8): `workspace-state.ts:1156`, `:2641`,
`phase-sidecar-reader.ts:363`, `cmd-ping-backend.ts:13`, `uncontained-grant.ts:71`,
`sidebar-ipc.ts:962`, `:1004`, `src/parser/invocation-usage.ts:184`.

**Scans for unknown or undeclared fields; read-only** (13):
`workflow-graph-validator.ts:388`, `process-definition-validator.ts:200`,
`pipeline-definition-validator.ts:217`, `:467`, `:616`, `workflow-definition-validator.ts:188`,
`:257`, `:292`, `:309`, `:382`, `:463`, `connected-workflow-run.ts:153`,
`src/contracts/validators/shared.ts:77`.

**Iterates to read, filter, or collect into an array, `Map`, or `Set`** (23):
`spawn-identity-recorder.ts:45`, `changed-fields.ts:94`, `:95`, `history-store.ts:129`,
`queue-manager.ts:1758`, `:1786`, `configuration-trust-dispositions.ts:265`,
`workflow-export-selection.ts:86`, `workspace-state.ts:1227`, `:1700`, `:1738`, `:2295`, `:2314`,
`connected-workflow-run.ts:296`, `schedule-watchdog.ts:167`, `stage2-producers.ts:251`,
`workflow-controller.ts:923`, `sole-run-resolver.ts:49`, `pipeline-config.ts:433`, `:441`,
`general-settings.ts:189`, `scheduled-start-coordinator.ts:343`, `phase-execution-wiring.ts:115`.

**Builds a string** (5): `prompt-builder.ts:88`, `:89`, `model-catalog.ts:26`,
`phase-log-display-projector.ts:158`, `src/catalog/canonical-json.ts:135` — the last sorts a key set and
serialises through `parts.push`; it never assigns.

**Targets `Object.fromEntries`** (3): `audit-payload.ts:324`, `:362`, `export-audit.ts:100`.

**Not code** (1): `yaml-serializer.ts:6`, a comment.

**Documentation of the shape, not an instance** (1): `workspace-state.ts:2324`, a JSDoc line.

---

## What the method does not reach

Step 1 finds enumeration sites. A computed-key assignment whose key comes from somewhere else — a
constant list, a `Map`, an array of records, a parsed line — is invisible to it. The reading-aid grep
above finds those. None is a rebuild of an enumerated object, so none is in the FR-010 population, but
three take their key from outside the host and are recorded here so a reader does not conclude the
census cleared them.

- **`src/controller/phase-sidecar-reader.ts:405`** — `entries[key] = rawLine.slice(sep + 1)`, key
  parsed from sidecar bytes the CLI wrote. Guarded at `:397` by
  `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`, which rejects `__proto__` on its leading `_`, and at `:401` by an
  own-property check. This is the guard that keeps `sanitizeRecord`'s second caller safe.
- **`src/services/process-yaml/package-reader.ts:104`, `:127`** — keys from an authored YAML mapping.
  `Object.create(null)` at `:101`, and an `admitted` allowlist at `:121`. Deliberate; see the comment.
- **`src/services/workflow-execution/condition-context.ts:82-95`** — `nodes[fact.nodeId] = …`, key from
  an authored node id. It fails closed, though by accident: the duplicate check
  `nodes[fact.nodeId] !== undefined` reads the inherited accessor for `__proto__` and throws
  `condition context received two attempts for node __proto__` on the **first** occurrence. Loud and
  wrong-worded, rather than silent.

The rest take their key from a module constant, a numeric index, a `Map` the host populated, or a
field name the caller passed as a literal: `catalog-revision.ts:65`, `phase-log-truncator.ts:71`,
`:74`, `phase-log-sanitizer.ts:110`, `webview-log-sink.ts:70`, `:85`, `general-settings.ts:379`,
`:380`, `claude-cli-monitor.ts:464`, `authored-display.ts:56`, `:67`,
`backend-capability-service.ts:187`, `condition-context.ts:89`, `connected-run-factory.ts:137`,
`metrics-rollup.ts:292`, `audit-payload.ts:508`, `invocation-usage.ts:137`, `:148`,
`workspace-state.ts:2382`, `:2423`, `:2455`.

---

## Re-running this census

```sh
cd repo
rg -n 'Object\.keys\(|Object\.entries\(|for \(const \w+ in ' src/   # step 1
rg -n '\[[a-zA-Z_$][\w$.]*\]\s*=[^=>]' src/                          # reading aid
```

Then apply step 2 to each step-1 hit. A population that differs from the seventeen above means the
tree moved; update this file rather than the memory of it. If a new site is reachable from model or
CLI output, it needs a disposition ruling of its own — site 1's is recorded at
`src/lib/logger.ts:397-438` and is specific to a durable, read-back sink.
