# Quickstart & Dashboard Walkthrough

Welcome to the Schegent Dashboard! This guide will walk you through the core components of the Schegent Orchestrator extension, showing you how to configure settings, build custom phases, define execution pipelines, and monitor your active runs.

## 1. Configuring Settings

Before running your first pipeline, you'll need to configure your environment. Navigate to the **Settings** tab in the dashboard.

![Settings Configuration](../assets/walkthrough/03_settings.png)

Here, you can configure:
- **CLI Path**: Set the absolute path or PATH-resolvable path to your local `claude` binary.
- **Logging**: Enable verbose logging, set the runtime log level, and configure audit retention.
- **Limits**: Control invocation timeouts and maximum loop iterations to prevent runaway processes.

## 2. Building Custom Phases

A **Phase** is a discrete step in your AI workflow. In the **Pipeline Builder > Phases** tab, you can define the exact instructions and context for each step.

![Phase Builder](../assets/walkthrough/01_phase_builder.png)

- **Name & ID**: Give your phase a recognizable identity (e.g., `Specify with Brainstorm`).
- **Instruction**: The system prompt or primary directive for the autonomous agent during this phase.
- **Model & Effort**: Select which Claude model to use (e.g., `claude-opus-4-7`) and the effort level.

## 3. Assembling Pipelines

Once your phases are defined, you can chain them together into a **Pipeline**. 

![Pipeline Builder](../assets/walkthrough/02_pipeline_builder.png)

Under the **Pipelines** tab, you define the execution sequence. A standard "Dev New Feature" pipeline might look like this:
1. `Specify with Brainstorm`
2. `Spec-kit Clarify`
3. `Spec-kit Plan`
4. `Spec-kit Tasks`
5. `Spec-kit Analyze`
6. `Implement`

You can reorder phases via drag-and-drop or the up/down arrows to perfectly suit your team's Spec Driven Development workflow.

## 4. Monitoring Execution (The Orchestrator)

The **Operations** tab is your central command center. When you submit a feature request, it enters the Active Queue and begins processing through your pipeline.

![Operations Dashboard](../assets/walkthrough/04_orchestrator.png)

- **Active Queue**: See what's currently in-flight, paused, or pending.
- **Phase Progression**: A visual pipeline map showing exactly which phase is currently active.
- **Activity Feed**: Real-time streaming logs from the autonomous CLI backend. You can monitor tool calls, shell executions, and Claude's decision-making process live.

---

**Next Steps:**
Ready to dive deeper? Check out the [Sidebar Tour](sidebar-tour.md) for a guide on the VS Code native integration, or read about the [Spec Driven Development Workflow](../../AGENTS.md) to understand the philosophy behind the pipelines.
