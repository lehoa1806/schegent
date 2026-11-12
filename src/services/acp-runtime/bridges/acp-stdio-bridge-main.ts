/**
 * FR-R6-F13 (F13-B) — standalone Node entry point bundled to `dist/acp-stdio-bridge.js`.
 *
 * Spawned exclusively by the host's ACP launch resolver with an already-filtered process
 * environment (`buildSpawnEnv`). Never reads workspace settings or repository files.
 * Zero `vscode` imports.
 */
import { parseBridgeCliArgv, startAcpStdioBridgeServer } from './acp-stdio-bridge';

function bootBridgeProcess(): void {
  const config = parseBridgeCliArgv(process.argv.slice(2), process.env);
  if (config === null) {
    process.stderr.write('acp-stdio-bridge: invalid launch arguments\n');
    process.exitCode = 2;
    return;
  }

  const server = startAcpStdioBridgeServer(config, {
    onStdin(listener) {
      process.stdin.on('data', (chunk: Buffer) => {
        listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
    },
    onStdinClose(listener) {
      process.stdin.once('end', listener);
      process.stdin.once('close', listener);
    },
    writeStdout(line) {
      process.stdout.write(line, 'utf8');
    },
    writeStderr(text) {
      process.stderr.write(text, 'utf8');
    }
  });

  const shutdown = (): void => {
    void server.close().finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.resume();
}

bootBridgeProcess();

