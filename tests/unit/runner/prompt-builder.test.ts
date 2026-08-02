import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';

describe('PromptBuilder.build', () => {
  const builder = new PromptBuilder();

  it('includes SCHEGENT_PHASE and SCHEGENT_ITERATION headers', () => {
    const prompt = builder.build({
      phase: 'speckit-specify',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'Add login',
      featureDir: null
    });
    expect(prompt).toContain('SCHEGENT_PHASE: speckit-specify');
    expect(prompt).toContain('SCHEGENT_ITERATION: 1/10');
  });

  it('includes the feature directory when provided', () => {
    const prompt = builder.build({
      phase: 'speckit-plan',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: 'specs/001-foo'
    });
    expect(prompt).toContain('SCHEGENT_FEATURE_DIR: specs/001-foo');
  });

  it('omits SCHEGENT_FEATURE_DIR when featureDir is null', () => {
    const prompt = builder.build({
      phase: 'speckit-specify',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null
    });
    expect(prompt).not.toContain('SCHEGENT_FEATURE_DIR');
  });

  it('includes the output contract instructions', () => {
    const prompt = builder.build({
      phase: 'speckit-analyze',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null
    });
    expect(prompt).toContain('[SCHEGENT_STATUS: CLEAR]');
    expect(prompt).toContain('Open questions:');
    expect(prompt).toContain('Remaining issues:');
    expect(prompt).toContain('=== SCHEGENT AUDIT LOG ===');
    expect(prompt).toContain('=== END AUDIT LOG ===');
  });

  it('includes the per-phase task instruction for clarify', () => {
    const prompt = builder.build({
      phase: 'speckit-clarify',
      iteration: 2,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null
    });
    expect(prompt).toContain('/speckit-clarify');
  });

  it('instructs clarify to emit open_questions and resolved_questions metrics (010, T032, US2/SC-007)', () => {
    const prompt = builder.build({
      phase: 'speckit-clarify',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null
    });
    expect(prompt).toContain('open_questions: <N>');
    expect(prompt).toContain('resolved_questions: <N>');
  });

  it('embeds carried issues from a previous iteration', () => {
    const prompt = builder.build({
      phase: 'speckit-analyze',
      iteration: 2,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null,
      carriedIssues: [
        { tag: 'coverage', summary: 'missing acceptance criteria for FR-007' },
        { summary: 'undefined term: workflow_run' }
      ]
    });
    expect(prompt).toContain('Unresolved from previous iteration:');
    expect(prompt).toContain('[coverage] missing acceptance criteria for FR-007');
    expect(prompt).toContain('undefined term: workflow_run');
  });

  it('accepts plain string carried issues', () => {
    const prompt = builder.build({
      phase: 'speckit-clarify',
      iteration: 2,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null,
      carriedIssues: ['What auth method?']
    });
    expect(prompt).toContain('- What auth method?');
  });

  it('omits the carried-issues block when none provided', () => {
    const prompt = builder.build({
      phase: 'speckit-clarify',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null
    });
    expect(prompt).not.toContain('Unresolved from previous iteration');
  });

  it('always appends the feature description at the end', () => {
    const prompt = builder.build({
      phase: 'speckit-specify',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'A feature for X',
      featureDir: null
    });
    expect(prompt).toContain('FEATURE DESCRIPTION:');
    expect(prompt.endsWith('A feature for X')).toBe(true);
  });

  describe('catalog-driven instruction', () => {
    it('built-in specify phase prompt contains the verbatim move-from-switch substring', () => {
      const specifyDef = BUILT_IN_PHASES.find((p) => p.id === 'speckit-specify');
      expect(specifyDef).toBeTruthy();
      const prompt = builder.build({
        phase: 'speckit-specify',
        phaseDef: specifyDef,
        iteration: 1,
        iterationCap: 10,
        featureDescription: 'desc',
        featureDir: null
      });
      expect(prompt).toContain('/speckit-specify');
    });

    it('custom PhaseDef.instruction overrides the built-in fallback', () => {
      const customDef = {
        id: 'security-audit',
        name: 'Security Audit',
        instruction: 'Audit the spec for OWASP top 10 and emit remediation.',
        loopable: false
      };
      const prompt = builder.build({
        phase: 'security-audit',
        phaseDef: customDef,
        iteration: 1,
        iterationCap: 10,
        featureDescription: 'desc',
        featureDir: null
      });
      expect(prompt).toContain('Audit the spec for OWASP top 10');
      expect(prompt).not.toContain('/speckit-specify');
    });

    it('renders a skill reference as declarative Agent CLI task text only', () => {
      const prompt = builder.build({
        phase: 'security-audit',
        phaseDef: {
          id: 'security-audit',
          name: 'Security Audit',
          version: 1,
          skill: 'security-review',
          sourceScope: 'workspace'
        },
        iteration: 1,
        iterationCap: 10,
        featureDescription: 'desc',
        featureDir: null
      });
      expect(prompt).toContain('AGENT CLI SKILL REFERENCE: security-review');
      expect(prompt).toContain('does not load it, resolve it as a path, import it, or execute it');
    });

    it('falls back to the built-in switch when no phaseDef is supplied', () => {
      const prompt = builder.build({
        phase: 'speckit-clarify',
        iteration: 1,
        iterationCap: 10,
        featureDescription: 'desc',
        featureDir: null
      });
      expect(prompt).toContain('/speckit-clarify');
    });
  });

  it('injects only the immediate previous phase message and sidecar path', () => {
    const prompt = builder.build({
      phase: 'speckit-plan',
      iteration: 1,
      iterationCap: 10,
      featureDescription: 'desc',
      featureDir: null,
      phaseMessagePath: '/repo/.schegent/phase-message.env',
      previousPhaseMessage: { next_step: 'plan', token: '[REDACTED]' }
    });
    expect(prompt).toContain('Phase message sidecar path: /repo/.schegent/phase-message.env');
    expect(prompt).toContain('Previous Phase Messages:');
    expect(prompt).toContain('next_step=plan');
    expect(prompt).toContain('token=[REDACTED]');
  });
});
