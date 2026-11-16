// Finding 27 of the webview port review (Decision 14): a local run checks that the server it
// reuses is this checkout's fixture server.
//
// WHY A CHECK AT ALL. Both Playwright configs set `reuseExistingServer: !isCi`, so a local visual
// or a11y run uses whatever already listens on port 4173: this checkout's fixture server from an
// earlier run, but just as readily another checkout's, or another project's preview server (4173
// is Vite's default preview port). The run then tests that server's pages and passes or fails on
// them. Playwright cannot tell the servers apart: given a `port` it asks only whether the port is
// taken, and given a `url` it takes any status from 200 to 403, which a single-page app's fallback
// answers on every path.
//
// HOW. `serve-built-webviews.mjs` answers `IDENTITY_PATH` with its name and the build it serves.
// This module is both configs' `globalSetup`, which Playwright runs after it has started or reused
// the web server and before any test, so the check sees the server the run would test. A server
// that does not answer as this project's fixture server, or that serves another checkout's build,
// stops the run with one message that says which, and how to find the process holding the port.
//
// WHY NOT A WRAPPER like `scripts/check-playwright-browser.mjs`. That check needs nothing from the
// runner, so it runs before it. This one needs the server the runner chose, and a direct
// `npx playwright test --config …` run, which no npm script wraps, reuses a server too.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The name the fixture server gives on `IDENTITY_PATH`. */
export const FIXTURE_SERVER_NAME = 'schegent-visual-fixtures';

/** The path on which the fixture server says what it is and which build it serves. */
export const IDENTITY_PATH = '/__fixture-server';

/** The folder of a checkout that the fixture server serves, relative to the checkout. */
export const SERVED_DIRECTORY = 'dist/webview';

/** How long the check waits for the whole answer. */
const ANSWER_TIMEOUT_MS = 5_000;

/** The port an origin without one is reached on, by scheme. */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * What the fixture server answers on `IDENTITY_PATH`.
 * @param {string} root the folder it serves
 */
export function fixtureServerIdentity(root) {
  return { server: FIXTURE_SERVER_NAME, root };
}

/**
 * The path with its symbolic links resolved as far up as it exists, so two names for one folder
 * compare equal even before the build that fills it exists.
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/** @param {string} port */
function stopHint(port) {
  return `Stop that server and run again; \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` names its process.`;
}

/**
 * The status, content type and body the server gives on `url`, read whole within the timeout.
 * @param {URL} url
 */
async function answerOf(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type'), text };
}

/**
 * The identity an answer carries, or null when it is not this project's fixture server's.
 * @param {{ status: number, text: string }} answer
 * @returns {{ server: string, root: string } | null}
 */
function identityIn(answer) {
  if (answer.status !== 200) return null;
  let body;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return null;
  }
  const named = typeof body === 'object' && body !== null && body.server === FIXTURE_SERVER_NAME;
  return named && typeof body.root === 'string' ? body : null;
}

/**
 * Fails unless the server at `origin` answers as this project's fixture server and serves
 * `expectedRoot`. Symbolic links on either side are resolved before the two builds are compared.
 * @param {string} origin the server the run would test, as `http://host:port`
 * @param {string} expectedRoot the build this run means to test
 * @returns {Promise<void>}
 */
export async function assertFixtureServerServes(origin, expectedRoot) {
  const url = new URL(IDENTITY_PATH, origin);
  const port = url.port || DEFAULT_PORTS[url.protocol] || url.host;
  let answer;
  try {
    answer = await answerOf(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Something holds port ${port} but gave no answer to GET ${url.href} (${reason}), so this ` +
        `run cannot tell which pages it would test. ${stopHint(port)}`,
      { cause: error }
    );
  }

  const identity = identityIn(answer);
  if (identity === null) {
    throw new Error(
      `Port ${port} is held by a server that does not identify itself as Schegent's visual ` +
        `fixture server: GET ${IDENTITY_PATH} answered ${answer.status} ` +
        `${answer.type ?? 'with no content type'}. A local run reuses whatever listens on that ` +
        `port, so it would test another project's pages or an older checkout's build. ` +
        stopHint(port)
    );
  }

  if (canonicalPath(identity.root) !== canonicalPath(expectedRoot)) {
    throw new Error(
      `Port ${port} is held by the visual fixture server of another checkout: it serves ` +
        `${identity.root}, and this run's build is ${expectedRoot}. A local run reuses the ` +
        `server that listens on that port, so it would test the other checkout's build. ` +
        stopHint(port)
    );
  }
}

/**
 * Both Playwright configs' `globalSetup`: checks the server behind the run's `baseURL` against the
 * build in the config file's folder, which is where the configs' `webServer` starts the server
 * (Playwright's default working directory for it).
 * @param {{ configFile?: string, projects: ReadonlyArray<{ use: { baseURL?: string } }> }} config
 * @returns {Promise<void>}
 */
export default async function globalSetup(config) {
  const origin = config.projects
    .map((project) => project.use.baseURL)
    .find((baseURL) => baseURL !== undefined);
  if (origin === undefined) {
    throw new Error('The visual fixture server check reads the server from `use.baseURL`, and the config sets none.');
  }
  const checkout = config.configFile ? dirname(config.configFile) : process.cwd();
  await assertFixtureServerServes(origin, resolve(checkout, SERVED_DIRECTORY));
}
