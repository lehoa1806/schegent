use std::path::{Path, PathBuf};

use schegent_contracts::{
    AUDIT_EVENT_TYPES, HOST_MESSAGE_TYPES, RUNNER_DEFAULT_MODEL, SIDEBAR_COMMAND_TYPES,
};

pub const PROTOTYPE_BANNER: &str = "Schegent Desktop Prototype (non-production)";
pub const UNSUPPORTED_REASON: &str = "unsupported-in-prototype";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrototypeAck {
    pub message_type: &'static str,
    pub correlation_id: String,
    pub status: AckStatus,
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckStatus {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrototypeHostMessage {
    pub message_type: &'static str,
    pub snapshot_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPrototypeShell {
    ui_bundle_path: PathBuf,
    app_state_dir: PathBuf,
    selected_workspace: Option<PathBuf>,
    recent_workspaces: Vec<PathBuf>,
    preserved_ui_state_json: Option<String>,
}

impl DesktopPrototypeShell {
    pub fn new(ui_bundle_path: impl Into<PathBuf>, app_state_dir: impl Into<PathBuf>) -> Self {
        Self {
            ui_bundle_path: ui_bundle_path.into(),
            app_state_dir: app_state_dir.into(),
            selected_workspace: None,
            recent_workspaces: Vec::new(),
            preserved_ui_state_json: None,
        }
    }

    pub fn ui_bundle_path(&self) -> &Path {
        &self.ui_bundle_path
    }

    pub fn app_state_dir(&self) -> &Path {
        &self.app_state_dir
    }

    pub fn selected_workspace(&self) -> Option<&Path> {
        self.selected_workspace.as_deref()
    }

    pub fn recent_workspaces(&self) -> &[PathBuf] {
        &self.recent_workspaces
    }

    pub fn select_workspace(&mut self, workspace_root: impl Into<PathBuf>) {
        let workspace_root = workspace_root.into();
        self.selected_workspace = Some(workspace_root.clone());
        self.recent_workspaces
            .retain(|entry| entry != &workspace_root);
        self.recent_workspaces.insert(0, workspace_root);
        self.recent_workspaces.truncate(10);
    }

    pub fn set_preserved_ui_state(&mut self, json: impl Into<String>) {
        self.preserved_ui_state_json = Some(json.into());
    }

    pub fn preserved_ui_state(&self) -> Option<&str> {
        self.preserved_ui_state_json.as_deref()
    }

    pub fn startup_summary(&self) -> String {
        format!(
            "{banner}\nUI bundle: {ui}\nApp state: {state}\nWorkflows: disabled",
            banner = PROTOTYPE_BANNER,
            ui = self.ui_bundle_path.display(),
            state = self.app_state_dir.display()
        )
    }

    pub fn state_snapshot_message(&self) -> PrototypeHostMessage {
        let workspace = self
            .selected_workspace
            .as_ref()
            .map(|path| json_string(&path.display().to_string()))
            .unwrap_or_else(|| "null".to_string());
        let snapshot_json = format!(
            "{{\"schemaVersion\":1,\"prototype\":true,\"productionParity\":false,\"workspaceRoot\":{},\"queue\":{{\"inFlight\":null,\"pending\":[],\"recent\":[],\"queues\":[]}},\"wakeUpModel\":{}}}",
            workspace,
            json_string(RUNNER_DEFAULT_MODEL)
        );
        PrototypeHostMessage {
            message_type: "STATE_SNAPSHOT",
            snapshot_json,
        }
    }

    pub fn handle_command(
        &self,
        command_type: &str,
        correlation_id: impl Into<String>,
    ) -> PrototypeAck {
        let correlation_id = correlation_id.into();
        if !SIDEBAR_COMMAND_TYPES.contains(&command_type) {
            return PrototypeAck {
                message_type: "CMD_ACK",
                correlation_id,
                status: AckStatus::Rejected,
                reason: Some("unknown-command"),
            };
        }

        match command_type {
            "CMD_OPEN_DASHBOARD" | "CMD_OPEN_AUDIT_LOG" | "CMD_OPEN_VERBOSE_SETTING" => {
                PrototypeAck {
                    message_type: "CMD_ACK",
                    correlation_id,
                    status: AckStatus::Accepted,
                    reason: None,
                }
            }
            _ => PrototypeAck {
                message_type: "CMD_ACK",
                correlation_id,
                status: AckStatus::Rejected,
                reason: Some(UNSUPPORTED_REASON),
            },
        }
    }

    pub fn raw_transcript_reading_enabled(&self) -> bool {
        false
    }
}

pub fn shared_contracts_ready() -> bool {
    HOST_MESSAGE_TYPES.contains(&"STATE_SNAPSHOT")
        && HOST_MESSAGE_TYPES.contains(&"CMD_ACK")
        && SIDEBAR_COMMAND_TYPES.contains(&"CMD_OPEN_DASHBOARD")
        && AUDIT_EVENT_TYPES.contains(&"phase-start")
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_non_production_banner_and_ui_bundle_path() {
        let shell = DesktopPrototypeShell::new("dist/webview/index.html", "/tmp/schegent-desktop");

        let summary = shell.startup_summary();

        assert!(summary.contains(PROTOTYPE_BANNER));
        assert!(summary.contains("dist/webview/index.html"));
        assert!(summary.contains("Workflows: disabled"));
    }

    #[test]
    fn tracks_explicit_workspace_selection_and_recent_workspaces() {
        let mut shell = DesktopPrototypeShell::new("dist/webview/index.html", "/tmp/app-state");

        shell.select_workspace("/workspace/a");
        shell.select_workspace("/workspace/b");
        shell.select_workspace("/workspace/a");

        assert_eq!(shell.selected_workspace(), Some(Path::new("/workspace/a")));
        assert_eq!(
            shell.recent_workspaces(),
            &[PathBuf::from("/workspace/a"), PathBuf::from("/workspace/b")]
        );
    }

    #[test]
    fn emits_fixture_state_snapshot_using_shared_message_literal() {
        let mut shell = DesktopPrototypeShell::new("dist/webview/index.html", "/tmp/app-state");
        shell.select_workspace("/workspace/project");

        let message = shell.state_snapshot_message();

        assert_eq!(message.message_type, "STATE_SNAPSHOT");
        assert!(message.snapshot_json.contains("\"prototype\":true"));
        assert!(message.snapshot_json.contains("\"productionParity\":false"));
        assert!(message.snapshot_json.contains("/workspace/project"));
    }

    #[test]
    fn accepts_safe_read_only_commands_and_rejects_mutating_commands() {
        let shell = DesktopPrototypeShell::new("dist/webview/index.html", "/tmp/app-state");

        let accepted = shell.handle_command("CMD_OPEN_DASHBOARD", "corr-1");
        assert_eq!(accepted.status, AckStatus::Accepted);
        assert_eq!(accepted.message_type, "CMD_ACK");

        let rejected = shell.handle_command("CMD_START", "corr-2");
        assert_eq!(rejected.status, AckStatus::Rejected);
        assert_eq!(rejected.reason, Some(UNSUPPORTED_REASON));
    }

    #[test]
    fn rejects_unknown_commands_and_never_reads_raw_transcripts() {
        let shell = DesktopPrototypeShell::new("dist/webview/index.html", "/tmp/app-state");

        let rejected = shell.handle_command("CMD_NOT_REAL", "corr-3");

        assert_eq!(rejected.status, AckStatus::Rejected);
        assert_eq!(rejected.reason, Some("unknown-command"));
        assert!(!shell.raw_transcript_reading_enabled());
    }

    #[test]
    fn consumes_generated_shared_contract_literals() {
        assert!(shared_contracts_ready());
    }
}
