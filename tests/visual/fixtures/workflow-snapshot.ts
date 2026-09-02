// The Playwright visual suite's one hand-written snapshot, published into the
// webview via a `STATE_SNAPSHOT` message.
//
// A TypeScript module rather than JSON so the compiler adjudicates it. This
// fixture stands in for a host-produced snapshot, so the contract that governs
// it is the host producer's own type; `satisfies` checks it in both directions
// without a cast, which is what makes removing a required field a typecheck
// failure that names the field, and an entry no host emits a failure too.
//
// `as const` is load-bearing. A JSON module import widens — `schemaVersion`
// arrives as `number` and `lifecycle` as `string`, neither of which satisfies
// the literal types the contract declares — and `as const` cannot be applied to
// an imported binding. An inline literal is therefore the only form of this
// fixture the compiler can check.

import type { WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';

export const workflowSnapshot = {
  "schemaVersion": 4,
  "isPrimary": true,
  "queues": [
    {
      "queueId": "default",
      "name": "Active Queue",
      "position": 0,
      "lifecycle": "running",
      "inFlightRun": {
        "runId": "visual-run-active",
        "status": "running",
        "feature": {
          "id": "visual-task-active",
          "label": "Harden deterministic visual coverage",
          "startedAt": "2026-08-01T09:00:00.000Z"
        },
        "pipeline": {
          "id": "dev-new-feature",
          "name": "New Feature"
        },
        "elapsedMs": 366000,
        "liveActivity": {
          "summary": "Refining the implementation plan and validating contracts",
          "category": "cli-invocation",
          "lastEventAt": "2026-08-01T09:06:00.000Z",
          "freshness": "live",
          "staleSeconds": 2
        },
        "delayedRetry": {
          "pendingRetryAt": null,
          "pendingRetryCause": null,
          "delayedRetryCount": 0
        },
        "resumeTargetPhaseId": null,
        "outputs": [],
        "liveness": {
          "lastActivityAt": "2026-08-01T09:06:00.000Z",
          "stdoutLines": 428,
          "stderrLines": 0
        },
        "progress": {
          "phasesCompleted": 2,
          "phaseCount": 7,
          "iterationCap": 10,
          "maxPhaseInvocations": 34,
          "percent": 29
        }
      },
      "phases": [
        {
          "name": "speckit-specify",
          "displayName": "Specify",
          "order": 1,
          "state": "completed",
          "iteration": 1,
          "lastResult": "clean",
          "elapsedMs": 42000,
          "subProgress": null
        },
        {
          "name": "speckit-clarify",
          "displayName": "Clarify",
          "order": 2,
          "state": "completed",
          "iteration": 2,
          "lastResult": "clean",
          "elapsedMs": 81000,
          "subProgress": null
        },
        {
          "name": "speckit-plan",
          "displayName": "Plan",
          "order": 3,
          "state": "active",
          "iteration": 2,
          "lastResult": "ambiguities-remain",
          "elapsedMs": 96000,
          "subProgress": {
            "current": 3,
            "total": 5,
            "label": "iteration"
          }
        },
        {
          "name": "speckit-tasks",
          "displayName": "Tasks",
          "order": 4,
          "state": "not-started",
          "iteration": 0,
          "lastResult": null,
          "elapsedMs": 0,
          "subProgress": null
        },
        {
          "name": "speckit-analyze",
          "displayName": "Analyze",
          "order": 5,
          "state": "not-started",
          "iteration": 0,
          "lastResult": null,
          "elapsedMs": 0,
          "subProgress": null
        },
        {
          "name": "speckit-implement",
          "displayName": "Implement",
          "order": 6,
          "state": "not-started",
          "iteration": 0,
          "lastResult": null,
          "elapsedMs": 0,
          "subProgress": null
        },
        {
          "name": "finalize",
          "displayName": "Finalize",
          "order": 7,
          "state": "not-started",
          "iteration": 0,
          "lastResult": null,
          "elapsedMs": 0,
          "subProgress": null
        }
      ],
      "phaseOverrides": [],
      "manualPause": null,
      "phaseBreakpoints": [],
      "startFailure": null,
      "pendingCount": 1,
      "tasks": [
        {
          "id": "visual-task-active",
          "label": "Harden deterministic visual coverage",
          "enqueuedAt": "2026-08-01T08:55:00.000Z",
          "startedAt": "2026-08-01T09:00:00.000Z",
          "updatedAt": "2026-08-01T09:06:00.000Z",
          "completedAt": null,
          "status": "in-flight",
          "retryCount": 0,
          "lastErrorSummary": null,
          "pausedReason": null,
          "currentPhase": "speckit-plan",
          "queueId": "default",
          "position": 0,
          "pauseCause": null,
          "currentPipelineId": "dev-new-feature",
          "hasOnDiskLogs": true
        },
        {
          "id": "visual-task-pending",
          "label": "Document degraded network behavior",
          "enqueuedAt": "2026-08-01T09:02:00.000Z",
          "startedAt": null,
          "updatedAt": "2026-08-01T09:02:00.000Z",
          "completedAt": null,
          "status": "pending",
          "retryCount": 0,
          "lastErrorSummary": null,
          "pausedReason": null,
          "currentPhase": null,
          "queueId": "default",
          "position": 1,
          "pauseCause": null,
          "currentPipelineId": "dev-new-feature",
          "hasOnDiskLogs": false
        },
        {
          "id": "visual-task-complete",
          "label": "Bound backend output capture",
          "enqueuedAt": "2026-07-31T14:00:00.000Z",
          "startedAt": "2026-07-31T14:01:00.000Z",
          "updatedAt": "2026-07-31T14:09:00.000Z",
          "completedAt": "2026-07-31T14:09:00.000Z",
          "status": "completed",
          "retryCount": 0,
          "lastErrorSummary": null,
          "pausedReason": null,
          "currentPhase": "finalize",
          "queueId": "default",
          "position": 2,
          "pauseCause": null,
          "currentPipelineId": "dev-new-feature",
          "hasOnDiskLogs": true
        }
      ]
    }
  ],
  "queue": {
    "inFlight": {
      "id": "visual-task-active",
      "label": "Harden deterministic visual coverage",
      "enqueuedAt": "2026-08-01T08:55:00.000Z",
      "startedAt": "2026-08-01T09:00:00.000Z",
      "updatedAt": "2026-08-01T09:06:00.000Z",
      "completedAt": null,
      "status": "in-flight",
      "retryCount": 0,
      "lastErrorSummary": null,
      "pausedReason": null,
      "currentPhase": "speckit-plan",
      "queueId": "default",
      "position": 0,
      "pauseCause": null,
      "currentPipelineId": "dev-new-feature",
      "hasOnDiskLogs": true
    },
    "pending": [
      {
        "id": "visual-task-pending",
        "label": "Document degraded network behavior",
        "enqueuedAt": "2026-08-01T09:02:00.000Z",
        "startedAt": null,
        "updatedAt": "2026-08-01T09:02:00.000Z",
        "completedAt": null,
        "status": "pending",
        "retryCount": 0,
        "lastErrorSummary": null,
        "pausedReason": null,
        "currentPhase": null,
        "queueId": "default",
        "position": 1,
        "pauseCause": null,
        "currentPipelineId": "dev-new-feature",
        "hasOnDiskLogs": false
      }
    ],
    "recent": [
      {
        "id": "visual-task-complete",
        "label": "Bound backend output capture",
        "enqueuedAt": "2026-07-31T14:00:00.000Z",
        "startedAt": "2026-07-31T14:01:00.000Z",
        "updatedAt": "2026-07-31T14:09:00.000Z",
        "completedAt": "2026-07-31T14:09:00.000Z",
        "status": "completed",
        "retryCount": 0,
        "lastErrorSummary": null,
        "pausedReason": null,
        "currentPhase": "finalize",
        "queueId": "default",
        "position": 2,
        "pauseCause": null,
        "currentPipelineId": "dev-new-feature",
        "hasOnDiskLogs": true
      }
    ],
    "orderedItems": [
      {
        "id": "visual-task-active",
        "label": "Harden deterministic visual coverage",
        "enqueuedAt": "2026-08-01T08:55:00.000Z",
        "startedAt": "2026-08-01T09:00:00.000Z",
        "updatedAt": "2026-08-01T09:06:00.000Z",
        "completedAt": null,
        "status": "in-flight",
        "retryCount": 0,
        "lastErrorSummary": null,
        "pausedReason": null,
        "currentPhase": "speckit-plan",
        "queueId": "default",
        "position": 0,
        "pauseCause": null,
        "currentPipelineId": "dev-new-feature",
        "hasOnDiskLogs": true
      },
      {
        "id": "visual-task-pending",
        "label": "Document degraded network behavior",
        "enqueuedAt": "2026-08-01T09:02:00.000Z",
        "startedAt": null,
        "updatedAt": "2026-08-01T09:02:00.000Z",
        "completedAt": null,
        "status": "pending",
        "retryCount": 0,
        "lastErrorSummary": null,
        "pausedReason": null,
        "currentPhase": null,
        "queueId": "default",
        "position": 1,
        "pauseCause": null,
        "currentPipelineId": "dev-new-feature",
        "hasOnDiskLogs": false
      },
      {
        "id": "visual-task-complete",
        "label": "Bound backend output capture",
        "enqueuedAt": "2026-07-31T14:00:00.000Z",
        "startedAt": "2026-07-31T14:01:00.000Z",
        "updatedAt": "2026-07-31T14:09:00.000Z",
        "completedAt": "2026-07-31T14:09:00.000Z",
        "status": "completed",
        "retryCount": 0,
        "lastErrorSummary": null,
        "pausedReason": null,
        "currentPhase": "finalize",
        "queueId": "default",
        "position": 2,
        "pauseCause": null,
        "currentPipelineId": "dev-new-feature",
        "hasOnDiskLogs": true
      }
    ],
    "queues": [
      {
        "id": "default",
        "name": "Active Queue",
        "position": 0,
        "state": "active",
        "pauseSource": null,
        "schedule": null,
        "taskCount": 3
      }
    ],
    "paused": false,
    "pausedReason": null,
    "lifecycle": "running",
    "scheduledStartAt": null,
    "scheduledStartSource": null,
    "migrationNotice": "dismissed"
  },
  "defaultRunnerKind": "claude",
  "auditTail": [
    {
      "id": "visual-audit-1",
      "timestamp": "2026-08-01T09:05:00.000Z",
      "phase": "speckit-plan",
      "category": "phase-transition",
      "summary": "phase-start iteration 2",
      "runId": "visual-run-active",
      "scope": "task",
      "taskId": "visual-task-active",
      "phaseId": "speckit-plan",
      "outcome": "pending",
      "runner": "codex"
    }
  ],
  "debugLogTail": [],
  "monitor": {
    "runId": "visual-run-active",
    "phase": "speckit-plan",
    "status": "running",
    "pid": 4242,
    "startedAt": "2026-08-01T09:00:00.000Z",
    "lastStdoutAt": "2026-08-01T09:05:58.000Z",
    "lastStderrAt": null,
    "lastProgressAt": "2026-08-01T09:05:58.000Z",
    "stdoutLines": 128,
    "stderrLines": 0,
    "exitCode": null,
    "signal": null,
    "detectedIssues": [],
    "msSinceLastStdout": 2000,
    "msSinceLastStderr": null
  },
  "telemetry": {
    "pid": 4242,
    "status": "active",
    "cpuPercent": 18.4,
    "memoryRssBytes": 188743680,
    "uptimeMs": 366000,
    "sampledAt": "2026-08-01T09:06:00.000Z"
  },
  "history": [
    {
      "runId": "visual-run-complete",
      "featureId": "visual-task-complete",
      "descriptionPreview": "Bound backend output capture",
      "terminalStatus": "completed",
      "startedAt": "2026-07-31T14:01:00.000Z",
      "completedAt": "2026-07-31T14:09:00.000Z",
      "durationMs": 480000,
      "lastErrorSummary": null,
      "auditLogPointer": "runId:visual-run-complete",
      "queueId": "default"
    }
  ],
  "producedAt": "2026-08-01T09:06:00.000Z",
  "availablePipelines": [
    {
      "id": "dev-new-feature",
      "name": "New Feature",
      "phases": [
        "speckit-specify",
        "speckit-clarify",
        "speckit-plan",
        "speckit-tasks",
        "speckit-analyze",
        "speckit-implement",
        "finalize"
      ]
    },
    {
      "id": "bugfix",
      "name": "Bug Fix",
      "phases": [
        "speckit-specify",
        "speckit-plan",
        "speckit-implement",
        "finalize"
      ]
    }
  ],
  "pipelineCatalog": {
    "state": "ready",
    "records": [
      {
        "key": "dev-new-feature::0",
        "pipelineId": "dev-new-feature",
        "status": "effective",
        "definition": {
          "pipelineId": "dev-new-feature",
          "name": "New Feature",
          "version": 1,
          "phaseIds": [
            "speckit-specify",
            "speckit-clarify",
            "speckit-plan",
            "speckit-tasks",
            "speckit-analyze",
            "speckit-implement",
            "finalize"
          ],
          "inputs": [],
          "outputs": [],
          "bindings": [],
          "recommendedNext": []
        },
        "display": {
          "id": "dev-new-feature",
          "name": "New Feature",
          "version": 1,
          "phases": [
            "speckit-specify",
            "speckit-clarify",
            "speckit-plan",
            "speckit-tasks",
            "speckit-analyze",
            "speckit-implement",
            "finalize"
          ]
        },
        "errors": []
      },
      {
        "key": "bugfix::1",
        "pipelineId": "bugfix",
        "status": "effective",
        "definition": {
          "pipelineId": "bugfix",
          "name": "Bug Fix",
          "version": 1,
          "phaseIds": [
            "speckit-specify",
            "speckit-plan",
            "speckit-implement",
            "finalize"
          ],
          "inputs": [],
          "outputs": [],
          "bindings": [],
          "recommendedNext": []
        },
        "display": {
          "id": "bugfix",
          "name": "Bug Fix",
          "version": 1,
          "phases": [
            "speckit-specify",
            "speckit-plan",
            "speckit-implement",
            "finalize"
          ]
        },
        "errors": []
      }
    ],
    "effective": [
      {
        "pipelineId": "dev-new-feature",
        "name": "New Feature",
        "version": 1,
        "phaseIds": [
          "speckit-specify",
          "speckit-clarify",
          "speckit-plan",
          "speckit-tasks",
          "speckit-analyze",
          "speckit-implement",
          "finalize"
        ],
        "inputs": [],
        "outputs": [],
        "bindings": [],
        "recommendedNext": []
      },
      {
        "pipelineId": "bugfix",
        "name": "Bug Fix",
        "version": 1,
        "phaseIds": [
          "speckit-specify",
          "speckit-plan",
          "speckit-implement",
          "finalize"
        ],
        "inputs": [],
        "outputs": [],
        "bindings": [],
        "recommendedNext": []
      }
    ],
    "revision": "visual-pipeline-revision",
    "warnings": []
  },
  "availablePhases": [
    {
      "id": "speckit-specify",
      "name": "Specify",
      "instruction": "Define scope and acceptance criteria.",
      "model": "claude-sonnet-4-6",
      "effort": "high",
      "timeoutSeconds": 1800,
      "loopable": false,
      "runner": "claude"
    },
    {
      "id": "speckit-clarify",
      "name": "Clarify",
      "instruction": "Resolve material ambiguity.",
      "model": "claude-sonnet-4-6",
      "effort": "medium",
      "timeoutSeconds": 1200,
      "loopable": true,
      "retryCondition": "ambiguities_remain",
      "runner": "claude"
    },
    {
      "id": "speckit-plan",
      "name": "Plan",
      "instruction": "Create an implementation plan.",
      "model": "gpt-5.6-codex",
      "effort": "high",
      "timeoutSeconds": 1800,
      "loopable": false,
      "runner": "codex"
    },
    {
      "id": "speckit-tasks",
      "name": "Tasks",
      "instruction": "Break the plan into tasks.",
      "timeoutSeconds": 1200,
      "loopable": false,
      "runner": "claude"
    },
    {
      "id": "speckit-analyze",
      "name": "Analyze",
      "instruction": "Check consistency and risk.",
      "timeoutSeconds": 1200,
      "loopable": true,
      "retryCondition": "issues_remain",
      "runner": "claude"
    },
    {
      "id": "speckit-implement",
      "name": "Implement",
      "instruction": "Implement and verify the approved plan.",
      "timeoutSeconds": 5400,
      "loopable": false,
      "runner": "claude"
    },
    {
      "id": "finalize",
      "name": "Finalize",
      "instruction": "Review, commit, and integrate the result.",
      "timeoutSeconds": 1800,
      "loopable": false,
      "runner": "claude"
    }
  ],
  "availableModels": {
    "claude": [
      "claude-sonnet-4-6",
      "claude-opus-4-6"
    ],
    "codex": [
      "gpt-5.6-codex"
    ],
    "agy": [
      "Gemini 3.1 Pro (High)"
    ]
  },
  "configuredModels": {
    "claude": [
      "claude-sonnet-4-6",
      "claude-opus-4-6"
    ],
    "codex": [
      "gpt-5.6-codex"
    ],
    "agy": [
      "Gemini 3.1 Pro (High)"
    ]
  },
  "availableBackends": [
    "claude",
    "codex",
    "agy"
  ],
  "backendPingState": {
    "status": "idle"
  },
  "workspaceTrust": true,
  "resolvedTrust": {
    "phases": true,
    "retryConditions": true
  },
  // FR-R3-143 (T037) — two DIFFERENT steps, both consistent with the `true` above.
  // `phases` is allowed because the user set it so explicitly; `retryConditions`
  // is allowed because nothing is set and the workspace is trusted. A fixture that
  // used one value for both would render one row of the disclosure twice and leave
  // the distinction it exists to draw unexercised by the visual suite.
  "resolvedScope": {
    "phases": "user",
    "retryConditions": "workspace-trust"
  },
  "generalSettings": {
    "cliPath": "claude",
    "codexPath": "codex",
    "agyPath": "agy",
    "loggingVerbose": true,
    "loopMaxIterations": 10,
    "invocationIdleTimeoutSeconds": 5400,
    "invocationMaxDurationSeconds": 21600,
    "watchdogPollIntervalMinutes": 30,
    "auditRotationSizeMB": 5,
    "auditRotationMaxAgeDays": 30,
    "defaultPipelineId": "speckit-new-feature",
    "fatalSignatures": [],
    "claudeAutoCompactPctOverride": undefined,
    "runtimeLogLevel": "INFO",
    "runtimeLogFilePath": "",
    "retryMaxAttempts": 5,
    "retryForceContinueOnCap": false,
    "runtimeLogMaxBytes": 5242880,
    "runtimeLogMaxGenerations": 3,
    "sessionRetentionMaxAgeDays": 30,
    "sessionRetentionMaxBytes": 536870912,
    "rawTranscriptMode": "always",
    "cliInheritEnvironment": true,
    "cliEnvironmentMode": "allowlist",
    "cliEnvironmentAllowlist": [],
    "backendProbeTimeoutSeconds": 5,
    "uiConfirmationsEnable": true,
    "multiRootSuppressWarning": false,
    "backendRunner": "claude",
    "spendMaxUsdPerRun": null,
    "spendMaxTokensPerRun": null,
    "scopes": {
      "cliPath": "default",
      "loggingVerbose": "workspace",
      "loopMaxIterations": "default",
      "invocationIdleTimeoutSeconds": "default",
      "invocationMaxDurationSeconds": "default",
      "watchdogPollIntervalMinutes": "default",
      "auditRotationSizeMB": "default",
      "auditRotationMaxAgeDays": "default",
      "defaultPipelineId": "default",
      "fatalSignatures": "default",
      "claudeAutoCompactPctOverride": "default",
      "runtimeLogLevel": "default",
      "runtimeLogFilePath": "default",
      "retryMaxAttempts": "default",
      "runtimeLogMaxBytes": "default",
      "runtimeLogMaxGenerations": "default",
      "sessionRetentionMaxAgeDays": "default",
      "sessionRetentionMaxBytes": "default",
      "retryForceContinueOnCap": "default",
      "codexPath": "default",
      "agyPath": "default",
      "rawTranscriptMode": "default",
      "cliInheritEnvironment": "default",
      "cliEnvironmentMode": "default",
      "cliEnvironmentAllowlist": "default",
      "backendProbeTimeoutSeconds": "default",
      "uiConfirmationsEnable": "default",
      "multiRootSuppressWarning": "default",
      "backendRunner": "default",
      "spendMaxUsdPerRun": "default",
      "spendMaxTokensPerRun": "default"
    }
  },
  "sessionArtifacts": {
    "artifactCount": 12,
    "totalBytes": 3452112,
    "lastSweepAt": "2026-08-01T06:00:00.000Z",
    "lastSweepFailures": 0
  },
  "streamPressure": {
    "liveBuffers": 4,
    "retainedBytes": 5242880,
    "ceilingBytes": 268435456,
    "machineMemoryBytes": 17179869184
  },
  "evidenceHealth": {
    "overall": "healthy",
    "transportDrops": { "lines": 0, "bytes": 0 },
    "audit": {
      "status": "healthy",
      "continuationPolicy": "fail-closed",
      "failureCount": 0,
      "lastFailureAt": null,
      "cause": null
    },
    "rawTranscript": {
      "status": "healthy",
      "continuationPolicy": "continue-degraded",
      "failureCount": 0,
      "lastFailureAt": null,
      "cause": null
    },
    "runtimeLog": {
      "status": "healthy",
      "continuationPolicy": "continue-degraded",
      "failureCount": 0,
      "lastFailureAt": null,
      "cause": null
    },
    "metricsRollup": {
      "status": "healthy",
      "continuationPolicy": "continue-degraded",
      "failureCount": 0,
      "lastFailureAt": null,
      "cause": null
    },
    "historyPointer": {
      "status": "healthy",
      "continuationPolicy": "continue-degraded",
      "failureCount": 0,
      "lastFailureAt": null,
      "cause": null
    }
  },
  "confirmationsEnabled": true,
  "confirmSuppression": {
    "version": 1,
    "suppressedActionKeys": []
  },
  // FR-R3-145 (T1572) — the memento-sourced queue settings. Literals here, unlike
  // everywhere else, because this fixture is a captured snapshot: it is `as const`
  // so the visual suite renders one fixed frame, and a derived value would make the
  // frame move when a default moves. `1` and `"default"` are what a cold workspace
  // reports, matching the rest of this fixture's idle posture.
  "queueSettings": {
    "globalConcurrencyCap": 1,
    "defaultQueueId": "default"
  },
  // FR-R3-144 (T021) — the three postures a shipped default produces: `claude` and
  // `agy` carry no OS-enforced bound and are ungranted, `codex` carries one and
  // needs no grant. Literals for the reason the paragraph above gives — this is a
  // captured frame — and the values are what `composeBackendPostures([])` returns,
  // which is what a cold workspace with the manifest default `[]` projects.
  // The refusal sentences are `judgeBackendContainment`'s own, copied whole. They
  // are long, and that is the point: the tab renders the enforcement's wording
  // verbatim, so the baseline must photograph a tab carrying two of them. Held to
  // the projection by `tests/unit/ui/sidebar/backend-posture-projection.test.ts`,
  // which compares this literal against `composeBackendPostures([])` — the first
  // version of this fixture omitted both, and three screenshots recorded a surface
  // with no refusal on it while a fresh install shows two.
  "backendPostures": [
    {
      "kind": "claude",
      "containment": "none",
      "mechanism": "none",
      "grant": "not-granted",
      "refusal":
        "The 'claude' backend runs without an OS-enforced bound on what it can reach: model-generated actions execute with your local user authority. Add 'claude' to 'schegent.backend.uncontainedBackends' to accept that for this backend only, or choose a backend that carries a sandbox. The setting is application-scoped, so it applies to every workspace in this installation. It replaces the removed boolean 'schegent.backend.allowUncontainedBackends', which now grants nothing. See docs/architecture/agent-capability-posture.md and docs/operations/untrusted-repositories.md."
    },
    {
      "kind": "agy",
      "containment": "none",
      "mechanism": "none",
      "grant": "not-granted",
      "refusal":
        "The 'agy' backend runs without an OS-enforced bound on what it can reach: model-generated actions execute with your local user authority. Add 'agy' to 'schegent.backend.uncontainedBackends' to accept that for this backend only, or choose a backend that carries a sandbox. The setting is application-scoped, so it applies to every workspace in this installation. It replaces the removed boolean 'schegent.backend.allowUncontainedBackends', which now grants nothing. See docs/architecture/agent-capability-posture.md and docs/operations/untrusted-repositories.md."
    },
    {
      "kind": "codex",
      "containment": "os-enforced",
      "mechanism": "codex-sandbox-workspace-write",
      "grant": "not-required"
    }
  ],
  "backendGrantProblems": []
} as const satisfies WorkflowSnapshot;
