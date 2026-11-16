// Finding 27 of the webview port review (Decision 14): a local visual or a11y run refuses a server
// on the fixture port that is not this checkout's fixture server.
//
// WHAT THIS PINS:
//   - both Playwright configs reuse whatever already listens on the port when they run locally
//     (`reuseExistingServer: !isCi`), and Playwright cannot tell one server from another: given a
//     `port` it asks only whether the port is taken, and given a `url` it takes any status from
//     200 to 403, which a single-page app's fallback answers on every path. So the configs' global
//     setup asks the server what it is and which build it serves;
//   - a server that does not say, as another project's server or an older checkout's fixture
//     server does not, is refused, and so is this project's fixture server serving another
//     checkout's build;
//   - this checkout's fixture server is accepted, also when one side names the checkout through a
//     symbolic link, and the setup takes the server from the config's base URL and the build from
//     the config's folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Loaded, not imported: this file compiles as CommonJS, which cannot import an ES module.
async function loadCheck() {
  return import('../../visual/fixture-server-identity.mjs');
}

let check: Awaited<ReturnType<typeof loadCheck>>;

beforeAll(async () => {
  check = await loadCheck();
});

/** One canned HTTP answer. */
interface Answer {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

/** What a single-page app answers on every path, the identity path included. */
const PAGE: Answer = {
  status: 200,
  type: 'text/html; charset=utf-8',
  body: '<!doctype html><title>Another app</title>'
};

/** What a static server with no identity route answers there: the fixture server before finding 27. */
const NOT_FOUND: Answer = { status: 404, type: 'text/plain', body: 'Not found' };

function jsonAnswer(body: string): Answer {
  return { status: 200, type: 'application/json; charset=utf-8', body };
}

/** The fixture server's answer on the identity path, naming `server` when one is given. */
function identity(root: string, server?: string): Answer {
  return jsonAnswer(JSON.stringify({ server: server ?? check.FIXTURE_SERVER_NAME, root }));
}

/** A server that gives `answer()` on the identity path and a 404 on every other path. */
function answersIdentity(answer: () => Answer): (path: string) => Answer {
  return (path) => (path === check.IDENTITY_PATH ? answer() : NOT_FOUND);
}

const servers: Server[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
    )
  );
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Starts a loopback server on a free port and returns its origin. */
async function serve(answerFor: (path: string) => Answer): Promise<string> {
  const server = createServer((request, response) => {
    const answer = answerFor(request.url ?? '/');
    response.writeHead(answer.status, { 'Content-Type': answer.type });
    response.end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A fresh folder, named without symbolic links and removed after the test. */
function scratchFolder(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'visual-fixture-server-')));
  folders.push(folder);
  return folder;
}

const REFUSED: readonly { readonly name: string; readonly answerFor: (path: string) => Answer }[] = [
  { name: 'a page on every path, as a single-page app does', answerFor: () => PAGE },
  { name: 'a 404, as the fixture server of an older checkout does', answerFor: () => NOT_FOUND },
  {
    name: 'JSON that names another server',
    answerFor: answersIdentity(() => identity('/elsewhere/dist/webview', 'another-server'))
  },
  {
    name: 'JSON that names no build',
    answerFor: answersIdentity(() => jsonAnswer(JSON.stringify({ server: check.FIXTURE_SERVER_NAME })))
  },
  { name: 'a body that is not JSON', answerFor: answersIdentity(() => jsonAnswer('{')) }
];

describe('the visual fixture server check (finding 27)', () => {
  const thisBuild = join(tmpdir(), 'this-checkout', 'dist', 'webview');

  it.each(REFUSED)('refuses a server that answers $name', async ({ answerFor }) => {
    const origin = await serve(answerFor);
    await expect(check.assertFixtureServerServes(origin, thisBuild)).rejects.toThrow(
      /does not identify itself as Schegent's visual fixture server[\s\S]*lsof -nP -iTCP:\d+ -sTCP:LISTEN/
    );
  });

  it("refuses this project's fixture server serving another checkout's build, naming both", async () => {
    const otherBuild = join(tmpdir(), 'another-checkout', 'dist', 'webview');
    const origin = await serve(answersIdentity(() => identity(otherBuild)));
    const failure = check.assertFixtureServerServes(origin, thisBuild);
    await expect(failure).rejects.toThrow(otherBuild);
    await expect(failure).rejects.toThrow(thisBuild);
  });

  it("accepts this checkout's fixture server", async () => {
    const origin = await serve(answersIdentity(() => identity(thisBuild)));
    await expect(check.assertFixtureServerServes(origin, thisBuild)).resolves.toBeUndefined();
  });

  it('accepts it when one side names the checkout through a symbolic link', async () => {
    const folder = scratchFolder();
    const checkout = join(folder, 'checkout');
    const link = join(folder, 'link');
    mkdirSync(checkout);
    symlinkSync(checkout, link);
    const build = join('dist', 'webview');
    const origin = await serve(answersIdentity(() => identity(join(checkout, build))));
    await expect(check.assertFixtureServerServes(origin, join(link, build))).resolves.toBeUndefined();
  });

  it("as the configs' global setup, checks the base URL's server against the config's folder", async () => {
    const checkout = scratchFolder();
    const origin = await serve(answersIdentity(() => identity(join(checkout, check.SERVED_DIRECTORY))));
    const config = {
      configFile: join(checkout, 'playwright.config.ts'),
      projects: [{ use: { baseURL: origin } }]
    };
    await expect(check.default(config)).resolves.toBeUndefined();

    const elsewhere = join(checkout, 'elsewhere');
    const moved = { ...config, configFile: join(elsewhere, 'playwright.config.ts') };
    await expect(check.default(moved)).rejects.toThrow(join(elsewhere, check.SERVED_DIRECTORY));
  });
});
