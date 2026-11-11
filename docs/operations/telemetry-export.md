# Optional OpenTelemetry Export (`FR-R6-F14`)

**Declared**: 2026-11-11 (`specs/313-optional-opentelemetry-export/spec.md`)

This guide is for an operator or maintainer who needs to know what the optional telemetry
exporter sends, what it never sends, which destination it accepts and why it refuses one, and
what happens to a batch that cannot be delivered. The exporter copies usage and duration
metadata to one OpenTelemetry collector over OTLP/HTTP with a JSON body. It is off unless a
profile turns it on, and it never changes what the host stores locally.

Implemented in:
- [`src/contracts/telemetry-export.ts`](../../src/contracts/telemetry-export.ts)
- [`src/services/telemetry-export/`](../../src/services/telemetry-export/index.ts)

## Production status

This release ships package F14-A: the exporter, its mapping, its queue and a real OTLP/HTTP
transport, with their tests. Nothing in activation constructs them, and no file outside
`src/services/telemetry-export/` imports the module (`tests/lint/expansion-freeze.test.ts`
holds both facts). There is no setting that turns export on, so an installed build sends
nothing. Wiring is F14-B (see Deferred).

The exporter is the only network client in host source. Only its transport file imports a
network module, and the same lint file fails if any other source does.

## What is exported

Three kinds of source record are accepted (source schema `1`):

- a **usage** record: up to 16 measures (input tokens, output tokens, cache-read tokens,
  cache-creation tokens, cost), each with its completeness and provenance;
- an **operation** record: one duration in milliseconds and the attempt outcome;
- a **correction** record: one measure with the quantity exported before and the quantity that
  replaces it.

Each record carries a backend name and up to two model names. Those three fields are the only
free-form values that can become labels.

## What is never exported

- Prompts, responses, tool input or output, file content, diffs, or any other content. A
  profile whose content policy is not `metadata-only` is refused.
- Workspace, root, Run, attempt, session, phase and workflow identifiers. They are not part of
  the record shape the exporter accepts; a record is copied field by field, so an extra field
  is left behind.
- Paths, credentials and free text in a label field. A backend or model value is sent only when
  it passes the usage ledger's dimension rule (`sanitizeDimension`): a closed pattern, at most
  256 UTF-8 bytes, and not changed by the logger's secret detector. A value that fails is left
  out and counted `excluded-dimension`; the measure is still exported without that label.
- A value the source does not have. A missing quantity is counted `missing`; it is never sent as
  zero.
- Anything from the destination. Of a response the exporter keeps the status code and the
  rejected data point count, and nothing else.
- Traces and logs. Only the `metrics` signal is supported.

The source identity and revision of a record are used locally to recognise a second copy. They
are hashed with the profile id and the mapping revision (SHA-256) and the hash stays in the
ledger; neither the identity nor the hash is sent.

## Profile and refusals

A profile names one destination: an id, a revision, a scope, the protocol, the signals, the
content policy, the endpoint, whether plaintext to loopback is allowed, and an optional
credential reference (a secret-store reference and a header name, never the value).

Export is off (`disabled`) unless exactly one profile has `enabled` set to exactly `true`. An
entry that is not an object can never turn export on. An enabled profile is checked in this
order, and the first failing rule is the reason:

| Reason | When |
|--------|------|
| `multiple-active-profiles` | More than one profile is enabled. Checked before any other rule. |
| `profile-invalid` | The profile has an unknown key, a missing field, a wrong type, or an id or revision outside its pattern. |
| `scope-not-authorized` | The scope is not `user`. Repository-controlled settings cannot name a destination. |
| `workspace-untrusted` | The workspace is not trusted. |
| `protocol-unsupported` | The protocol is not `otlp-http-json`. Protobuf and gRPC are declared and refused. |
| `signal-unsupported` | The signals are not exactly `metrics`. |
| `content-export-unsupported` | The content policy is not `metadata-only`. |
| `endpoint-invalid` | The endpoint is empty, longer than 2,048 characters, not printable ASCII, not `https` or `http`, has user information, a query, a fragment, a backslash or no host. |
| `plaintext-not-loopback` | The endpoint is `http` and either plaintext is not allowed or the host is not `localhost`, `127.0.0.0/8` or `::1`. |
| `credential-header-invalid` | The header name is not an HTTP token, is longer than 128 characters, or is a header the transport owns (`host`, `content-length`, `content-type`, `transfer-encoding`, `connection`, `user-agent`, `accept-encoding`). |
| `secret-store-unavailable` | The profile has a credential and the protected secret store is not available. |

A refusal carries the reason only. No endpoint, header name or credential text is part of it.

The endpoint is used as the URL parser serializes it. No path such as `/v1/metrics` is
appended.

No OpenTelemetry environment variable is read. Host source names no `OTEL_` variable, and the
exporter reads no environment variable at all, so a variable set for another tool cannot turn
export on or change its destination.

## Instruments

Mapping revision `1`, semantic conventions `1.37.0`, protocol revision `1.7.0`. Every
instrument reports delta temporality. The scope is `schegent.telemetry-export` version `1`;
the resource carries `service.name` = `schegent` and `service.version` when the host gives one.

| Instrument | Kind | Unit | Source |
|------------|------|------|--------|
| `gen_ai.client.token.usage` | histogram | `{token}` | Input and output token measures. |
| `gen_ai.client.operation.duration` | histogram | `s` | Operation duration, converted from milliseconds. |
| `schegent.usage.cache_tokens` | monotonic sum, integer | `{token}` | Cache-read and cache-creation token measures. |
| `schegent.usage.cost` | monotonic sum, double | the currency code | Cost, converted from micros. |
| `schegent.usage.token_adjustment` | non-monotonic sum, integer | `{token}` | Corrections of a token measure. |
| `schegent.usage.cost_adjustment` | non-monotonic sum, double | the currency code | Corrections of cost. |
| `schegent.export.coverage` | monotonic sum, integer | `{outcome}` | One count per mapping outcome (see below). |

The two `gen_ai` instruments follow the OpenTelemetry generative AI conventions, which are at
Development stability upstream; their names and bounds can change in a later mapping revision.
The token histogram uses the convention's bounds (`1` to `67108864`, powers of four) and the
duration histogram its bounds (`0.01` to `81.92` seconds, doubling).

Labels:

- every instrument except coverage: `gen_ai.provider.name`, `gen_ai.request.model`,
  `gen_ai.response.model`, `schegent.backend`, each only when the value passes the dimension
  rule. The provider name is `anthropic` for the `claude` backend, `openai` for `codex`, and
  the backend's own name otherwise;
- the token histogram, cache tokens and cost add `schegent.usage.provenance` and
  `schegent.usage.completeness`;
- the token histogram adds `gen_ai.operation.name` = `invoke_agent` and `gen_ai.token.type`
  (`input` or `output`);
- cache tokens add `schegent.usage.cache_kind` (`read` or `creation`) and, when the source has
  it, `schegent.usage.cache_relation`;
- the duration histogram adds `gen_ai.operation.name`, `schegent.operation.outcome`, and
  `error.type` for a failed, cancelled or interrupted operation;
- the adjustment instruments add `schegent.usage.measure`;
- coverage has one label, `schegent.export.outcome`.

Cache tokens are a separate instrument because a cache measure can be a subset of the input
measure; putting both on the token histogram would count the same tokens twice.

## Corrections

A correction is exported as the difference between the replacement and the previous quantity
on an adjustment instrument, so it can be negative. The original data point is not resent. A
correction with no previous or no replacement quantity, or of a measure the mapping does not
know, exports nothing and is counted `correction-unquantified`.

A destination that wants corrected totals adds the adjustment sum to the original instrument.

## Coverage outcomes

Every measure, operation and correction gets one outcome, counted in health and sent on the
coverage instrument in the same batch:

| Outcome | Meaning |
|---------|---------|
| `exported` | A data point was added. |
| `missing` | The source had no quantity, or marked the measure's completeness unknown. Nothing is sent. |
| `unmapped` | The mapping revision has no instrument for the measure. |
| `out-of-range` | The value is past the largest safe integer, negative on a histogram or monotonic sum, not a whole number on an integer sum, or not finite. |
| `correction` | An adjustment data point was added. |
| `correction-unquantified` | The correction could not be expressed as a difference. |
| `excluded-dimension` | One label field failed the dimension rule and was left out. Counted once per field per record. |
| `overflow` | The data point was folded into the overflow set. |

## Overflow set

Each instrument keeps at most 1,000 attribute sets for the life of one exporter: the first 999
distinct sets it sees, then one overflow set with the single attribute
`otel.metric.overflow` = `true`. Every later new set is folded into the overflow set and counted
`overflow`. A set admitted before the limit keeps its own data points afterwards.

The limit is held in memory. A new exporter (a restart) starts counting again.

## Delivery

Accepted records collect in one open batch. It is sealed at 256 source records, when the next
record would take its estimated size over 1 MiB, or on `flush()`. A sealed batch's bytes never
change. Sealed batches wait in a memory queue of at most 8 MiB and are sent one at a time,
oldest first.

One request is one `POST` with `content-type: application/json`, a `content-length`, a fixed
`user-agent`, and the credential header when the profile has one. The transport uses no shared
agent, follows no redirect, reads at most 64 KiB of the response and ends the request at an
absolute deadline of 2 seconds. Certificate verification is the platform default and cannot be
turned off by a profile. For a plaintext loopback endpoint the name lookup fails unless every
resolved address is loopback.

| Result | Treatment |
|--------|-----------|
| HTTP `200` | Acknowledged. A partial success is acknowledged too; its rejected count is kept and it is not retried. A `200` with an empty, malformed or oversized body is acknowledged and the anomaly is shown as the last error. |
| HTTP `429`, `502`, `503`, `504` | Retried. `Retry-After` is honoured on `429` and `503` when it is a whole number of seconds. |
| A connection, TLS or deadline failure | Retried. |
| Any `3xx` | Dropped, `redirect-refused`. |
| Any other status | Dropped, `rejected`. |

A batch gets at most five retries, each after `500 ms x 2^(n-1)` scaled into the range from
half to all of that delay, and every retry must be able to finish within 30 seconds of the
first attempt. A destination that asks for a longer wait than that ends the batch at once.

Every batch ends in exactly one disposition, recorded in the ledger with the batch identity:

| Disposition | Reasons |
|-------------|---------|
| `acknowledged` | none |
| `expired` | `age` (older than 24 hours, never sent again), `retry-budget-exhausted` |
| `dropped` | `rejected`, `redirect-refused`, `queue-saturated`, `disabled`, `authorization-changed`, `shutdown`, `credential-unavailable`, `credential-invalid`, `batch-oversized` |

When the queue is full, the oldest batch that is not being sent is dropped
(`queue-saturated`). Disabling export, a change of destination or authorization, and shutdown
drop the open batch and every queued batch; a batch is only ever sent under the authorization
it was sealed under. `shutdown()` ends the request in flight and resolves within 250 ms.

The credential value is read from the secret store at most once per authorization, held only in
memory, and must be non-empty printable ASCII of at most 8,192 characters. A missing value drops
the batch `credential-unavailable`; a value outside the rule drops it `credential-invalid`.

## Bounds

| Bound | Value |
|-------|-------|
| Enabled profiles | 1 |
| Source records in one batch | 256 |
| Encoded bytes of one batch | 1 MiB |
| Memory queue | 8 MiB |
| Age at which a batch expires | 24 hours |
| Request deadline | 2 seconds |
| Retries of one batch | 5 |
| Retry budget from the first attempt | 30 seconds |
| Backoff base | 500 ms |
| Shutdown | 250 ms |
| Attribute sets per instrument, overflow set included | 1,000 |
| Response bytes read | 64 KiB |
| Endpoint length | 2,048 characters |
| Remembered copy identities (in-memory ledger) | 16,384 |
| Measures in one usage record | 16 |
| Mapping and queueing one batch of 256 records | 5 ms at p95 (`tests/perf/budgets.json`) |

A disk spool bound of 32 MiB is declared for F14-B. Nothing in this release writes a spool.

## Health

`health()` returns counts, times and closed classes only: the state, the mapping revision, the
time of the last acknowledgement, queued batches and bytes, acknowledged, expired and dropped
batches with their reasons, duplicate, invalid and unsupported-schema records, refused offers,
rejected data points, ledger faults, the last error class and the coverage counts.

| State | Meaning |
|-------|---------|
| `disabled` | No destination is in force. |
| `retrying` | The batch at the head of the queue has failed an attempt and is not finished. |
| `degraded` | A batch expired, or was dropped for a reason other than disable, authorization change or shutdown, and no batch has been acknowledged since. |
| `healthy` | A destination is in force and neither of the above holds. |

The last error is one of `network`, `tls`, `deadline`, `http-retryable`, `http-rejected`,
`redirect-refused`, `response-malformed`, `response-oversized`, `credential-unavailable` and
`credential-invalid`. No endpoint, header, credential or response text can reach health. A new
or cleared destination starts with no last error. No UI shows health yet.

Export failure never blocks or fails a Run. No exporter method throws to its caller; a throw
from the transport, the secret store or the ledger is caught and counted.

## Limits

- **A retransmitted batch can be counted twice.** If a request reaches the destination and its
  acknowledgement is lost, the batch is sent again with the same bytes. OTLP metrics carry no
  batch identity, so a destination cannot tell the second copy from the first, and delta data
  points are added twice. Local records are unaffected.
- **A model label is bounded by pattern, not by meaning.** A model value that fits the model
  pattern and does not look like a credential is exported as given. The source adapter (F14-B)
  must not put a session or Run identifier in a backend or model field. The overflow set is the
  only limit on how many distinct values reach a destination.
- **The copy ledger is in memory.** It remembers 16,384 copy identities, oldest forgotten
  first, and is empty after a restart. A record offered again after either can be exported
  again. The durable ledger is F14-B.
- **Certificate authorities are a process setting.** `NODE_EXTRA_CA_CERTS` and the platform
  trust store decide which certificates verify. The exporter cannot narrow them.
- **Batches do not survive a restart.** Queued and open batches are dropped at shutdown.
- **The proxy environment is not read.** Every request goes straight to the destination, also
  when Node is started with its environment-proxy option. A network that reaches the
  destination only through a proxy cannot export. Proxy support is an F14-B decision.
- **A peer that does not speak TLS can be reported as `network`.** The failure class comes from
  the error code alone. A peer that closes the connection during the handshake gives a
  connection error code, so the last error in `health()` is `network`, not `tls`.

## What was not observed

No live provider and no real collector was used. The request shape is checked against a
committed fixture built from the published OTLP/HTTP JSON rules, and delivery is exercised
against a local fixture collector on loopback. No claim is made that any named collector or
vendor accepts these requests.

## Deferred

- **F14-B**: the settings surface for a profile, the editor secret-store adapter, the durable
  SQLite ledger, the file spool, activation wiring and the source adapter that offers records,
  and a health surface.
- **Content export** with a preview. Refused in this release (`content-export-unsupported`).
- **Traces and logs**, and the protobuf and gRPC protocols. Declared and refused.
