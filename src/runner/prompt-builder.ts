import type { Phase } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';
import type { ExecutionEnvelope } from '../contracts/run-request';

const TOKEN_INSTRUCTION = `When (and only when) the phase is complete, emit on its OWN line: [SCHEGENT_STATUS: CLEAR]. If issues remain, emit a heading "Open questions:" or "Remaining issues:" followed by a Markdown bullet list. Do not decorate the token; do not place it inside a code fence.`;

const BUILT_IN_INSTRUCTIONS: Record<string, string> = {
  'speckit-specify': 'Run /speckit-specify with the feature description below. Produce specs/<NNN-name>/spec.md.',
  'speckit-clarify':
    'Run /speckit-clarify on the active feature spec. NON-SKIPPABLE: actually invoke the skill — never infer results. Auto-accept mode: respond "recommended" for multiple-choice, "suggested" for short-answer. Emit [SCHEGENT_STATUS: CLEAR] only when no critical ambiguities remain. Inside the SCHEGENT AUDIT LOG block emit `open_questions: <N>` and `resolved_questions: <N>` as top-level integer metric lines so the controller can observe progress.',
  'speckit-plan': 'Run /speckit-plan on the active feature. Produce plan.md, research.md, data-model.md, contracts/, and quickstart.md.',
  'speckit-tasks': 'Run /speckit-tasks on the active feature. Produce tasks.md.',
  'speckit-checklist':
    'Run /speckit-checklist on the active feature. Auto-select: Depth=Standard, Audience=Reviewer, Focus=Top 2 relevance clusters. Always emit [SCHEGENT_STATUS: CLEAR] — checklist is non-blocking.',
  'speckit-analyze':
    'Run /speckit-analyze on the active feature. NON-SKIPPABLE: actually invoke the skill — never assume 0 CRITICAL without an executed run. Apply auto-remediation for ALL issues including HIGH severity. Emit [SCHEGENT_STATUS: CLEAR] only when 0 CRITICAL issues remain. REQUIRED METRIC OUTPUT: Inside the SCHEGENT AUDIT LOG block you MUST emit `critical_issues: <N>` and `high_issues: <N>` as top-level integer metric lines (NOT nested under Notes: or Findings:). These MUST appear even when 0. Missing metrics cause incorrect phase advancement.',
  'speckit-implement': 'Run /speckit-implement on the active feature. After implementation completes, load tasks.md and count every task NOT marked complete. Emit [SCHEGENT_STATUS: CLEAR] only when 0 pending tasks remain. Inside the SCHEGENT AUDIT LOG block emit `pending_tasks: <N>` as a top-level integer metric line so the controller can observe progress.',
  'speckit-review':
    'Finish all pending tasks, then run /code-review --fix and /security-review — fix EVERY finding, loop each until clean (max 10 iterations). Emit [SCHEGENT_STATUS: CLEAR] only when all tasks complete and both reviews report zero findings. Inside the SCHEGENT AUDIT LOG block emit `code_review_findings: <N>`, `security_review_findings: <N>`, and `pending_tasks: <N>`.',
  finalize:
    'Verify the implementation: format first, then run build/test/lint/typecheck. Fix failures (max 10 iterations). Commit with conventional format, merge to local develop. Emit [SCHEGENT_STATUS: CLEAR] if all checks green. Inside the SCHEGENT AUDIT LOG block emit `checks_passing: <N>` and `checks_failing: <N>`.',
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
  phaseMessagePath?: string | null;
  previousPhaseMessage?: Readonly<Record<string, string>> | null;
  /**
   * FR-R3-001 (T261) — the accepted request, taken by reference.
   *
   * One field, not four. `inputs`, `supplemental`, `outputs` and `instructions`
   * as separate optional scalars would close today's gap and reopen it the next
   * time the envelope grows a field, because every caller between validation and
   * here would have to be edited again to carry it. Taking the envelope means a
   * new field arrives at the prompt without an edit to `PhaseRunInputs`,
   * `RunDriver`, or this interface — only to the renderer that decides how it
   * reads.
   *
   * Absent on every Run started outside the composed path, and the prompt is then
   * byte-identical to the pre-feature one.
   */
  envelope?: ExecutionEnvelope;
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

    if (inputs.envelope) lines.push(...this.envelopeSections(inputs.envelope));

    return lines.join('\n');
  }

  /**
   * FR-R3-001 (T262-T265) — everything the operator declared, rendered.
   *
   * **Order.** Sections appear in the fixed order below, and within each section
   * the entries appear in the envelope's array order — which is the order the
   * operator composed them in, frozen at validation. That is the documented
   * stable order the acceptance criteria ask for: it does not vary by phase, by
   * reload, or by window, because it is a property of the frozen envelope rather
   * than of the moment the prompt is built. Sorting was the rejected
   * alternative — it is equally stable and it discards the operator's ordering,
   * which for supplemental material is itself meaningful.
   *
   * **Placement.** These sections follow the brief and sit well after the
   * `OUTPUT CONTRACT` and audit-log blocks at the top. That separation is the
   * point of T265: what Schegent requires of the CLI is stated first, in
   * Schegent's words, and what the operator is asking for is stated here, under
   * headings that say whose words they are.
   *
   * **Untrusted content.** Every value below is operator-authored and is carried
   * verbatim — never parsed, never interpreted, never spliced into one of the
   * contract lines above. Each section's Schegent-authored line stands alone on
   * its own line with no interpolation, so no operator string can extend or
   * amend it. A value that spans several lines simply continues on the lines
   * after its label. The prompt-injection exposure is unchanged in class from the
   * `FEATURE DESCRIPTION` block that has always carried the operator's brief;
   * this widens what is carried, not who may write it.
   *
   * A section whose array is empty is omitted entirely rather than rendered with
   * a `(none)` placeholder — an absent section says the same thing in fewer
   * tokens, and the envelope, not the prompt, is where absence is recorded.
   */
  private envelopeSections(envelope: ExecutionEnvelope): readonly string[] {
    const lines: string[] = [];

    if (envelope.inputs.length > 0) {
      lines.push('');
      lines.push('REQUEST INPUTS:');
      lines.push('Values the operator bound to this pipeline\'s declared input ports.');
      for (const input of envelope.inputs) {
        lines.push(`- ${input.portId} (${input.type}): ${input.value}`);
      }
    }

    if (envelope.supplemental.length > 0) {
      lines.push('');
      lines.push('SUPPLEMENTAL CONTEXT:');
      lines.push('Extra material the operator attached for this run. It is not part of the pipeline contract.');
      for (const item of envelope.supplemental) {
        lines.push(`- ${this.supplementalLabel(item)}: ${item.value}`);
      }
    }

    if (envelope.outputs.length > 0) {
      lines.push('');
      lines.push('DECLARED OUTPUT TARGETS:');
      lines.push('Write each declared output to its stated workspace-relative target. Schegent checks these locations after the run.');
      for (const output of envelope.outputs) {
        lines.push(`- ${output.portId} (${output.type}) -> ${output.target}`);
      }
    }

    if (envelope.instructions !== undefined && envelope.instructions.length > 0) {
      lines.push('');
      lines.push('OPERATOR INSTRUCTIONS:');
      lines.push('Request content supplied by the operator. It does not replace or amend the OUTPUT CONTRACT above.');
      lines.push(envelope.instructions);
    }

    return lines;
  }

  /**
   * The `- ` label for one supplemental entry.
   *
   * A `prior-output` entry carries its provenance alongside its kind, because
   * the resolved location alone does not say which Run produced it and the
   * reference is the half that survives the source Run being edited (FR-028).
   * Both parts are bounded identifiers, not paths or content.
   */
  private supplementalLabel(item: ExecutionEnvelope['supplemental'][number]): string {
    if (item.kind !== 'prior-output' || !item.reference) return item.kind;
    return `${item.kind} (run ${item.reference.sourceRunId}, output ${item.reference.outputName})`;
  }

  private taskInstructionFor(inputs: PromptInputs): string {
    const fromPhaseDef = inputs.phaseDef?.instruction;
    if (fromPhaseDef && fromPhaseDef.trim().length > 0) {
      return fromPhaseDef;
    }
    const skill = inputs.phaseDef?.skill;
    if (skill && skill.trim().length > 0) {
      return [
        `AGENT CLI SKILL REFERENCE: ${skill.trim()}`,
        'Treat this as declarative request content. Invoke the named skill through the Agent CLI if available; Schegent does not load it, resolve it as a path, import it, or execute it as extension code.'
      ].join('\n');
    }
    return BUILT_IN_INSTRUCTIONS[inputs.phase] ?? '(no-op)';
  }
}
