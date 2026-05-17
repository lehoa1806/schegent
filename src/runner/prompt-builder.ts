import type { Phase } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';

const TOKEN_INSTRUCTION = `When (and only when) the phase is complete, emit on its OWN line: [SCHEGENT_STATUS: CLEAR]. If issues remain, emit a heading "Open questions:" or "Remaining issues:" followed by a Markdown bullet list. Do not decorate the token; do not place it inside a code fence.`;

const BUILT_IN_INSTRUCTIONS: Record<string, string> = {
  'speckit-specify': 'Run /speckit-specify with the feature description below. Produce specs/<NNN-name>/spec.md.',
  'speckit-clarify':
    'Run /speckit-clarify on the active feature spec. Resolve ambiguities. Emit the termination token only when no critical ambiguities remain. Inside the SCHEGENT AUDIT LOG block emit `open_questions: <N>` and `resolved_questions: <N>` as top-level integer metric lines so the controller can observe progress.',
  'speckit-plan': 'Run /speckit-plan on the active feature. Produce plan.md, research.md, data-model.md, contracts/, and quickstart.md.',
  'speckit-tasks': 'Run /speckit-tasks on the active feature. Produce tasks.md.',
  'speckit-analyze':
    'Run /speckit-analyze on the active feature. Apply remediation. Emit the termination token only when no CRITICAL issues remain.',
  'speckit-implement': 'Run /speckit-implement on the active feature.',
  finalize:
    'Verify the implementation: run build/typecheck/test commands, summarize results, and emit the termination token if all pass.',
  done: '(no-op)'
};

const AUDIT_INSTRUCTION = `Always emit a fenced audit log block in this exact form:
=== SCHEGENT AUDIT LOG ===
phase: <phase-name>
files_created: [<path>, ...]
files_modified: [<path>, ...]
files_deleted: [<path>, ...]
commands_executed: [<one-line summary>, ...]
network_calls: [<endpoint or "none">]
ruleset_switches: [<path or "none">]
notes: <freeform; <= 240 chars>
=== END AUDIT LOG ===
Empty arrays MUST be written as []. All required fields MUST be present.`;

export interface PromptInputs {
  phase: Phase;
  phaseDef?: PhaseDef;
  iteration: number;
  iterationCap: number;
  featureDescription: string;
  featureDir: string | null;
  carriedIssues?: Array<{ tag?: string; summary: string }> | string[];
  perPhaseRulesPath?: string | null;
  phaseMessagePath?: string | null;
  previousPhaseMessage?: Readonly<Record<string, string>> | null;
}

export class PromptBuilder {
  public build(inputs: PromptInputs): string {
    const lines: string[] = [];
    lines.push(`SCHEGENT_PHASE: ${inputs.phase}`);
    lines.push(`SCHEGENT_ITERATION: ${inputs.iteration}/${inputs.iterationCap}`);
    if (inputs.featureDir) {
      lines.push(`SCHEGENT_FEATURE_DIR: ${inputs.featureDir}`);
    }
    lines.push('');
    lines.push('OUTPUT CONTRACT:');
    lines.push(TOKEN_INSTRUCTION);
    lines.push('');
    lines.push(AUDIT_INSTRUCTION);

    if (inputs.perPhaseRulesPath) {
      lines.push('');
      lines.push(`Read rule file before acting: ${inputs.perPhaseRulesPath}`);
    }

    if (inputs.phaseMessagePath) {
      lines.push('');
      lines.push(`Phase message sidecar path: ${inputs.phaseMessagePath}`);
      lines.push('If you need to pass flat key=value context to the next phase, write phase-message.env there and list the path in the Schegent Audit Log files_created or files_modified array.');
    }

    lines.push('');
    lines.push('Previous Phase Messages:');
    if (inputs.previousPhaseMessage && Object.keys(inputs.previousPhaseMessage).length > 0) {
      for (const [key, value] of Object.entries(inputs.previousPhaseMessage).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        lines.push(`${key}=${value}`);
      }
    } else {
      lines.push('(none)');
    }

    if (inputs.carriedIssues && inputs.carriedIssues.length > 0) {
      lines.push('');
      lines.push('Unresolved from previous iteration:');
      for (const issue of inputs.carriedIssues) {
        if (typeof issue === 'string') {
          lines.push(`- ${issue}`);
        } else {
          const tag = issue.tag ? `[${issue.tag}] ` : '';
          lines.push(`- ${tag}${issue.summary}`);
        }
      }
    }

    lines.push('');
    lines.push('TASK:');
    lines.push(this.taskInstructionFor(inputs));
    lines.push('');
    lines.push('FEATURE DESCRIPTION:');
    lines.push(inputs.featureDescription);

    return lines.join('\n');
  }

  private taskInstructionFor(inputs: PromptInputs): string {
    const fromPhaseDef = inputs.phaseDef?.instruction;
    if (fromPhaseDef && fromPhaseDef.trim().length > 0) {
      return fromPhaseDef;
    }
    return BUILT_IN_INSTRUCTIONS[inputs.phase] ?? '(no-op)';
  }
}
