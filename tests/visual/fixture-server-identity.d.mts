/** The name the fixture server gives on `IDENTITY_PATH`. */
export const FIXTURE_SERVER_NAME: 'schegent-visual-fixtures';

/** The path on which the fixture server says what it is and which build it serves. */
export const IDENTITY_PATH: '/__fixture-server';

/** The folder of a checkout that the fixture server serves, relative to the checkout. */
export const SERVED_DIRECTORY: 'dist/webview';

/** What the fixture server answers on `IDENTITY_PATH`. */
export type FixtureServerIdentity = {
  server: typeof FIXTURE_SERVER_NAME;
  root: string;
};

/** The part of Playwright's `FullConfig` the global setup reads. */
export type FixtureSetupConfig = {
  configFile?: string;
  projects: readonly { use: { baseURL?: string } }[];
};

export function fixtureServerIdentity(root: string): FixtureServerIdentity;

/**
 * Fails unless the server at `origin` answers as this project's fixture server and serves
 * `expectedRoot`. Symbolic links on either side are resolved before the two builds are compared.
 */
export function assertFixtureServerServes(origin: string, expectedRoot: string): Promise<void>;

/**
 * Both Playwright configs' `globalSetup`: checks the server behind the run's `baseURL` against the
 * build in the config file's folder, which is where the configs' `webServer` starts the server.
 */
export default function globalSetup(config: FixtureSetupConfig): Promise<void>;
