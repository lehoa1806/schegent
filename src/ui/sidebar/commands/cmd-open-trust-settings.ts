import type { OpenTrustSettingsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

// FR-R3-143 (T039) — open the VS Code Settings editor filtered to the two
// `schegent.trust.*` capability keys.
//
// The Settings tab discloses these two read-only (spec C1): the trust ladder
// reads the USER layer, which `configurationTargetFor` cannot write for a
// `window`-scoped key, so a control here would ack `accepted` and change
// nothing. The settings editor can target both layers, so this hands the
// operator to the surface that can actually express the change.
//
// The query is a literal held HERE, not a payload. A webview-supplied key
// reaching `executeCommand` would be untrusted input on a command boundary for
// no gain: the set is two keys, both known to the host. `schegent.trust`
// matches the family, which is what the disclosure asks the operator to review.
const TRUST_SETTINGS_QUERY = 'schegent.trust';

export const handler: CommandHandler<OpenTrustSettingsCommand> = async (ctx) => {
  await exec(ctx, 'workbench.action.openSettings', TRUST_SETTINGS_QUERY);
  await ack(ctx, 'accepted');
};
