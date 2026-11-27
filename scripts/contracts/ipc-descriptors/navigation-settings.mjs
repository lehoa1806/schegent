// Family 4: navigation-settings (10 commands)

import { d } from '../descriptor-dsl.mjs';
import { SUPPORTED_BACKENDS } from '../canonical-enums.mjs';

export const NAVIGATION_SETTINGS_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_OPEN_AUDIT_LOG',
    interfaceName: 'OpenAuditLogCommand',
    validatorName: 'validateOpenAuditLog',
    family: 'navigation-settings',
    doc: 'Open the workspace audit log in VS Code.',
    payloadMode: 'none'
  }),

  d.command({
    type: 'CMD_OPEN_DASHBOARD',
    interfaceName: 'OpenDashboardCommand',
    validatorName: 'validateOpenDashboard',
    family: 'navigation-settings',
    doc: 'Open the full Schegent dashboard webview panel.',
    payloadMode: 'none'
  }),

  d.command({
    type: 'CMD_OPEN_VERBOSE_SETTING',
    interfaceName: 'OpenVerboseSettingCommand',
    validatorName: 'validateOpenVerboseSetting',
    family: 'navigation-settings',
    doc: 'Open VS Code Settings scoped to schegent.logging.verbose.',
    payloadMode: 'none'
  }),

  d.command({
    type: 'CMD_OPEN_TRUST_SETTINGS',
    interfaceName: 'OpenTrustSettingsCommand',
    validatorName: 'validateOpenTrustSettings',
    family: 'navigation-settings',
    doc: 'Open VS Code Settings scoped to the read-only schegent.trust.* keys.',
    payloadMode: 'none'
  }),

  d.command({
    type: 'CMD_DISMISS_MIGRATION_NOTICE',
    interfaceName: 'DismissMigrationNoticeCommand',
    validatorName: 'validateDismissMigrationNotice',
    family: 'navigation-settings',
    doc: 'Dismiss the one-time post-migration notice.',
    payloadMode: 'none'
  }),

  d.command({
    type: 'CMD_SET_CONFIRM_SUPPRESSION',
    interfaceName: 'SetConfirmSuppressionCommand',
    validatorName: 'validateSetConfirmSuppression',
    family: 'navigation-settings',
    doc: 'Persist per-action confirmation suppression state in workspace memento.',
    payloadMode: 'required',
    payloadMissingErr: 'invalid-payload',
    payload: d.obj(
      {
        actionKey: d.str({ err: 'invalid-payload' }),
        suppressed: d.bool({ err: 'invalid-payload' })
      },
      { closed: false, allowArray: true, missingErr: 'invalid-payload' }
    )
  }),

  d.command({
    type: 'CMD_SAVE_MODELS',
    interfaceName: 'SaveModelsCommand',
    validatorName: 'validateSaveModels',
    family: 'navigation-settings',
    doc: 'Persist a revision-checked workspace model edit or additive import.',
    payloadMode: 'required',
    payload: d.obj(
      {
        models: d.rec(d.arr(d.str({ minLen: 1, err: 'invalid-payload' }), { err: 'invalid-payload' }), {
          readonly: false,
          err: 'invalid-payload',
          valueErr: 'invalid-payload'
        }),
        expectedRevision: d.field(d.str({ minLen: 1, err: 'invalid-payload' }), { optional: true }),
        mutation: d.field(
          d.obj({ kind: d.enum(['manual-edit', 'import-package'], { err: 'invalid-payload' }) }, { collapseInvalidErr: 'invalid-payload', unexpectedErr: 'invalid-payload' }),
          { optional: true, err: 'invalid-payload' }
        )
      },
      { closed: false, allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_SAVE_GENERAL_SETTINGS',
    interfaceName: 'SaveGeneralSettingsCommand',
    validatorName: 'validateSaveGeneralSettings',
    family: 'navigation-settings',
    doc: 'Save a batch of unprefixed scalar schegent.* settings validated against KEY_SPECS downstream.',
    payloadMode: 'required',
    payload: d.obj(
      {
        updates: d.rec(d.unknown(), { err: 'invalid-updates' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_PING_BACKEND',
    interfaceName: 'PingBackendCommand',
    validatorName: 'validatePingBackend',
    family: 'navigation-settings',
    doc: 'Probe connectivity and availability for a single supported backend.',
    payloadMode: 'required',
    payload: d.obj({
      runner: d.enum(SUPPORTED_BACKENDS, {
        refName: 'BackendRunnerKind',
        refImport: '../backend-kinds',
        err: 'invalid-runner'
      })
    })
  }),

  d.command({
    type: 'CMD_SET_UNCONTAINED_BACKEND_GRANT',
    interfaceName: 'SetUncontainedBackendGrantCommand',
    validatorName: 'validateSetUncontainedBackendGrant',
    family: 'navigation-settings',
    doc: 'Grant or revoke uncontained execution posture for a single supported backend.',
    payloadMode: 'required',
    payload: d.obj({
      kind: d.enum(SUPPORTED_BACKENDS, {
        refName: 'BackendRunnerKind',
        refImport: '../backend-kinds',
        err: 'invalid-backend-kind',
        guardFn: 'isBackendRunnerKind',
        guardImport: '../../backend-kinds'
      }),
      granted: d.bool({ err: 'invalid-granted' })
    })
  })
]);
