# Local-first does not mean offline execution

Status: Accepted product-boundary decision

Schegent keeps its extension host, queue state, catalog, audit records, runtime
log, session evidence, and UI projections on the operator's machine. That local
ownership boundary does not imply that an AI backend can execute without a
provider connection or credentials.

<!-- Source: src/extension.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

## Product decision

Offline AI execution is not a supported promise for the current product.
Claude, Codex, and Agy are external CLI programs selected by configuration, and
their provider communication is outside Schegent's local-state contract. A
binary being present and executable does not prove that authentication, DNS,
TLS, proxy configuration, quota, or a provider API will be available during a
Run.

The Dashboard states this boundary beside the queue composer before submission:
“Local-first, not offline: running this queue may contact configured backend
providers.”

<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: webview-ui/src/components/QueueInputForm.svelte -->
<!-- Source: tests/lint/product-boundary-decisions.test.ts -->

## What remains local

When the relevant files are readable, an operator can open Schegent, inspect
queues and Run history, read retained audit or transcript evidence, review the
catalog, and edit pending work without asking Schegent to contact a remote
service. These actions operate on local extension state and workspace files.

Starting or resuming a Phase is different. The selected backend is spawned as a
local child process, but that process may require network access. Normal runner
exit, timeout, rate-limit, credit, and authentication failures flow through the
controller's failure and retry policy; Schegent does not silently switch to a
different backend or model.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/controller/workflow-controller.ts -->
<!-- Source: src/controller/retry-handler.ts -->
<!-- Source: src/parser/credit-error-detector.ts -->

## Queue-only/no-execution behavior

Queue-only/no-execution behavior is an explicit operator choice, not an
automatic offline mode. Leave new work in `idle-pending`, or pause the target
queue before connectivity is removed. An armed scheduled start remains durable
and may attempt execution when due, so cancel the schedule or pause the queue if
no attempt should occur.

Enqueue admission still validates the description, target Pipeline, workspace
ownership, queue pause state, and seven-day schedule horizon. Those local checks
do not certify backend network readiness. When connectivity returns, the
operator may start or resume through the normal guarded path.

<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/services/guarded-run-service.ts -->
<!-- Source: src/services/scheduled-start-coordinator.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->

## Current probes are not an offline certificate

Backend capability discovery runs a bounded `--help` probe for each registered
runner. It reports executable availability and, where supported, model discovery
results. The operator Ping action reuses that probe. Neither path sends a sample
workspace request to a provider, and neither promises future network or account
availability.

Probe failures are deliberately structural and paths-free: not found, not
executable, nonzero exit, timeout, or unknown. Success means that the local CLI
accepted the bounded command. It does not mean “offline capable.”

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: src/services/backend-ping-service.ts -->
<!-- Source: src/activation/backend-wiring.ts -->

## Capability-discovery prototype

A future offline-capable adapter should advertise that capability explicitly
instead of overloading binary availability. A prototype projection could be:

```ts
interface BackendExecutionCapability {
  runner: string;
  binary: 'available' | 'unavailable';
  execution: 'network-required' | 'offline-capable' | 'unknown';
  readiness: 'ready' | 'not-ready' | 'unknown';
  checkedAt: string;
  reasonCode?: string;
}
```

For an `offline-capable` result to become a product promise, discovery must be
bounded and cancelable, must not transmit workspace content merely to probe,
must distinguish a local engine from a cached credential, and must identify
which models and tools remain functional without network access. The execution
path must then consume the same capability result or revalidate it at admission;
a decorative UI badge alone is insufficient.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: src/contracts/backend-runner.ts -->

## Reconsideration trigger

Reopen this decision when Schegent ships a backend whose supported execution
contract is demonstrably local, or when the product introduces a first-class
offline mode with admission, UI, retry, and scheduled-start behavior designed
around loss of connectivity. Until then, “local-first” describes ownership of
state and orchestration, not the network behavior of the configured AI CLI.

<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: webview-ui/src/components/QueueInputForm.svelte -->
