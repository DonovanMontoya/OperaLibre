#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

fn main() {
    if let Err(error) = run() {
        let root = installation_root().unwrap_or_else(|_| PathBuf::from("."));
        let message = format!("OperaLibre could not complete the requested action:\n\n{error}");
        let _ = fs::write(root.join("LAUNCH-ERROR.txt"), format!("{message}\n"));
        show_error(&message);
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args_os().collect();
    if arguments
        .get(1)
        .is_some_and(|argument| argument == "--apply-update")
    {
        return apply_update(&arguments);
    }

    let root = installation_root()?;
    env::set_current_dir(&root)
        .map_err(|error| format!("Could not open {}: {error}", root.display()))?;

    if is_stop_launcher() {
        stop_server(&root)
    } else {
        start_server(&root, true)
    }
}

fn installation_root() -> Result<PathBuf, String> {
    let executable =
        env::current_exe().map_err(|error| format!("Could not locate the launcher: {error}"))?;
    let parent = executable
        .parent()
        .ok_or_else(|| "The launcher has no parent folder.".to_string())?;

    if cfg!(target_os = "macos") && parent.file_name().is_some_and(|name| name == "MacOS") {
        return parent
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .ok_or_else(|| "The macOS app is not inside an OperaLibre package.".to_string());
    }

    Ok(parent.to_path_buf())
}

fn is_stop_launcher() -> bool {
    env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|path| path.contains("stop operalibre") || path.contains("stop-operalibre"))
        || env::args().any(|argument| argument == "--stop")
}

fn start_server(root: &Path, open_when_ready: bool) -> Result<(), String> {
    fs::create_dir_all(root.join("audiobooks"))
        .map_err(|error| format!("Could not create the audiobooks folder: {error}"))?;
    fs::create_dir_all(root.join("data"))
        .map_err(|error| format!("Could not create the data folder: {error}"))?;

    let port = configured_port(&root.join("server.config")).unwrap_or(4000);
    if server_is_ready(port) {
        if open_when_ready {
            open_browser(port)?;
        }
        return Ok(());
    }

    let server_name = if cfg!(target_os = "windows") {
        "operalibre-server.exe"
    } else {
        "operalibre-server"
    };
    let server_path = root.join(server_name);
    if !server_path.is_file() {
        return Err(format!(
            "{server_name} is missing. Extract the complete combined package before starting."
        ));
    }

    let log_path = root.join("data").join("server.log");
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open {}: {error}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Could not prepare the server log: {error}"))?;

    let mut command = Command::new(&server_path);
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

    let child = command
        .spawn()
        .map_err(|error| format!("Could not launch {}: {error}", server_path.display()))?;
    fs::write(
        root.join("data").join("operalibre-server.pid"),
        child.id().to_string(),
    )
    .map_err(|error| format!("Could not save the server process ID: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if server_is_ready(port) {
            if open_when_ready {
                open_browser(port)?;
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }

    Err(format!(
        "The server did not become ready. Open {} for details.",
        log_path.display()
    ))
}

fn apply_update(arguments: &[std::ffi::OsString]) -> Result<(), String> {
    let package_root = required_update_argument(arguments, 2, "update package")?;
    let install_root = named_update_argument(arguments, "--install-root")?;
    let server_pid = named_update_argument(arguments, "--server-pid")?
        .to_string_lossy()
        .parse::<u32>()
        .map_err(|_| "The update server process ID is invalid.".to_string())?;
    let port = named_update_argument(arguments, "--port")?
        .to_string_lossy()
        .parse::<u16>()
        .map_err(|_| "The update server port is invalid.".to_string())?;

    let package_root = PathBuf::from(package_root);
    let install_root = PathBuf::from(install_root);
    validate_update_paths(&package_root, &install_root)?;
    wait_for_server_exit(server_pid, port)?;

    let backup_root = install_root.join("data").join("update-backups").join(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Could not create an update timestamp: {error}"))?
            .as_secs()
            .to_string(),
    );
    fs::create_dir_all(&backup_root)
        .map_err(|error| format!("Could not create {}: {error}", backup_root.display()))?;

    let server_name = server_binary_name();
    let install_server = install_root.join(server_name);
    let install_web = install_root.join("web");
    let install_version = install_root.join("VERSION.txt");
    move_if_exists(&install_server, &backup_root.join(server_name))?;
    move_if_exists(&install_web, &backup_root.join("web"))?;
    move_if_exists(&install_version, &backup_root.join("VERSION.txt"))?;

    let install_result = (|| {
        move_required(&package_root.join(server_name), &install_server)?;
        move_required(&package_root.join("web"), &install_web)?;
        move_required(&package_root.join("VERSION.txt"), &install_version)?;
        refresh_launchers(&package_root, &install_root)?;
        set_executable(&install_server)?;
        start_server(&install_root, false)
    })();

    if let Err(update_error) = install_result {
        let rollback_result = rollback_update(&install_root, &backup_root);
        return match rollback_result {
            Ok(()) => Err(format!(
                "The update failed and OperaLibre restored the previous version: {update_error}"
            )),
            Err(rollback_error) => Err(format!(
                "The update failed ({update_error}) and rollback also failed ({rollback_error}). The previous files remain in {}.",
                backup_root.display()
            )),
        };
    }

    Ok(())
}

fn required_update_argument(
    arguments: &[std::ffi::OsString],
    index: usize,
    label: &str,
) -> Result<std::ffi::OsString, String> {
    arguments
        .get(index)
        .cloned()
        .ok_or_else(|| format!("The {label} argument is missing."))
}

fn named_update_argument(
    arguments: &[std::ffi::OsString],
    name: &str,
) -> Result<std::ffi::OsString, String> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .ok_or_else(|| format!("The {name} update argument is missing."))
}

fn validate_update_paths(package_root: &Path, install_root: &Path) -> Result<(), String> {
    if !package_root.is_dir() || !install_root.is_dir() {
        return Err("The update package or OperaLibre installation folder is missing.".to_string());
    }
    if !package_root.join(server_binary_name()).is_file()
        || !package_root.join("web").is_dir()
        || !package_root.join("VERSION.txt").is_file()
    {
        return Err("The staged update package is incomplete.".to_string());
    }
    if !install_root.join("data").is_dir() || !install_root.join("server.config").is_file() {
        return Err("The target is not a managed OperaLibre combined installation.".to_string());
    }
    Ok(())
}

fn wait_for_server_exit(server_pid: u32, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if !process_is_running(server_pid) && !server_is_ready(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "Server process {server_pid} did not stop before the update timeout."
    ))
}

#[cfg(unix)]
fn process_is_running(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
}

fn server_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "operalibre-server.exe"
    } else {
        "operalibre-server"
    }
}

fn move_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Could not move {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn move_required(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("The update is missing {}.", source.display()));
    }
    move_if_exists(source, destination)
}

fn rollback_update(install_root: &Path, backup_root: &Path) -> Result<(), String> {
    let server_name = server_binary_name();
    let _ = stop_server(install_root);
    remove_if_exists(&install_root.join(server_name))?;
    remove_if_exists(&install_root.join("web"))?;
    remove_if_exists(&install_root.join("VERSION.txt"))?;
    move_required(
        &backup_root.join(server_name),
        &install_root.join(server_name),
    )?;
    move_required(&backup_root.join("web"), &install_root.join("web"))?;
    move_if_exists(
        &backup_root.join("VERSION.txt"),
        &install_root.join("VERSION.txt"),
    )?;
    set_executable(&install_root.join(server_name))?;
    start_server(install_root, false)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    }
    Ok(())
}

fn refresh_launchers(package_root: &Path, install_root: &Path) -> Result<(), String> {
    let updater_name = if cfg!(target_os = "windows") {
        "operalibre-updater.exe"
    } else {
        "operalibre-updater"
    };
    let updater = package_root.join(updater_name);
    if !updater.is_file() {
        return Err("The update launcher is missing.".to_string());
    }

    if cfg!(target_os = "windows") {
        copy_launcher(&updater, &install_root.join("Open OperaLibre.exe"))?;
        copy_launcher(&updater, &install_root.join("Stop OperaLibre.exe"))?;
    } else if cfg!(target_os = "macos") {
        copy_launcher(
            &updater,
            &install_root.join("Open OperaLibre.app/Contents/MacOS/operalibre-launcher"),
        )?;
        copy_launcher(
            &updater,
            &install_root.join("Stop OperaLibre.app/Contents/MacOS/operalibre-launcher"),
        )?;
    } else {
        copy_launcher(&updater, &install_root.join("open-operalibre"))?;
        copy_launcher(&updater, &install_root.join("stop-operalibre"))?;
    }
    Ok(())
}

fn copy_launcher(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{} has no parent folder.", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    fs::copy(source, destination).map_err(|error| {
        format!(
            "Could not refresh launcher {}: {error}",
            destination.display()
        )
    })?;
    set_executable(destination)
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("Could not make {} executable: {error}", path.display()))
}

#[cfg(windows)]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn stop_server(root: &Path) -> Result<(), String> {
    let pid_path = root.join("data").join("operalibre-server.pid");
    let pid = match fs::read_to_string(&pid_path) {
        Ok(pid) => pid.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {}: {error}", pid_path.display())),
    };

    let pid_number = pid
        .parse::<u32>()
        .map_err(|_| "The saved server process ID is invalid.".to_string())?;

    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();

    #[cfg(unix)]
    let status = Command::new("kill").arg(&pid).status();

    match status {
        Ok(status) if status.success() || !process_is_running(pid_number) => {
            let _ = fs::remove_file(pid_path);
            Ok(())
        }
        Ok(status) => Err(format!(
            "Could not stop server process {pid}; the stop command exited with {status}."
        )),
        Err(error) => Err(format!("Could not stop server process {pid}: {error}")),
    }
}

fn configured_port(config_path: &Path) -> Option<u16> {
    let contents = fs::read_to_string(config_path).ok()?;
    contents.lines().find_map(|raw_line| {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        (key.trim().eq_ignore_ascii_case("port"))
            .then(|| {
                value
                    .trim()
                    .trim_matches(|character| character == '"' || character == '\'')
                    .parse()
                    .ok()
            })
            .flatten()
    })
}

fn server_is_ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let request = b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut response = [0_u8; 64];
    stream
        .read(&mut response)
        .ok()
        .is_some_and(|count| String::from_utf8_lossy(&response[..count]).contains("200 OK"))
}

fn open_browser(port: u16) -> Result<(), String> {
    if env::var_os("OPERALIBRE_NO_BROWSER").is_some() {
        return Ok(());
    }

    let url = format!("http://localhost:{port}");

    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .args(["/C", "start", "", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();

    result
        .map(|_| ())
        .map_err(|error| format!("OperaLibre started, but the browser could not open: {error}"))
}

fn show_error(message: &str) {
    #[cfg(target_os = "windows")]
    {
        let escaped = message.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{escaped}', 'OperaLibre')"
        );
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!("display alert \"OperaLibre\" message \"{escaped}\""),
            ])
            .spawn();
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("sh")
            .args([
                "-c",
                "command -v zenity >/dev/null && zenity --error --title=OperaLibre --text=\"$1\" || true",
                "sh",
                message,
            ])
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::named_update_argument;
    use std::ffi::OsString;

    #[test]
    fn update_arguments_preserve_paths_with_spaces() {
        let arguments = [
            OsString::from("operalibre-updater"),
            OsString::from("--apply-update"),
            OsString::from("/tmp/update package"),
            OsString::from("--install-root"),
            OsString::from("/Applications/Opera Libre"),
        ];
        assert_eq!(
            named_update_argument(&arguments, "--install-root").unwrap(),
            OsString::from("/Applications/Opera Libre")
        );
    }
}
