# Workspace ownership and execution leases

Schegent uses two independent lease families. They share the same heartbeat and stale-reclaim timing, but they answer different questions and must not be treated as one lock.

| Lease | Scope | What it authorizes | Cardinality |
|---|---|---|---|
| **Window primacy** | Entire canonical workspace | Authoritative host mutations and primary projections | One holder per workspace |
| **Execution lease** | One queue | Draining and driving that queue | One holder per queue; different queues may have different holders |

Holding a queue's execution lease does not make a window primary. Losing primacy also does not silently transfer or erase a queue lease. This separation permits multiple queues to execute without allowing multiple extension hosts to mutate shared workspace state as primary.

<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->

## How election works

Both lease types are arbitrated through the fenced ownership registry. The registry stores generation-numbered ownership records under `.schegent/ownership/`; acquisition uses exclusive file creation, and a successful claim returns a fence number. Later verification, heartbeat, guarded write, and release operations must present the matching resource, owner ID, and fence.

The persisted VS Code Memento lock and execution-lease records remain advisory mirrors for synchronous projection. Mutating decisions use the asynchronous authoritative checks `hasPrimacy()` and `hasLease()`, which fail closed when ownership storage cannot answer.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/workspace-state.ts -->

## Timing and recovery

The shared heartbeat interval is 5 seconds and the staleness threshold is 15 seconds. A live holder refreshes its record; a contender may reclaim only after the recorded heartbeat is stale. A revived predecessor keeps its old fence, so authoritative verification rejects it after a newer generation has been issued.

Window primacy is acquired for the extension host's activation-to-disposal tenure. Its heartbeat may attempt reacquisition after discovering that its generation was rejected. An execution lease is queue-scoped; if its heartbeat is rejected, that queue's local fence and matching advisory mirror are dropped rather than automatically reclaimed by the heartbeat path.

<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: tests/integration/multi-window/ownership-election.test.ts -->

## What an operator sees

- A non-primary window can project the workspace but mutation gates reject authoritative changes.
- If another host owns a queue's execution lease, the local drain treats contention as an ordinary deferral rather than starting a second Run for that queue.
- After a holder disappears without releasing, another host can reclaim the resource once the heartbeat passes the stale threshold.
- Storage errors do not grant ownership. Acquisition and authoritative checks refuse or return false.

Do not infer ownership from an old mirror value alone. The fence-backed record is the decision source, while mirror accessors exist for projection and diagnosis.

<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
