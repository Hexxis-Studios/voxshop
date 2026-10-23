use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

#[derive(Default)]
struct ServiceChild(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn start_service(
    app: AppHandle,
    child_state: State<'_, ServiceChild>,
) -> Result<String, String> {
    if child_state.0.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("The VoxShop service is already running.".into());
    }

    let root = app.path().resource_dir().map_err(|e| e.to_string())?;
    let data_dir = selected_data_dir(
        app.path().app_data_dir().map_err(|e| e.to_string())?,
        std::env::var_os("VOXSHOP_DATA_DIR").map(PathBuf::from),
    );
    ensure_data_dir(&data_dir)?;

    let mut command = app
        .shell()
        .sidecar("voxshop-node")
        .map_err(|e| format!("Could not locate the VoxShop service runtime: {e}"))?;
    command = command
        .args(["dist-server/server/main.js"])
        .current_dir(&root)
        .env("VOXSHOP_ROOT", root.as_os_str())
        .env("VOXSHOP_DATA_DIR", data_dir.as_os_str())
        .env("VOXSHOP_PORT", "0")
        .set_process_group(true);

    let (mut events, child) = command
        .spawn()
        .map_err(|e| format!("Could not start the VoxShop service: {e}"))?;
    let (ready_tx, ready_rx) = oneshot::channel::<Result<String, String>>();
    tauri::async_runtime::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        let mut last_error = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(url) = line
                        .strip_prefix("VoxShop: ")
                        .and_then(|s| s.split_whitespace().next())
                    {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(Ok(url.to_owned()));
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    last_error = String::from_utf8_lossy(&line).trim().to_owned();
                }
                CommandEvent::Error(error) => {
                    last_error = error;
                }
                CommandEvent::Terminated(status) => {
                    if let Some(tx) = ready_tx.take() {
                        let detail = if last_error.is_empty() {
                            String::new()
                        } else {
                            format!(" {last_error}")
                        };
                        let _ = tx.send(Err(format!(
                            "VoxShop service exited with code {:?}.{detail}",
                            status.code
                        )));
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    *child_state.0.lock().map_err(|e| e.to_string())? = Some(child);

    match tokio::time::timeout(Duration::from_secs(20), ready_rx).await {
        Ok(Ok(Ok(url))) => Ok(url),
        Ok(Ok(Err(error))) => stop_child(&child_state, error),
        Ok(Err(_)) => stop_child(
            &child_state,
            "The VoxShop service stopped before it was ready.".into(),
        ),
        Err(_) => stop_child(
            &child_state,
            "The VoxShop service did not become ready within 20 seconds.".into(),
        ),
    }
}

fn stop_child(state: &State<'_, ServiceChild>, error: String) -> Result<String, String> {
    if let Some(child) = state.0.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.kill();
    }
    Err(error)
}

fn selected_data_dir(default: PathBuf, override_dir: Option<PathBuf>) -> PathBuf {
    override_dir
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(default)
}

fn ensure_data_dir(data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("Could not create VoxShop data folder: {e}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServiceChild::default())
        .invoke_handler(tauri::generate_handler![start_service])
        .build(tauri::generate_context!())
        .expect("error while building VoxShop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app
                    .state::<ServiceChild>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|mut child| child.take())
                {
                    let _ = child.kill();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{ensure_data_dir, selected_data_dir};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "voxshop-tauri-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn startup_preserves_existing_access_file() {
        let directory = temporary_path("data-preservation");
        fs::create_dir_all(&directory).unwrap();
        let access_file = directory.join("access.json");
        let original = br#"{"port":12345,"token":"keep-existing-session"}"#;
        fs::write(&access_file, original).unwrap();

        ensure_data_dir(&directory).unwrap();

        assert_eq!(fs::read(&access_file).unwrap(), original);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn data_directory_override_is_opt_in() {
        let default = PathBuf::from("app-data");
        assert_eq!(selected_data_dir(default.clone(), None), default);

        let override_dir = PathBuf::from("isolated-acceptance-data");
        assert_eq!(
            selected_data_dir(default, Some(override_dir.clone())),
            override_dir
        );
    }
}
