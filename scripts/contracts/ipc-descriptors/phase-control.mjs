// Family 3: phase-control (9 commands)

import { d } from '../descriptor-dsl.mjs';

const QUEUE_ID_MAX = 256;
const PROMPT_MAX = 4096;

const queueId = () => d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-queueId' });
const runId = () => d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-runId' });
const phaseId = () => d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-phaseId' });

export const PHASE_CONTROL_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_RETRY_PHASE_NOW',
    interfaceName: 'RetryPhaseNowCommand',
    validatorName: 'validateRetryPhaseNow',
    family: 'phase-control',
    doc: 'Trigger an immediate retry for a delayed-retry phase on the addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_PAUSE_PHASE',
    interfaceName: 'PausePhaseCommand',
    validatorName: 'validatePausePhase',
    family: 'phase-control',
    doc: 'Pause the active phase on the addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_RESUME_PHASE',
    interfaceName: 'ResumePhaseCommand',
    validatorName: 'validateResumePhase',
    family: 'phase-control',
    doc: 'Resume a paused phase on the addressed queue with an optional operator prompt.',
    payloadMode: 'required',
    payload: d.obj(
      {
        queueId: queueId(),
        prompt: d.field(d.str({ maxLen: PROMPT_MAX, err: 'invalid-prompt' }), { optional: true })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RESTART_PHASE',
    interfaceName: 'RestartPhaseCommand',
    validatorName: 'validateRestartPhase',
    family: 'phase-control',
    doc: 'Restart a specific phase on the addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), phaseId: phaseId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_SKIP_PHASE',
    interfaceName: 'SkipPhaseCommand',
    validatorName: 'validateSkipPhase',
    family: 'phase-control',
    doc: 'Skip a phase on a specific run and queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), runId: runId(), phaseId: phaseId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_DISABLE_PHASE',
    interfaceName: 'DisablePhaseCommand',
    validatorName: 'validateDisablePhase',
    family: 'phase-control',
    doc: 'Disable a phase on the addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), phaseId: phaseId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_ENABLE_PHASE',
    interfaceName: 'EnablePhaseCommand',
    validatorName: 'validateEnablePhase',
    family: 'phase-control',
    doc: 'Re-enable a disabled phase on the addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), phaseId: phaseId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_SET_PHASE_BREAKPOINT',
    interfaceName: 'SetPhaseBreakpointCommand',
    validatorName: 'validateSetPhaseBreakpoint',
    family: 'phase-control',
    doc: 'Set a future-phase breakpoint on a specific run and queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), runId: runId(), phaseId: phaseId() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_CLEAR_PHASE_BREAKPOINT',
    interfaceName: 'ClearPhaseBreakpointCommand',
    validatorName: 'validateClearPhaseBreakpoint',
    family: 'phase-control',
    doc: 'Clear a future-phase breakpoint on a specific run and queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueId(), runId: runId(), phaseId: phaseId() }, { allowArray: true })
  })
]);
