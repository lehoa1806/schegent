# Runtime log

The runtime log is Schegent's sanitized operational log. Its default path is `<workspaceRoot>/.schegent/syslog`; it is independent of the structured audit log and the unredacted session artifacts.

<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->

## Configure it

| Setting | Default | Accepted range |
|---|---|---|
| `schegent.logging.runtimeLogLevel` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `schegent.logging.runtimeLogFilePath` | empty, resolving to `.schegent/syslog` | workspace-relative path, or an absolute path under an allowed production root |
| `schegent.logging.runtimeLogMaxBytes` | `5242880` | `65536`–`1073741824` |
| `schegent.logging.runtimeLogMaxGenerations` | `3` | `0`–`20` |

<!-- Source: package.json -->
<!-- Source: src/lib/runtime-log/runtime-log-settings.ts -->

Production allows an absolute destination only under the canonical workspace, extension `globalStorage`, or the OS temporary directory. The operator's home directory is deliberately excluded. Relative paths are anchored to the canonical workspace and any `..` segment is rejected. The sink repeats the decision with a canonical-path check at the filesystem operation, so a lexical pass is not enough when a symlink escapes an allowed root.

<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->

All four settings are re-read on each log emission. A level, path, or rotation change can therefore affect the next event without reloading the Extension Host.

<!-- Source: src/lib/runtime-log/runtime-log-settings.ts -->

## Rotation and failures

Before an append would cross the byte limit, numbered generations shift and the live file becomes `.1`. With zero generations, the live file is truncated in place at rollover. The sink serializes writes per path and checks destructive rename/unlink targets separately through the containment oracle.

<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->

An unresolvable path disables the sink and emits a bounded warning through the fallback logger. Filesystem and containment failures are suppressed per path/cause so a hot logging loop does not repeat the same warning indefinitely. Saving a runtime-log setting clears suppression and permits the next event to retry.

<!-- Source: src/lib/runtime-log/runtime-log-settings.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/config/general-settings.ts -->

Runtime-log records pass through `SanitizedLogger`, but sanitization is pattern-based. The log may still contain local paths and other operational context; treat it as local diagnostic material.

<!-- Source: src/lib/logger.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
