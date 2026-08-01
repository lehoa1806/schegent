import { once } from 'node:events';

const recordCount = Number.parseInt(process.argv[2] ?? '4600', 10);
const payloadBytes = Number.parseInt(process.argv[3] ?? '1024', 10);
const scenario = process.argv[4] ?? 'clean';

async function write(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

// Split a four-byte UTF-8 sequence across OS writes. The runner's StringDecoder
// must reconstruct it before buffering and forwarding it to the raw sink.
const splitCodePoint = Buffer.from('🙂', 'utf8');
await write(process.stdout, splitCodePoint.subarray(0, 2));
await write(process.stdout, splitCodePoint.subarray(2));
await write(process.stdout, '\n');
await write(process.stderr, splitCodePoint.subarray(0, 1));
await write(process.stderr, splitCodePoint.subarray(1));
await write(process.stderr, '\n');

for (let index = 0; index < recordCount; index += 1) {
  const id = String(index).padStart(6, '0');
  await write(
    process.stdout,
    `stdout:${id}:${'x'.repeat(payloadBytes)}:🙂\n`
  );
  await write(
    process.stderr,
    `stderr:${id}:${'y'.repeat(payloadBytes)}:漢\n`
  );
}

if (scenario === 'clean') {
  await write(
    process.stdout,
    `${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`
  );
} else if (scenario === 'fatal') {
  await write(process.stderr, 'fatal: deterministic backend failure\n');
  process.exitCode = 17;
} else if (scenario === 'timeout' || scenario === 'cancel') {
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}
