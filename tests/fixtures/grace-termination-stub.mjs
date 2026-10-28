// SYNTHETIC LIFECYCLE FIXTURE. This is not a recording of any real CLI. FR-R4-F02 (spec 240,
// contract L4 G11) uses it to drive the host's grace termination through the real `ClaudeCliRunner`
// and `PhaseRunner`: a child that has printed its terminal result and then does not exit, so the
// host waits out its settle window and sends SIGTERM, then SIGKILL.
//
// Usage: node grace-termination-stub.mjs <scenario>
//
//   quoted      a tool_result that QUOTES a rejected rate_limit_event, then a successful result.
//   genuine     a genuine top-level rejected rate_limit_event (reset in the future), then a result
//               whose is_error is true.
//   incidental  a successful result, then incidental "429" text on stdout and stderr.
//
// The result is the last stream-json event of every scenario, which is what arms the host's settle
// window (a later event would disarm it, as it does for a real CLI). Plain text after it does not.
// After the output the stub stays alive until it is killed, and ignores SIGTERM so the host has to
// escalate to SIGKILL. It reads stdin and discards it, so the host's prompt write never blocks.
// Nothing is written to disk and nothing is read from the network.

const scenario = process.argv[2];

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const INIT = { type: 'system', subtype: 'init', session_id: 'grace-stub-session', model: 'stub', cwd: '/stub' };
const RESET_EPOCH_SECONDS = Math.floor(Date.now() / 1000) + 3600;

const SCENARIOS = {
  quoted() {
    emit(INIT);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_stub_1',
            content: 'the log read {"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'
          }
        ]
      }
    });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  },
  genuine() {
    emit(INIT);
    emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESET_EPOCH_SECONDS }
    });
    emit({ type: 'result', subtype: 'error', is_error: true, terminal_reason: 'rate_limited' });
  },
  incidental() {
    emit(INIT);
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    process.stdout.write('processed 429 files in 429 ms\n');
    process.stderr.write('took 429 ms to respond\n');
  }
};

const run = SCENARIOS[scenario];
if (run === undefined) {
  process.stderr.write(`grace-termination-stub: unknown scenario "${scenario ?? ''}"\n`);
  process.exit(2);
}

process.on('SIGTERM', () => {
  // Deliberately ignored: the host's ladder must reach SIGKILL.
});
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.resume();

run();

// Alive until killed. The timer keeps the event loop busy; SIGKILL ends it.
setInterval(() => {}, 1_000);
