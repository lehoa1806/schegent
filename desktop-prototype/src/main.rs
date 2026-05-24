use std::env;
use std::path::PathBuf;

use schegent_desktop_prototype::DesktopPrototypeShell;

fn main() {
    let ui_bundle = env::args()
        .nth(1)
        .unwrap_or_else(|| "dist/webview/index.html".to_string());
    let app_state_dir = env::var("SCHEGENT_DESKTOP_PROTOTYPE_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir().join("schegent-desktop-prototype"));
    let shell = DesktopPrototypeShell::new(ui_bundle, app_state_dir);
    println!("{}", shell.startup_summary());
}
