// PREDICTION, NOT OBSERVED. This is not a recording of any real CLI. FR-R4-F02 (spec 240, contract
// L5 G14) writes down what each offline failure is PREDICTED to look like, so the real stream
// unwrap, classifier, Phase transition and delayed-retry scheduler can be driven through it
// (`tests/integration/offline-retry-path.test.ts`). The real output per supported CLI is
// qualification item Q2 in `docs/operations/platform-observation-record.md`, **Unrun here**.
//
// Usage: node offline-cli-stub.mjs <scenario>
//
//   dns                      prediction: stderr "getaddrinfo ENOTFOUND <api host>", exit 1.
//   reset                    prediction: stderr "ECONNRESET", exit 1.
//   timeout                  prediction: no output at all until the host terminates it.
//   proxy                    prediction: stderr "407 Proxy Authentication Required", exit 1.
//   proxy-bad-gateway        prediction: stderr "502 Bad Gateway", exit 1.
//   auth                     prediction: a stream-json result with is_error and an authentication
//                            error, exit 1.
//   overload                 prediction: a stream-json result with is_error and overloaded_error,
//                            exit 1.
//   stale-credit-then-reset  prediction: an earlier QUOTED rate_limit_event in a tool_result, then
//                            stderr "ECONNRESET", exit 1.
//
// The prompt on stdin is read and discarded. Nothing is written to disk and nothing touches the
// network.

const scenario = process.argv[2];

const API_HOST = 'api.example.invalid';
const INIT = { type: 'system', subtype: 'init', session_id: 'offline-stub-session', model: 'stub', cwd: '/stub' };

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function fail(stderrText, exitCode) {
  process.stderr.write(`${stderrText}\n`, () => process.exit(exitCode));
}

const SCENARIOS = {
  dns() {
    fail(`Error: getaddrinfo ENOTFOUND ${API_HOST}`, 1);
  },
  reset() {
    fail('Error: read ECONNRESET', 1);
  },
  timeout() {
    // Silent until terminated. The host's idle bound ends it, and SIGTERM is honoured so the test
    // does not wait for the SIGKILL step.
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1_000);
  },
  proxy() {
    fail('Error: 407 Proxy Authentication Required', 1);
  },
  'proxy-bad-gateway'() {
    fail('Error: 502 Bad Gateway', 1);
  },
  auth() {
    emit(INIT);
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'authentication_error: invalid credentials',
      errors: ['authentication_error']
    });
    process.stdout.write('', () => process.exit(1));
  },
  overload() {
    emit(INIT);
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'overloaded_error: the provider is overloaded',
      errors: ['overloaded_error']
    });
    process.stdout.write('', () => process.exit(1));
  },
  'stale-credit-then-reset'() {
    emit(INIT);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_stub_1',
            content: 'an earlier log read {"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'
          }
        ]
      }
    });
    fail('Error: read ECONNRESET', 1);
  }
};

const run = SCENARIOS[scenario];
if (run === undefined) {
  process.stderr.write(`offline-cli-stub: unknown scenario "${scenario ?? ''}"\n`);
  process.exit(2);
}

process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.resume();

run();
