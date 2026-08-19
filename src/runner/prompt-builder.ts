import type { Phase } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';
import type { ExecutionEnvelope } from '../contracts/run-request';

const TOKEN_INSTRUCTION = `When (and only when) the phase is complete, emit on its OWN line: [SCHEGENT_STATUS: CLEAR]. If issues remain, emit a heading "Open questions:" or "Remaining issues:" followed by a Markdown bullet list. Do not decorate the token; do not place it inside a code fence.`;

// Feature 098 (FR-008, FR-019) — `BUILT_IN_INSTRUCTIONS` stood here: ten Spec
// Kit instruction strings keyed by Phase id, consulted by `taskInstructionFor`
// whenever a phase arrived without a definition. It was the last place in the
// host where an id carried content rather than merely naming it, and the text
// it carried now lives where the rest of the process content does — in
// `examples/speckit-new-feature.pipeline.yaml`, which the operator imports.
//
// Nothing reachable lost an instruction with it. The validator admits exactly
// one of `instruction` or `skill` on every Phase, so a resolved definition
// always supplies its own; the table could only ever answer for a phase nobody
// had defined, and for that phase `(no-op)` is the honest answer.

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
    return '(no-op)';
  }
}
