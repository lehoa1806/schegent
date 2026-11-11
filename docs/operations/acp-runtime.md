# ACP Agent Runtime (`FR-R6-F13`)

**Declared**: 2026-11-11 (`specs/312-acp-agent-runtime/spec.md`)

This guide is for an operator or maintainer who needs to know what the host's Agent Client
Protocol (ACP) runtime does, what it refuses and why, and which agent profiles it may open. The
runtime is one host-owned ACP client: it opens one connection to one agent process, negotiates
capabilities, creates or loads sessions, sends prompts, and maps what the agent streams back to
the host's existing event shapes.

The runtime never accepts a phase result. A prompt that ends with `end_turn` still needs the
host's own result validation (`hostValidationRequired: true`).

Implemented in:
- [`src/contracts/acp-runtime.ts`](../../src/contracts/acp-runtime.ts)
- [`src/services/acp-runtime/`](../../src/services/acp-runtime/index.ts)

## Production status

The runtime, its stdio transport, its maintained stdio bridge (`dist/acp-stdio-bridge.js`), and its
three built-in profiles (`agy-acp-native`, `claude-acp-bridge`, `codex-acp-bridge`) ship in the
package. Production dispatch routes new-architecture attempts through `AcpBackedRunner` while
draining any pre-cutover in-flight legacy CLI attempts without dual live authority. Profiles are
host-owned constants; repository text cannot install or replace an agent profile. Qualification is
recorded per platform (`darwin/arm64` qualified from local host observations; Linux, Windows, and
remote extension hosts remain `unqualified` and refuse before spawn).

## Protocol

- ACP protocol version `1` only. An agent that answers `initialize` with any other version is
  refused (`protocol-version-unsupported`) before a session is created.
- UTF-8 JSON-RPC 2.0, one message per newline-terminated line, on the agent's stdin and stdout.
  Stderr is never parsed as protocol; it is kept as a diagnostic tail.
- The client advertises no filesystem and no terminal methods. Any agent request for them, or
  for any method other than `session/request_permission`, is answered with JSON-RPC error
  `-32601` (method not found) and counted in `refusedAgentRequests`.
- The host configures no MCP server. ACP v1 requires a server list on `session/new` and
  `session/load`, so the client always sends the empty list. The expansion freeze
  (`FR-R3-086` §5) still forbids every other MCP spelling in `src`, including a non-empty list;
  `tests/lint/expansion-freeze.test.ts` allows only that empty literal, in the ACP client.
- Agent stdin is written through the shared line channel in `src/runner/child-stdin.ts`
  (`FR-R3-047`): the error listener is attached before any byte, so a dead agent pipe cannot
  crash the host. A line the channel refuses is never treated as written, and a pipe that breaks
  after a line was taken fails the connection (`transport-closed`) even while the agent process
  is alive.
- One pipe read can hold several messages. Each message's effect on session and turn state is
  applied before the next message is routed, so an update that follows a response in the same
  read is attributed against the state that response left.
- No ACP SDK is used; the client is written in the host with no new dependency.

## Lifecycle

1. **Qualification.** `openAcpConnection` checks the profile first. An `unqualified` profile, or
   a `fixture` profile when the caller did not allow fixtures, is refused
   (`profile-unqualified`) and nothing is launched.
2. **Launch.** The host's launch function turns the profile's executable reference into a
   command, arguments and environment. The stdio transport spawns it with no shell, in its own
   process group on POSIX. Secrets travel only in the environment.
3. **Handshake.** `initialize` must answer within 5 seconds. A stalled agent fails with
   `handshake-deadline`; a wrong version or a malformed answer is refused. Any refusal after
   launch closes the transport before the result is returned.
4. **Profile requirements.** Each capability the profile requires (`load-session`,
   `embedded-context`, `image`, `audio`) must have been granted, or the open is refused
   (`capability-missing`, with the capability as the detail).
5. **Sessions.** `newSession(cwd)` and `loadSession(sessionId, cwd, { mayLoad })` each have the
   same 5-second deadline. A load is attempted only when the agent granted `loadSession` and the
   caller's dispatch decision allows it; otherwise it is refused (`capability-missing` or
   `fresh-session-required`).
6. **Prompts.** One prompt may be outstanding per session. A prompt has no runtime deadline; the
   phase bounds govern it.
7. **Close.** `close()` drains, closes the transport and ends in `closed`. Transport close is
   idempotent: it ends stdin, sends SIGTERM to the process tree, escalates to SIGKILL after
   2 seconds, and returns on exit or after the shared teardown bound.

## Prompt outcomes

| Outcome | Meaning |
|---------|---------|
| `completed` | The agent ended the turn (`end_turn`, `max_tokens`, `max_turn_requests` or `refusal`). Host validation is still required. |
| `cancelled` | The agent ended the turn after `session/cancel`. Host validation is still required. |
| `uncertain` | The prompt was written and no response arrived (connection lost, cancel bound elapsed). It is never retried by the runtime. |
| `not-dispatched` | The prompt was never written: the request limit was reached, or the agent's stdin refused the line. |
| `refused` | The host declined the prompt before writing it. |
| `rejected` | The agent answered with a JSON-RPC error; the code is kept. |

A retry is always a new host attempt. The runtime never replays a prompt through a new request,
a session load, another profile or another transport.

## Refusals

A refusal means the host declined a request before it reached the agent.

| Reason | When |
|--------|------|
| `profile-unqualified` | The profile's qualification does not allow opening it. |
| `protocol-version-unsupported` | The agent answered `initialize` with a version other than 1. |
| `capability-missing` | A required or operation capability was not granted. |
| `fresh-session-required` | The caller's dispatch decision does not allow loading a session. |
| `resource-inaccessible` | A resource link failed the host's verification. |
| `prompt-in-flight` | The session already has an outstanding prompt. |
| `connection-not-ready` | The connection is not `ready` (initializing, draining, closed or failed). |
| `session-unknown` | The session id was not created or loaded on this connection. |
| `protocol-violation` | The agent's `initialize` answer is malformed, or its session id is unusable; the connection also fails (see below). |
| `invalid-input` | The host's own input was malformed: a prompt request, or a session id to load that breaks the identifier rule or is already open. |
| `prompt-oversized` | The encoded prompt content is over 2 MiB. |

## Connection failures

A failure ends the connection and settles every pending request.

| Reason | When |
|--------|------|
| `malformed-frame` | A stdout line is not UTF-8 or not JSON. It is never skipped. |
| `frame-oversized` | One decoded message is over 2 MiB. |
| `pending-bytes-exceeded` | More than 8 MiB of undecoded bytes is held. |
| `request-limit-exceeded` | More than 64 requests are outstanding in both directions together. |
| `handshake-deadline` | `initialize`, `session/new` or `session/load` took over 5 seconds. |
| `transport-closed` | The agent process exited, its pipes closed, or its stdin refused or lost a line. An agent that only stops reading is not detected here; the deadlines and the phase bounds govern it. |
| `cancel-bound-elapsed` | A cancelled prompt got no response within 5 seconds of `session/cancel`. |
| `protocol-violation` | A message that is not JSON-RPC, a reused agent request id, a session id from `session/new` that is missing, duplicate or breaks the identifier rule, or a prompt response with no valid stop reason. |

## Bounds

| Bound | Value |
|-------|-------|
| Handshake deadline (`initialize`, `session/new`, `session/load`) | 5 s each, from the write |
| Cancel bound before teardown | 5 s from `session/cancel` |
| Outstanding requests per connection | 64, both directions |
| Decoded message, and encoded prompt content | 2 MiB |
| Undecoded bytes held | 8 MiB |
| Stderr tail | the latest 64 KiB, control characters removed |
| ACP session id, tool call id and permission option id | 1 to 256 characters, none of them a control, format, surrogate or line-separator character |
| Options in one permission request | 32 |
| SIGTERM to SIGKILL in transport close | 2 s |
| Mapping latency per bounded message | at most 5 ms p95 (`tests/perf/acp-normalization.test.ts`) |

## Cancellation and permissions

`cancel(sessionId)` fences new requests, answers every pending permission request `cancelled`,
writes `session/cancel`, and keeps accepting the cancelled turn's updates until its response.
Without a response within 5 seconds, teardown runs once, the connection fails with
`cancel-bound-elapsed`, and the prompt is `uncertain`.

Permission requests go to a host-supplied policy. The tool title in a request is the agent's own
text, passed as received; a policy must not log or render it raw. With no policy, or one that answers
`undecided`, the answer is a reject option the agent offered (`reject_once` first); with no
reject option, it is `cancelled`. During or after cancellation every answer is `cancelled`.

## Identities and history

The ACP session id, any provider session id, the connection generation, the JSON-RPC request id
and the host's attempt are separate fields; equal strings never join them. Each observation
carries its connection generation and a host receive sequence that grows by one per observation.
Request ids are local to one connection: the same id on a new generation is a different request.

An identifier the agent supplies is kept as a session key, a display row key or a value given to
the permission policy, and no display sanitizer passes over those. So the identifier rule is
applied on receive: 1 to 256 characters, with no control, format, surrogate or line-separator
character (Unicode categories Cc, Cf, Cs, Zl, Zp). Spaces and punctuation are allowed.

- A session id that breaks the rule fails the connection (`protocol-violation`) when it comes
  from `session/new`, and is refused (`invalid-input`) when the host asks to load it.
- A tool call id that breaks the rule is dropped: the event is still shown, with no source
  event id.
- A permission request whose session id or option id breaks the rule is answered with JSON-RPC
  invalid params and never reaches the policy; a tool call id that breaks it is passed as null.

Every update received while `session/load` is outstanding is `history`. It carries no attempt
id, and its usage is a replayed update, never new usage. An update for another session id is
stale, dropped and counted.

## Mapping

| ACP `session/update` | Host event |
|----------------------|------------|
| `agent_message_chunk`, `user_message_chunk` | F07 `message` |
| `agent_thought_chunk` | F07 `status` |
| `tool_call` | F07 `tool-call` |
| `tool_call_update` with a terminal status | F07 `tool-result`; a non-terminal update is ignored |
| `plan` | F07 `plan`, one row listing each entry with its status, in the agent's order |
| `usage_update` (`used`, `size`, optional `cost`) | F06 usage update |
| any other kind | ignored and counted in `ignoredUpdates` |

Each observation also maps to F02's `AcpEventEnvelope` through `toSharedAcpEnvelope`:

- Turn start and completion carry the request id as a decimal string. Only a live observation of
  a prompt carries a turn id.
- ACP `cancelled` is F02 `canceled`. `max_turn_requests` and `refusal` have no F02 stop reason.
- A usage envelope has no `usageDelta`: ACP `used` and `size` are context occupancy, not tokens.
  Accounting goes through F06 alone.

## Projection

`describe()` returns what a host surface may show:
- the profile id, revision and kind, and its qualification;
- the declared attribution;
- the generation, state and negotiated capabilities;
- the last refusal and last failure;
- the session count and the counters.

It never holds a command, argument or environment value. No UI shows it yet.

## Release matrix

Qualified profiles on `darwin/arm64`: 3 (`unqualified` on Linux, Windows, and remote hosts until observed on those targets)

| Profile | Kind | Qualification (`darwin/arm64`) | Maintenance owner | Notes & residuals |
|---------|------|--------------------------------|-------------------|-------------------|
| `claude-acp-bridge` | `bridge` | `qualified` | Schegent runtime maintainers (`src/services/acp-runtime/bridges/`) | Maintained ACP v1 stdio bridge (`dist/acp-stdio-bridge.js` `1.0.0`) fronting `claude` `2.1.322` (`-p --output-format stream-json --verbose`). Credential-free local binary/handshake verified; live provider turns depend on operator credentials. |
| `codex-acp-bridge` | `bridge` | `qualified` | Schegent runtime maintainers (`src/services/acp-runtime/bridges/`) | Maintained ACP v1 stdio bridge (`dist/acp-stdio-bridge.js` `1.0.0`) fronting `codex-cli` `0.163.0` (`exec --json` / `exec resume --json`). Preserves `codex` `--sandbox` flags and section 10 containment residuals. |
| `agy-acp-native` | `native` | `qualified` | Schegent runtime maintainers (`src/services/acp-runtime/profiles.ts`) | Native `agy acp --stdio --disable-telemetry` (`agy` `1.5.5`, `Antigravity ACP Server` protocol v1, `loadSession: true`, `embeddedContext: true`). Credential-free handshake verified on `darwin/arm64`. |
| Fixture agent | `native` / `bridge` | `fixture` | Host test suite | Deterministic fixtures only (`tests/fixtures/acp/`); never opened in production (`allowFixtureProfiles` omitted). |

Unverified platforms (`linux/*`, `win32/*`, `darwin/x64`) resolve `acpQualificationForPlatform` to
`unqualified`, causing `openAcpConnection` to refuse with `profile-unqualified` prior to process
launch without falling back to legacy direct-CLI dispatch.
