fn main() {
  // the app's one command, which the panel's page (served by Obeya on 127.0.0.1) may call:
  // capabilities/panel.json allows it there
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["panel_fit"])))
    .expect("tauri-build failed");
}
