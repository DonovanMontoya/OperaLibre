#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
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
        let message = format!("OperaLibre could not start:\n\n{error}");
        let _ = fs::write(root.join("LAUNCH-ERROR.txt"), format!("{message}\n"));
        show_error(&message);
    }
}

fn run() -> Result<(), String> {
    let root = installation_root()?;
    env::set_current_dir(&root)
        .map_err(|error| format!("Could not open {}: {error}", root.display()))?;

    if is_stop_launcher() {
        stop_server(&root)
    } else {
        start_server(&root)
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

fn start_server(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("audiobooks"))
        .map_err(|error| format!("Could not create the audiobooks folder: {error}"))?;
    fs::create_dir_all(root.join("data"))
        .map_err(|error| format!("Could not create the data folder: {error}"))?;

    let port = configured_port(&root.join("server.config")).unwrap_or(4000);
    if server_is_ready(port) {
        open_browser(port)?;
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
            open_browser(port)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }

    Err(format!(
        "The server did not become ready. Open {} for details.",
        log_path.display()
    ))
}

fn stop_server(root: &Path) -> Result<(), String> {
    let pid_path = root.join("data").join("operalibre-server.pid");
    let pid = match fs::read_to_string(&pid_path) {
        Ok(pid) => pid.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {}: {error}", pid_path.display())),
    };

    if pid.parse::<u32>().is_err() {
        return Err("The saved server process ID is invalid.".to_string());
    }

    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();

    #[cfg(unix)]
    let status = Command::new("kill").arg(&pid).status();

    match status {
        Ok(_) => {
            let _ = fs::remove_file(pid_path);
            Ok(())
        }
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
