#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod deployment;

use deployment::DeploymentConfig;

use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// How long the launcher waits for a freshly started server to answer on its
/// port. The server can scan a large library before it is ready, so the
/// ceiling is generous; an exited process is reported immediately instead.
const STARTUP_CEILING: Duration = Duration::from_secs(10 * 60);
/// How long a stopped server may take to shut down before it is killed.
const SHUTDOWN_CEILING: Duration = Duration::from_secs(30);

/// What happened after the launcher asked the server to start.
#[derive(Debug, PartialEq, Eq)]
enum StartOutcome {
    /// The server answered on its port.
    Ready,
    /// The server process is still running but had not answered within the
    /// startup ceiling — usually a long first scan. Not an error.
    StillStarting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerReadiness {
    Absent,
    Starting,
    Ready,
    Unavailable,
}

fn main() {
    if let Err(error) = run() {
        let arguments: Vec<_> = env::args_os().collect();
        let updating = arguments.get(1).is_some_and(|arg| arg == "--apply-update");
        let root = if updating {
            named_update_argument(&arguments, "--install-root").map(PathBuf::from)
        } else {
            installation_root()
        }
        .unwrap_or_else(|_| PathBuf::from("."));
        let message = format!("OperaLibre could not complete the requested action:\n\n{error}");
        eprintln!("{message}");
        append_log(&root, &message);
        let _ = fs::write(root.join("LAUNCH-ERROR.txt"), format!("{message}\n"));
        if !updating && !arguments.iter().any(|arg| arg == "--service-start") {
            show_message(&message);
        }
        std::process::exit(1);
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
    // Normal launcher commands resolve relative environment paths from the
    // installation; --apply-update above keeps the server's inherited cwd.
    env::set_current_dir(&root)
        .map_err(|error| format!("Could not open {}: {error}", root.display()))?;

    if arguments.get(1).is_some_and(|arg| arg == "--service-start") {
        return start_supervised_server(&root);
    }

    if is_stop_launcher() {
        return stop_server(&root);
    }

    if start_server(&root, true, None, None)? == StartOutcome::StillStarting {
        let port = server_port(&root)?;
        show_message(&format!(
            "OperaLibre is still starting. Scanning a large library can take a while; open http://localhost:{port} once it finishes, or check {} for details.",
            server_log_path(&root).display()
        ));
    }
    Ok(())
}

// Keep launcher files where previously installed Open and Stop launchers look.
// The selected deployment's data folder is used separately for update state.
fn data_dir(root: &Path) -> PathBuf {
    configured_value(&root.join("server.config"), "data_dir")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("OPERALIBRE_DATA_DIR").map(PathBuf::from))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.join("data"))
}

fn server_log_path(root: &Path) -> PathBuf {
    data_dir(root).join("server.log")
}

fn pid_path(root: &Path) -> PathBuf {
    data_dir(root).join("operalibre-server.pid")
}

/// Best-effort note in the server log, which is the file users are told to
/// check; the launchers themselves have no console.
fn append_log(root: &Path, message: &str) {
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(server_log_path(root))
    {
        let _ = writeln!(log, "[launcher] {message}");
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

/// Starts the server and waits for it. `trial_token` marks a build the
/// updater has just installed: it refuses requests until committed with that
/// token (see `commit_update_trial`).
fn start_server(
    root: &Path,
    open_when_ready: bool,
    trial_token: Option<&str>,
    update: Option<&DeploymentConfig>,
) -> Result<StartOutcome, String> {
    fs::create_dir_all(root.join("audiobooks"))
        .map_err(|error| format!("Could not create the audiobooks folder: {error}"))?;
    let data_dir = data_dir(root);
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Could not create the data folder: {error}"))?;
    secure_directory(&data_dir)?;

    let port = match update {
        Some(update) => update.port,
        None => server_port(root)?,
    };
    let log_path = data_dir.join("server.log");

    // A server already up, or still coming up from an earlier start, is
    // waited on rather than started twice. One that goes away meanwhile
    // (`None`) gets a fresh start below.
    if !matches!(server_readiness(port), ServerReadiness::Absent)
        && let Some(outcome) = wait_for_readiness(port, open_when_ready, &log_path, None)?
    {
        return Ok(outcome);
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

    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    log_options.mode(0o600);
    let stdout = log_options
        .open(&log_path)
        .map_err(|error| format!("Could not open {}: {error}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Could not prepare the server log: {error}"))?;

    let mut command = Command::new(&server_path);
    // Normal launcher commands already chdir to the installation. Updates
    // inherit the running server's cwd, including its default data folder.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    match trial_token {
        Some(token) => command.env(UPDATE_TRIAL_ENV, token),
        None => command.env_remove(UPDATE_TRIAL_ENV),
    };

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not launch {}: {error}", server_path.display()))?;
    let pid_path = pid_path(root);
    fs::write(&pid_path, child.id().to_string())
        .map_err(|error| format!("Could not save the server process ID: {error}"))?;
    secure_file(&pid_path)?;

    let outcome = wait_for_readiness(port, open_when_ready, &log_path, Some(&mut child))?
        .expect("a started server is polled until it settles, never given up on");
    if outcome == StartOutcome::StillStarting {
        append_log(
            root,
            "the server is still starting after the launcher's wait; leaving it running",
        );
    }
    Ok(outcome)
}

/// Polls the server until it is ready, has failed, or the startup ceiling
/// passes: the listener comes up before a large first scan has published its
/// catalogue, so a `Starting` answer is waited on. `child` is the process
/// this launcher started, if any; its exit is reported as soon as it
/// happens. Without one, a server that stops answering yields `None` so the
/// caller can start its own.
fn wait_for_readiness(
    port: u16,
    open_when_ready: bool,
    log_path: &Path,
    mut child: Option<&mut Child>,
) -> Result<Option<StartOutcome>, String> {
    let deadline = Instant::now() + STARTUP_CEILING;
    loop {
        match server_readiness(port) {
            ServerReadiness::Ready => {
                if open_when_ready {
                    open_browser(port)?;
                }
                return Ok(Some(StartOutcome::Ready));
            }
            ServerReadiness::Unavailable => {
                return Err(format!(
                    "The server is running, but its library could not be loaded. Open {} for details.",
                    log_path.display()
                ));
            }
            ServerReadiness::Absent if child.is_none() => return Ok(None),
            ServerReadiness::Absent | ServerReadiness::Starting => {}
        }
        if let Some(child) = &mut child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "The server exited during startup ({status}). Open {} for details.",
                        log_path.display()
                    ));
                }
                Ok(None) => {}
                Err(error) => {
                    return Err(format!("Could not check on the server process: {error}"));
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(Some(StartOutcome::StillStarting));
        }
        thread::sleep(Duration::from_millis(300));
    }
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn update_lock(root: &Path, server_data: &Path) -> Result<Vec<fs::File>, String> {
    // Already-running launchers still lock the legacy directory. Keep both
    // locations locked until the transaction (or supervised takeover) ends.
    let mut directories = Vec::new();
    for data in [server_data.to_path_buf(), data_dir(root)] {
        fs::create_dir_all(&data).map_err(|error| error.to_string())?;
        secure_directory(&data)?;
        directories.push(fs::canonicalize(&data).map_err(|error| error.to_string())?);
    }
    // Canonical paths avoid locking the same file twice through an alias;
    // a fixed order also prevents competing new launchers from deadlocking.
    directories.sort();
    directories.dedup();
    let mut locks = Vec::new();
    for data in directories {
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options
            .open(data.join("update.lock"))
            .map_err(|error| error.to_string())?;
        file.lock()
            .map_err(|error| format!("Could not lock the update handoff: {error}"))?;
        locks.push(file);
    }
    Ok(locks)
}

#[cfg(target_os = "linux")]
fn start_supervised_server(root: &Path) -> Result<(), String> {
    // The descriptor closes on exec. Hold the lock through retirement and PID
    // publication so a queued updater cannot race the takeover.
    server_port(root)?;
    let _lock = update_lock(root, &data_dir(root))?;
    let data = data_dir(root);
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    secure_directory(&data)?;
    stop_server(root)?;
    fs::write(pid_path(root), std::process::id().to_string())
        .map_err(|error| format!("Could not save the supervised PID: {error}"))?;
    secure_file(&pid_path(root))?;
    let mut command = Command::new(root.join(server_binary_name()));
    let error = command.current_dir(root).exec();
    Err(format!("Could not start the supervised server: {error}"))
}

#[cfg(not(target_os = "linux"))]
fn start_supervised_server(_root: &Path) -> Result<(), String> {
    Err("--service-start is supported only on Linux.".to_string())
}

fn publish_update_result(
    root: &Path,
    data: &Path,
    result: &Result<(), String>,
) -> Result<(), String> {
    let message = match result {
        Ok(()) => format!(
            "Succeeded: {}",
            fs::read_to_string(root.join("VERSION.txt"))
                .unwrap_or_default()
                .trim()
        ),
        Err(error) => format!("Failed: {error}"),
    };
    append_log(root, &message);
    eprintln!("{message}");
    let temporary = data.join("update-result.txt.tmp");
    fs::write(&temporary, format!("{message}\n")).map_err(|error| error.to_string())?;
    secure_file(&temporary)?;
    // This is the completion signal. Never watch VERSION.txt, which changes
    // while the transaction is still in progress (and again during rollback).
    fs::rename(temporary, data.join("update-result.txt")).map_err(|error| error.to_string())
}

fn apply_update(arguments: &[std::ffi::OsString]) -> Result<(), String> {
    let root = PathBuf::from(named_update_argument(arguments, "--install-root")?);
    let deployment = update_deployment(arguments, &root)?;
    deployment.validate_update()?;
    // Older servers relied on the updater restarting from the installation.
    if optional_named_update_argument(arguments, "--server-config").is_none() {
        env::set_current_dir(&root).map_err(|error| error.to_string())?;
    }
    let _lock = update_lock(&root, &deployment.data_dir)?;
    let result = apply_update_inner(arguments, &deployment);
    let published = publish_update_result(&root, &deployment.data_dir, &result);
    match (result, published) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(format!(
            "Update installed, but could not publish its result: {error}"
        )),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn apply_update_inner(
    arguments: &[std::ffi::OsString],
    deployment: &DeploymentConfig,
) -> Result<(), String> {
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
    // Servers older than the --layout argument omit it; those are always
    // combined installations.
    let includes_web = match optional_named_update_argument(arguments, "--layout") {
        None => true,
        Some(layout) if layout == "combined" => true,
        Some(layout) if layout == "server-only" => false,
        Some(layout) => {
            return Err(format!(
                "The update layout {} is not supported.",
                layout.to_string_lossy()
            ));
        }
    };

    let package_root = PathBuf::from(package_root);
    let install_root = PathBuf::from(install_root);
    validate_update_paths(&package_root, &install_root)?;
    deployment.validate_update()?;
    // Before the running server is waited out, so failing here leaves it up.
    let trial_token = update_trial_token()?;
    let port = if optional_named_update_argument(arguments, "--server-config").is_some() {
        deployment.port
    } else {
        port
    };
    wait_for_server_exit(server_pid, port)?;

    let backup_root = deployment.data_dir.join("update-backups").join(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Could not create an update timestamp: {error}"))?
            .as_secs()
            .to_string(),
    );
    let server_name = server_binary_name();
    let install_server = install_root.join(server_name);
    let install_web = install_root.join("web");
    let install_version = install_root.join("VERSION.txt");
    let data_snapshot = backup_root.join("data");
    if let Err(staging_error) = prepare_update(
        &install_root,
        &deployment.data_dir,
        &backup_root,
        includes_web,
    ) {
        // No new build has run, so the data is still the previous build's.
        let _ = fs::remove_dir_all(&data_snapshot);
        let restart = start_server(&install_root, false, None, Some(deployment))
            .and_then(require_ready_start);
        return Err(match restart {
            Ok(()) => format!(
                "Could not prepare the update; the previous server was restarted: {staging_error}"
            ),
            Err(restart_error) => format!(
                "Could not prepare the update ({staging_error}), and could not restart the previous server ({restart_error}). Check {}.",
                backup_root.display()
            ),
        });
    }

    let install_result = (|| -> Result<(), String> {
        move_required(&package_root.join(server_name), &install_server)?;
        if includes_web {
            move_required(&package_root.join("web"), &install_web)?;
        }
        // Independent of the web bundle: every managed installation has
        // launchers, and leaving them behind strands the updater at the
        // version that shipped with the original download.
        refresh_launchers(&package_root, &install_root)?;
        move_required(&package_root.join("VERSION.txt"), &install_version)?;
        set_executable(&install_server)?;
        // An update is successful only after its first catalogue is published;
        // a failed or indefinitely withheld scan must restore the old build.
        // Until the commit below the new build acknowledges nothing, so a
        // rollback up to that point discards no client's change.
        require_ready_start(start_server(
            &install_root,
            false,
            Some(&trial_token),
            Some(deployment),
        )?)?;
        match commit_update_trial(deployment.port, &trial_token)? {
            TrialCommit::Committed => {}
            TrialCommit::Unsupported => append_log(
                &install_root,
                "this build predates update trials; changes made while it was starting are not protected by a rollback",
            ),
        }
        Ok(())
    })();

    if let Err(update_error) = install_result {
        let rollback_result =
            rollback_update(&install_root, &backup_root, includes_web, deployment);
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

    let _ = fs::remove_dir_all(&data_snapshot);
    let _ = fs::remove_file(backup_root.join(RESTORE_PENDING));
    let _ = fs::remove_dir(backup_root.join(FAILED_DATA_PARTIAL));
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
    optional_named_update_argument(arguments, name)
        .ok_or_else(|| format!("The {name} update argument is missing."))
}

fn optional_named_update_argument(
    arguments: &[std::ffi::OsString],
    name: &str,
) -> Option<std::ffi::OsString> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
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
    Ok(())
}

fn wait_for_server_exit(server_pid: u32, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if !process_is_running(server_pid) && server_readiness(port) == ServerReadiness::Absent {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "Server process {server_pid} did not stop before the update timeout."
    ))
}

/// Whether `pid` is alive. A zombie — a child of this launcher that has
/// exited but not been reaped — counts as gone, otherwise waiting for a
/// server this process started could never finish.
#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> bool {
    let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // The state letter follows the parenthesised command name, which may
    // itself contain spaces and parentheses.
    let state = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest.trim_start())
        .and_then(|rest| rest.chars().next());
    !matches!(state, None | Some('Z') | Some('X'))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_is_running(pid: u32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            let state = String::from_utf8_lossy(&output.stdout);
            let state = state.trim();
            !state.is_empty() && !state.starts_with('Z')
        })
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
}

fn process_command_matches(command: &str, expected_executable: &Path) -> bool {
    let expected = expected_executable.to_string_lossy();
    let command = command.trim();
    command == expected
        || command
            .strip_prefix(expected.as_ref())
            .is_some_and(|remainder| remainder.chars().next().is_some_and(char::is_whitespace))
}

#[cfg(unix)]
fn process_is_operalibre_server(pid: u32, root: &Path) -> bool {
    let expected = fs::canonicalize(root.join(server_binary_name()))
        .unwrap_or_else(|_| root.join(server_binary_name()));
    #[cfg(target_os = "linux")]
    if let Ok(actual) = fs::read_link(format!("/proc/{pid}/exe")) {
        return fs::canonicalize(&actual).unwrap_or(actual) == expected;
    }

    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            process_command_matches(&String::from_utf8_lossy(&output.stdout), &expected)
        })
}

#[cfg(windows)]
fn process_is_operalibre_server(pid: u32, root: &Path) -> bool {
    let expected = fs::canonicalize(root.join(server_binary_name()))
        .unwrap_or_else(|_| root.join(server_binary_name()));
    let script =
        format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').ExecutablePath");
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|actual| {
            actual
                .trim()
                .eq_ignore_ascii_case(expected.to_string_lossy().as_ref())
        })
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

fn stage_installed_files(
    install_root: &Path,
    backup_root: &Path,
    includes_web: bool,
) -> Result<(), String> {
    fs::create_dir_all(backup_root)
        .map_err(|error| format!("Could not create {}: {error}", backup_root.display()))?;
    // Recorded before anything moves, so failing here leaves the installation
    // as it was. Rollback then removes the new build's VERSION.txt rather
    // than keeping it.
    if !install_root.join("VERSION.txt").exists() {
        fs::write(backup_root.join(NO_VERSION_MARKER), b"")
            .map_err(|error| format!("Could not record the missing VERSION.txt: {error}"))?;
    }
    let mut moved = Vec::new();
    for name in [server_binary_name(), "web", "VERSION.txt"] {
        if name == "web" && !includes_web {
            continue;
        }
        let source = install_root.join(name);
        if !source.exists() {
            continue;
        }
        if let Err(error) = move_required(&source, &backup_root.join(name)) {
            // Staging can fail after moving only part of the installation.
            // Full rollback deletes installed files first, so use the journal
            // here to leave every file not yet backed up alone.
            let mut restore_errors = Vec::new();
            for moved_name in moved.into_iter().rev() {
                if let Err(restore_error) = move_required(
                    &backup_root.join(moved_name),
                    &install_root.join(moved_name),
                ) {
                    restore_errors.push(restore_error);
                }
            }
            return if restore_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; restoring staged files also failed: {}. Backups remain in {}.",
                    restore_errors.join("; "),
                    backup_root.display()
                ))
            };
        }
        moved.push(name);
    }
    Ok(())
}

/// Everything rollback needs, in place before the new build is moved in.
/// Without the data snapshot and its restore copies a failed start could leave
/// nothing the previous build can open, or no space to put it back, so a
/// failure here stops the update before anything is swapped.
fn prepare_update(
    install_root: &Path,
    data: &Path,
    backup_root: &Path,
    includes_web: bool,
) -> Result<(), String> {
    snapshot_data(data, &backup_root.join("data"))
        .and_then(|()| prepare_rollback_records(backup_root))
        .and_then(|()| stage_installed_files(install_root, backup_root, includes_web))
}

const RESTORE_REQUIRED: &str = "restore-required";
const RESTORE_PENDING: &str = "restore-pending";
const FAILED_DATA: &str = "failed-data";
const FAILED_DATA_PARTIAL: &str = "failed-data.partial";

/// Rollback may run on a disk the failed build filled, so what it records is
/// made now: the folder that keeps the failed build's data, and the marker
/// that a rename turns into `restore-required`.
fn prepare_rollback_records(backup_root: &Path) -> Result<(), String> {
    let partial = backup_root.join(FAILED_DATA_PARTIAL);
    fs::create_dir_all(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;
    let pending = backup_root.join(RESTORE_PENDING);
    fs::write(&pending, b"")
        .map_err(|error| format!("Could not create {}: {error}", pending.display()))?;
    sync_file(&pending)?;
    sync_directory(backup_root);
    Ok(())
}

/// The data half of a rollback, with the failed server stopped. Only putting
/// the snapshot back can fail it: keeping the failed build's data and
/// recording the decision are worth having, never worth leaving the
/// installation down for. `restore-required` is recorded after the failed
/// data is kept and before the snapshot goes back, so it also marks the point
/// past which the live files may be the snapshot's: a rollback that finds it
/// restores again and never adds those files to what was kept.
fn roll_back_data(install_root: &Path, data: &Path, backup_root: &Path) -> Result<(), String> {
    let marker = backup_root.join(RESTORE_REQUIRED);
    let kept = if marker.is_file() {
        "left the failed build's data as an earlier rollback kept it".to_string()
    } else {
        let kept = match preserve_failed_data(data, backup_root) {
            Ok(kept) => format!("kept the failed build's data in {}", kept.display()),
            Err(error) => format!("could not keep the failed build's data: {error}"),
        };
        if let Err(error) = fs::rename(backup_root.join(RESTORE_PENDING), &marker)
            .or_else(|_| fs::write(&marker, b""))
        {
            append_log(
                install_root,
                &format!("could not record the data restore ({error}); restoring anyway"),
            );
        }
        sync_directory(backup_root);
        kept
    };
    restore_data(data, &backup_root.join("data"))?;
    append_log(
        install_root,
        &format!(
            "the failed update had upgraded the data; restored the copy taken before it and {kept}"
        ),
    );
    Ok(())
}

fn rollback_update(
    install_root: &Path,
    backup_root: &Path,
    includes_web: bool,
    deployment: &DeploymentConfig,
) -> Result<(), String> {
    let server_name = server_binary_name();
    let stopped = stop_server(install_root);
    let data = &deployment.data_dir;
    let snapshot = backup_root.join("data");
    // Decided once: after a restore the formats match the snapshot again, so a
    // rollback run a second time (the previous build failed to start after
    // the first) still restores instead of keeping that build's leftovers.
    let restore_marker = backup_root.join(RESTORE_REQUIRED);
    if restore_marker.is_file() || data_was_upgraded(data, &snapshot) {
        // Files replaced under a server that is still running would keep
        // receiving its writes after the previous build had started.
        stopped?;
        roll_back_data(install_root, data, backup_root)?;
    }
    let backup_version = backup_root.join("VERSION.txt");
    if backup_version.exists() {
        restore_backed_up(&backup_version, &install_root.join("VERSION.txt"))?;
    } else if backup_root.join(NO_VERSION_MARKER).exists() {
        remove_if_exists(&install_root.join("VERSION.txt"))?;
    }
    restore_backed_up(
        &backup_root.join(server_name),
        &install_root.join(server_name),
    )?;
    if includes_web {
        restore_backed_up(&backup_root.join("web"), &install_root.join("web"))?;
    }
    set_executable(&install_root.join(server_name))?;
    require_ready_start(start_server(install_root, false, None, Some(deployment))?)?;
    let _ = fs::remove_dir_all(snapshot);
    let _ = fs::remove_file(restore_marker);
    let _ = fs::remove_file(backup_root.join(RESTORE_PENDING));
    let _ = fs::remove_dir(backup_root.join(FAILED_DATA_PARTIAL));
    Ok(())
}

/// Puts back one file or folder the update moved aside. A backup already
/// gone was put back by an earlier run of this rollback, so the installed
/// copy is kept rather than deleted.
/// Left in the backup by an installation that had no VERSION.txt.
const NO_VERSION_MARKER: &str = "no-version";

fn restore_backed_up(backup: &Path, installed: &Path) -> Result<(), String> {
    if !backup.exists() {
        return if installed.exists() {
            Ok(())
        } else {
            Err(format!("The update is missing {}.", backup.display()))
        };
    }
    remove_if_exists(installed)?;
    move_required(backup, installed)
}

/// Keeps the failed build's data beside the snapshot before the snapshot is
/// put back, for an owner to recover anything from by hand. The database and
/// identities are hard-linked, so the restore can still replace each live
/// file with a single rename and there is never a moment without one; the
/// write-ahead log and shared memory, which the restore removes anyway, are
/// moved with them so the database stays readable on its own. A volume
/// without hard links gets moves instead. Collected under `.partial` and
/// renamed when complete, so an interrupted run resumes: until then no
/// restore has begun, every live file is still the failed build's, and a
/// file already kept is never replaced.
fn preserve_failed_data(data: &Path, backup_root: &Path) -> Result<PathBuf, String> {
    let kept = backup_root.join(FAILED_DATA);
    if kept.is_dir() {
        return Ok(kept);
    }
    let partial = backup_root.join(FAILED_DATA_PARTIAL);
    fs::create_dir_all(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;
    let wal = format!("{DATABASE}-wal");
    let shm = format!("{DATABASE}-shm");
    for name in [DATABASE, IDENTITIES, wal.as_str(), shm.as_str()] {
        let live = data.join(name);
        let copy = partial.join(name);
        if !live.exists() || copy.exists() {
            continue;
        }
        let linked =
            (name == DATABASE || name == IDENTITIES) && fs::hard_link(&live, &copy).is_ok();
        if !linked {
            fs::rename(&live, &copy).map_err(|error| {
                format!(
                    "Could not keep {} in {}: {error}",
                    live.display(),
                    partial.display()
                )
            })?;
        }
    }
    sync_directory(&partial);
    sync_directory(data);
    fs::rename(&partial, &kept)
        .map_err(|error| format!("Could not finish keeping the failed build's data: {error}"))?;
    sync_directory(backup_root);
    Ok(kept)
}

/// State the server upgrades in place and an older build then refuses: the
/// database by its `schema_version`, the library identities by `version`.
const DATABASE: &str = "operalibre.db";
const IDENTITIES: &str = "library-identities.json";

/// Copies of the snapshot that rollback renames over the live files. The new
/// build may use up the free disk space, so they are made before it runs and
/// rollback copies nothing. They sit in the snapshot folder, never beside the
/// live files, and the snapshot itself stays whole for another try.
fn restore_copies(snapshot: &Path) -> PathBuf {
    snapshot.join("restore")
}

/// Copies the state an update may upgrade into `snapshot`, with its restore
/// copies. The server has stopped by now; `VACUUM INTO` still yields a
/// consistent copy if it left a write-ahead log behind, which copying the file
/// would not.
fn snapshot_data(data: &Path, snapshot: &Path) -> Result<(), String> {
    let prepared = restore_copies(snapshot);
    let result = (|| {
        fs::create_dir_all(snapshot)
            .map_err(|error| format!("Could not create {}: {error}", snapshot.display()))?;
        let database = data.join(DATABASE);
        if database.is_file() {
            let copy = snapshot.join(DATABASE);
            let target = copy
                .to_str()
                .ok_or_else(|| format!("{} is not a valid path.", copy.display()))?;
            open_database(&database)?
                .execute("VACUUM INTO ?1", [target])
                .map_err(|error| format!("Could not copy the database: {error}"))?;
            secure_file(&copy)?;
            sync_file(&copy)?;
            // A copy that cannot be read back is no copy to roll back to.
            schema_version(&copy)?;
        }
        let identities = data.join(IDENTITIES);
        if identities.is_file() {
            let copy = snapshot.join(IDENTITIES);
            fs::copy(&identities, &copy)
                .map_err(|error| format!("Could not copy {IDENTITIES}: {error}"))?;
            secure_file(&copy)?;
            sync_file(&copy)?;
        }
        fs::create_dir_all(&prepared)
            .map_err(|error| format!("Could not create {}: {error}", prepared.display()))?;
        for name in [DATABASE, IDENTITIES] {
            let saved = snapshot.join(name);
            if saved.is_file() {
                let copy = prepared.join(name);
                fs::copy(&saved, &copy)
                    .map_err(|error| format!("Could not prepare {name} for rollback: {error}"))?;
                secure_file(&copy)?;
                sync_file(&copy)?;
            }
        }
        // The new build may migrate the database as soon as it starts, so the
        // folders leading to the copies must be on disk before then too.
        for directory in prepared
            .ancestors()
            .take_while(|directory| directory.starts_with(snapshot) || directory.starts_with(data))
        {
            sync_directory(directory);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(snapshot);
    }
    result
}

/// Whether the failed build raised a format the snapshot was taken at. Only
/// then is the snapshot restored: otherwise the previous build reads the data
/// as it is, including listening progress saved while the new build ran.
fn data_was_upgraded(data: &Path, snapshot: &Path) -> bool {
    // A readable snapshot against current data that is newer or unreadable.
    let raised = |before: Result<i64, String>, after: Result<i64, String>| match (before, after) {
        (Ok(before), Ok(after)) => after > before,
        (Ok(_), Err(_)) => true,
        (Err(_), _) => false,
    };
    let saved_database = snapshot.join(DATABASE);
    let saved_identities = snapshot.join(IDENTITIES);
    (saved_database.is_file()
        && raised(
            schema_version(&saved_database),
            schema_version(&data.join(DATABASE)),
        ))
        || (saved_identities.is_file()
            && raised(
                identity_version(&saved_identities),
                identity_version(&data.join(IDENTITIES)),
            ))
}

/// Puts the whole snapshot back, so the database and identities stay a pair.
/// The snapshot is only read: until the previous build has started it is the
/// one copy that build can open, and a restore that stops partway must be
/// able to run again.
fn restore_data(data: &Path, snapshot: &Path) -> Result<(), String> {
    let names: Vec<&str> = [DATABASE, IDENTITIES]
        .into_iter()
        .filter(|name| snapshot.join(name).is_file())
        .collect();
    let prepared = restore_copies(snapshot);
    // Each file lands with one rename on one volume, so the live file is
    // either the old one or the new one.
    let mut copied = Vec::new();
    let result = (|| {
        let mut sources = Vec::new();
        for name in &names {
            let ready = prepared.join(name);
            if ready.is_file() {
                sources.push(ready);
                continue;
            }
            // No prepared copy left (an earlier restore used it): copy the
            // snapshot beside the live file. Only this needs free space.
            let copy = data.join(format!("{name}.restoring"));
            copied.push(copy.clone());
            fs::copy(snapshot.join(name), &copy)
                .map_err(|error| format!("Could not copy back {name}: {error}"))?;
            secure_file(&copy)?;
            sync_file(&copy)?;
            sources.push(copy);
        }
        for (name, source) in names.iter().zip(&sources) {
            if *name == DATABASE {
                // The failed build's write-ahead log belongs to its database;
                // replayed onto the restored one it would corrupt it.
                remove_if_exists(&data.join(format!("{DATABASE}-wal")))?;
                remove_if_exists(&data.join(format!("{DATABASE}-shm")))?;
            }
            move_required(source, &data.join(name))?;
        }
        Ok(())
    })();
    if result.is_err() {
        for copy in &copied {
            let _ = fs::remove_file(copy);
        }
    }
    sync_directory(data);
    result
}

fn open_database(path: &Path) -> Result<rusqlite::Connection, String> {
    // Without SQLITE_OPEN_CREATE a missing file is an error, not a new empty
    // database; without SQLITE_OPEN_URI the VACUUM INTO target is a plain path.
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn schema_version(database: &Path) -> Result<i64, String> {
    open_database(database)?
        .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
        .map_err(|error| {
            format!(
                "Could not read the schema of {}: {error}",
                database.display()
            )
        })
}

/// The identities `version` the server reads; files without one are format 0.
fn identity_version(path: &Path) -> Result<i64, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    // SQLite's JSON functions spare the launcher a JSON parser.
    rusqlite::Connection::open_in_memory()
        .and_then(|connection| {
            connection.query_row(
                "SELECT coalesce(json_extract(?1, '$.version'), 0)",
                [contents],
                |row| row.get(0),
            )
        })
        .map_err(|error| format!("Could not read the format of {}: {error}", path.display()))
}

fn sync_file(path: &Path) -> Result<(), String> {
    // Windows flushes only handles opened for writing.
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Could not save {}: {error}", path.display()))
}

/// Best effort: makes the renames in `path` survive a power cut.
fn sync_directory(path: &Path) {
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(path) {
        let _ = directory.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn require_ready_start(outcome: StartOutcome) -> Result<(), String> {
    match outcome {
        StartOutcome::Ready => Ok(()),
        StartOutcome::StillStarting => Err(
            "The server did not finish loading its library before the startup timeout.".to_string(),
        ),
    }
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
        copy_launcher(&updater, &install_root.join("operalibre-service"))?;
    }
    Ok(())
}

fn copy_launcher(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{} has no parent folder.", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    // A systemd starter may be running from the old launcher while waiting
    // on update.lock. Replace the inode instead of overwriting its executable.
    let temporary = destination.with_extension("new");
    fs::copy(source, &temporary).map_err(|error| {
        format!(
            "Could not refresh launcher {}: {error}",
            destination.display()
        )
    })?;
    set_executable(&temporary)?;
    fs::rename(&temporary, destination).map_err(|error| error.to_string())
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
    let pid_path = pid_path(root);
    let pid = match fs::read_to_string(&pid_path) {
        Ok(pid) => pid.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {}: {error}", pid_path.display())),
    };

    let pid_number = pid
        .parse::<u32>()
        .map_err(|_| "The saved server process ID is invalid.".to_string())?;
    if !process_is_running(pid_number) {
        let _ = fs::remove_file(pid_path);
        return Ok(());
    }
    if !process_is_operalibre_server(pid_number, root) {
        let _ = fs::remove_file(pid_path);
        return Err(format!(
            "The saved process ID {pid} no longer belongs to this OperaLibre installation. No process was stopped."
        ));
    }

    // The updater may restart the server as soon as the old process and port
    // disappear. Retire the old PID before signalling, so this stop cannot erase
    // the new server's PID file after the updater writes it.
    fs::remove_file(&pid_path)
        .map_err(|error| format!("Could not retire {}: {error}", pid_path.display()))?;
    if let Err(error) = signal_server(pid_number, false)
        && process_is_running(pid_number)
    {
        let _ = fs::write(&pid_path, &pid);
        let _ = secure_file(&pid_path);
        return Err(format!("Could not stop server process {pid}: {error}"));
    }

    // The stop must not return while the server is still shutting down: the
    // installer replaces the files under it as soon as this launcher exits.
    if !wait_for_process_exit(pid_number, SHUTDOWN_CEILING) {
        append_log(
            root,
            &format!(
                "server process {pid} did not stop within {} seconds; killing it",
                SHUTDOWN_CEILING.as_secs()
            ),
        );
        let _ = signal_server(pid_number, true);
        if !wait_for_process_exit(pid_number, Duration::from_secs(5)) {
            if !pid_path.exists() {
                let _ = fs::write(&pid_path, &pid);
                let _ = secure_file(&pid_path);
            }
            return Err(format!(
                "Could not stop server process {pid}; it is still running after being killed."
            ));
        }
    }

    Ok(())
}

fn wait_for_process_exit(pid: u32, ceiling: Duration) -> bool {
    let deadline = Instant::now() + ceiling;
    loop {
        if !process_is_running(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(300));
    }
}

/// Asks the server to stop, or kills it when `force` is set.
///
/// The server is spawned in its own process group so that helpers it runs
/// (ffmpeg, echogarden, Libation) stop with it; the group is signalled first
/// and the single process only if that fails.
#[cfg(unix)]
fn signal_server(pid: u32, force: bool) -> Result<(), String> {
    let signal = if force { "-KILL" } else { "-TERM" };
    let group = Command::new("kill")
        .args([signal, "--", &format!("-{pid}")])
        .stderr(Stdio::null())
        .status();
    if group.is_ok_and(|status| status.success()) {
        return Ok(());
    }
    match Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("the stop command exited with {status}")),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn signal_server(pid: u32, _force: bool) -> Result<(), String> {
    // taskkill /F /T ends the whole process tree; there is no gentler
    // signal for a console-less process on Windows.
    match Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("the stop command exited with {status}")),
        Err(error) => Err(error.to_string()),
    }
}

fn configured_value(config_path: &Path, key: &str) -> Option<String> {
    let contents = fs::read_to_string(config_path).ok()?;
    configured_value_in(&contents, key)
}

/// The variable and header the server reads for an update trial.
const UPDATE_TRIAL_ENV: &str = "OPERALIBRE_UPDATE_TRIAL";
const UPDATE_TRIAL_HEADER: &str = "X-OperaLibre-Update-Trial";

fn server_port(root: &Path) -> Result<u16, String> {
    let config = env::var_os("OPERALIBRE_SERVER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("server.config"));
    let contents = match fs::read_to_string(&config) {
        Ok(contents) => contents,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && env::var_os("OPERALIBRE_SERVER_CONFIG").is_none() =>
        {
            String::new()
        }
        Err(error) => return Err(format!("Could not read {}: {error}", config.display())),
    };
    Ok(port_from(
        configured_value_in(&contents, "port"),
        env::var("PORT").ok(),
    )?
    .unwrap_or(4920))
}

fn update_deployment(
    arguments: &[std::ffi::OsString],
    root: &Path,
) -> Result<DeploymentConfig, String> {
    if let Some(config) = optional_named_update_argument(arguments, "--server-config") {
        return Ok(DeploymentConfig {
            config_path: (config != "none").then(|| PathBuf::from(config)),
            data_dir: PathBuf::from(named_update_argument(arguments, "--server-data-dir")?),
            port: named_update_argument(arguments, "--server-port")?
                .to_string_lossy()
                .parse()
                .map_err(|_| "The resolved server port is invalid.".to_string())?,
        });
    }
    // Compatibility with servers that predate the explicit deployment arguments.
    // These used only the installation config and the legacy launcher data rule.
    if ["--server-data-dir", "--server-port"]
        .iter()
        .any(|name| optional_named_update_argument(arguments, name).is_some())
    {
        return Err("The resolved server deployment arguments are incomplete.".to_string());
    }
    if !data_dir(root).is_dir() || !root.join("server.config").is_file() {
        return Err("The target is not a managed OperaLibre installation.".to_string());
    }
    Ok(DeploymentConfig {
        config_path: Some(root.join("server.config")),
        data_dir: data_dir(root),
        port: port_from(
            configured_value(&root.join("server.config"), "port"),
            env::var("PORT").ok(),
        )
        .ok()
        .flatten()
        .unwrap_or(4920),
    })
}

fn port_from(
    configured: Option<String>,
    environment: Option<String>,
) -> Result<Option<u16>, String> {
    let Some(value) = [configured, environment]
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    value
        .parse()
        .map(Some)
        .map_err(|error| format!("Invalid server port `{value}`: {error}"))
}

fn configured_value_in(contents: &str, key: &str) -> Option<String> {
    let wanted = key.to_ascii_lowercase().replace('-', "_");
    contents
        .lines()
        // Searched from the end: the server keeps a repeated key's last value.
        .rev()
        .find_map(|raw_line| {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (candidate, value) = line.split_once('=')?;
            (candidate.trim().to_ascii_lowercase().replace('-', "_") == wanted)
                .then(|| unquote_config_value(value.trim()))
        })
}

/// One matching pair of surrounding quotes, as the server's
/// `unquote_config_value` strips.
fn unquote_config_value(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == bytes[bytes.len() - 1]
        && (bytes[0] == b'"' || bytes[0] == b'\'')
    {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}

/// Unguessable, so no other local process or web page can commit a trial.
fn update_trial_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not create the update token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug, PartialEq, Eq)]
enum TrialCommit {
    Committed,
    /// The build predates update trials: it never refused requests.
    Unsupported,
}

/// Commits the trial so the new build starts accepting changes. Anything but
/// a clear answer counts as a failed start and rolls the update back; the
/// build may then have been committed and accepted a change in the moment
/// before it went away, which the rollback discards.
fn commit_update_trial(port: u16, token: &str) -> Result<TrialCommit, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|error| format!("Could not reach the new server to commit it: {error}"))?;
    // The commit restores the read-along queue first, which reads one file.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let request = format!(
        "POST /api/update-trial/commit HTTP/1.1\r\nHost: localhost\r\n{UPDATE_TRIAL_HEADER}: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not commit the new server: {error}"))?;
    let mut response = Vec::with_capacity(512);
    let _ = stream.take(16 * 1024).read_to_end(&mut response);
    parse_commit_response(&response)
}

fn parse_commit_response(response: &[u8]) -> Result<TrialCommit, String> {
    let response = String::from_utf8_lossy(response);
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    match status {
        "204" => Ok(TrialCommit::Committed),
        "404" => Ok(TrialCommit::Unsupported),
        "" => Err("The new server closed the connection before committing.".to_string()),
        status => Err(format!("The new server refused the commit ({status}).")),
    }
}

fn server_readiness(port: u16) -> ServerReadiness {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return ServerReadiness::Absent;
    };
    let request = b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return ServerReadiness::Starting;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if response.len() >= 16 * 1024 {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                break;
            }
            Err(_) => return ServerReadiness::Starting,
        }
    }
    parse_health_response(&response)
}

fn parse_health_response(response: &[u8]) -> ServerReadiness {
    let response = String::from_utf8_lossy(response);
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return ServerReadiness::Starting;
    };
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return ServerReadiness::Starting;
    }
    let compact_body: String = body
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact_body.contains("\"catalogueError\":true") {
        ServerReadiness::Unavailable
    } else if compact_body.contains("\"ready\":true") || !compact_body.contains("\"ready\":") {
        // Servers from before catalogue readiness was exposed are already
        // fully started by the time their health route answers.
        ServerReadiness::Ready
    } else {
        ServerReadiness::Starting
    }
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

fn show_message(message: &str) {
    #[cfg(target_os = "windows")]
    {
        // The message carries install paths and OS errors; pass it as data so
        // no quoting rule (PowerShell also treats curly quotes as quotes) applies.
        let script = "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:OPERALIBRE_MESSAGE, 'OperaLibre')";
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
            .env("OPERALIBRE_MESSAGE", message)
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
    #[test]
    fn server_only_staging_leaves_web_and_absent_version_alone() {
        let root = std::env::temp_dir().join(format!(
            "operalibre-server-only-staging-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let install = root.join("install");
        let backup = root.join("backup");
        std::fs::create_dir_all(install.join("web")).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(install.join(super::server_binary_name()), "old server").unwrap();
        std::fs::write(install.join("web/index.html"), "keep web").unwrap();

        super::stage_installed_files(&install, &backup, false).unwrap();
        assert!(!install.join(super::server_binary_name()).exists());
        assert_eq!(
            std::fs::read_to_string(backup.join(super::server_binary_name())).unwrap(),
            "old server"
        );
        assert_eq!(
            std::fs::read_to_string(install.join("web/index.html")).unwrap(),
            "keep web"
        );
        assert!(!backup.join("VERSION.txt").exists());
        assert!(backup.join(super::NO_VERSION_MARKER).is_file());
        assert!(!backup.join("web").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failing_to_record_a_missing_version_moves_nothing() {
        let root = scratch("staging-no-version-marker");
        let install = root.join("install");
        let backup = root.join("backup");
        std::fs::create_dir_all(install.join("web")).unwrap();
        std::fs::write(install.join(super::server_binary_name()), "old server").unwrap();
        // The marker cannot be written where a folder already sits.
        std::fs::create_dir_all(backup.join(super::NO_VERSION_MARKER)).unwrap();

        assert!(super::stage_installed_files(&install, &backup, true).is_err());
        assert_eq!(
            std::fs::read_to_string(install.join(super::server_binary_name())).unwrap(),
            "old server"
        );
        assert!(install.join("web").is_dir());
        assert!(!backup.join(super::server_binary_name()).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_update_staging_restores_only_files_already_moved() {
        for failed_name in ["web", "VERSION.txt"] {
            let root = std::env::temp_dir().join(format!(
                "operalibre-staging-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let install = root.join("install");
            let backup = root.join("backup");
            std::fs::create_dir_all(install.join("web")).unwrap();
            std::fs::create_dir_all(backup.join(failed_name)).unwrap();
            std::fs::write(backup.join(failed_name).join("occupied"), "keep").unwrap();
            std::fs::write(install.join(super::server_binary_name()), "old server").unwrap();
            std::fs::write(install.join("web/index.html"), "old web").unwrap();
            std::fs::write(install.join("VERSION.txt"), "old version").unwrap();

            assert!(super::stage_installed_files(&install, &backup, true).is_err());
            assert_eq!(
                std::fs::read_to_string(install.join(super::server_binary_name())).unwrap(),
                "old server"
            );
            assert_eq!(
                std::fs::read_to_string(install.join("web/index.html")).unwrap(),
                "old web"
            );
            assert_eq!(
                std::fs::read_to_string(install.join("VERSION.txt")).unwrap(),
                "old version"
            );
            assert_eq!(
                std::fs::read_to_string(backup.join(failed_name).join("occupied")).unwrap(),
                "keep"
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn completion_is_published_while_handoff_is_still_locked() {
        let root = std::env::temp_dir().join(format!(
            "operalibre-handoff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("server.config"), "data_dir = state\n").unwrap();
        std::fs::write(root.join("VERSION.txt"), "0.3.7\n").unwrap();
        let lock = super::update_lock(&root, &super::data_dir(&root)).unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("state/update.lock"))
            .unwrap();
        assert!(contender.try_lock().is_err());
        assert!(!root.join("state/update-result.txt").exists());
        super::publish_update_result(&root, &super::data_dir(&root), &Ok(())).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("state/update-result.txt")).unwrap(),
            "Succeeded: 0.3.7\n"
        );
        assert!(contender.try_lock().is_err());
        super::publish_update_result(
            &root,
            &super::data_dir(&root),
            &Err("restored previous version".into()),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("state/update-result.txt")).unwrap(),
            "Failed: restored previous version\n"
        );
        // Other tests spawn processes; a concurrent fork can briefly retain
        // the descriptor even after this process drops it.
        assert_eq!(lock.len(), 1);
        for file in &lock {
            file.unlock().unwrap();
        }
        drop(lock);
        contender.try_lock().unwrap();
        drop(contender);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_a_launcher_preserves_an_open_old_inode() {
        let root = std::env::temp_dir().join(format!(
            "operalibre-launcher-copy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let destination = root.join("launcher");
        std::fs::write(&source, "new launcher").unwrap();
        std::fs::write(&destination, "old launcher").unwrap();
        let mut old = std::fs::File::open(&destination).unwrap();
        super::copy_launcher(&source, &destination).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut old, &mut text).unwrap();
        assert_eq!(text, "old launcher");
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "new launcher"
        );
        drop(old);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "operalibre-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// A data folder shaped like the server's: a WAL database at `schema` with
    /// one progress row, and identities at `identities`.
    fn seed_data(data: &Path, schema: i64, identities: &str) -> rusqlite::Connection {
        fs::create_dir_all(data).unwrap();
        let connection = rusqlite::Connection::open(data.join("operalibre.db")).unwrap();
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version VALUES ({schema});
                 CREATE TABLE progress (book TEXT PRIMARY KEY, seconds REAL NOT NULL);
                 INSERT INTO progress VALUES ('before-update', 120);"
            ))
            .unwrap();
        fs::write(data.join("library-identities.json"), identities).unwrap();
        connection
    }

    fn progress_books(data: &Path) -> Vec<String> {
        let connection = rusqlite::Connection::open(data.join("operalibre.db")).unwrap();
        let mut statement = connection
            .prepare("SELECT book FROM progress ORDER BY book")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn rollback_restores_data_a_failed_build_upgraded() {
        let root = scratch("data-upgraded");
        let data = root.join("data");
        let snapshot = root.join("snapshot");
        // Held open so the snapshot is taken with a live write-ahead log.
        let live = seed_data(&data, 4, "{\"version\":1,\"books\":[]}");
        live.execute_batch(
            "PRAGMA wal_autocheckpoint = 0; INSERT INTO progress VALUES ('in-wal', 30);",
        )
        .unwrap();
        super::snapshot_data(&data, &snapshot).unwrap();
        live.execute_batch(
            "UPDATE schema_version SET version = 5; INSERT INTO progress VALUES ('new-build', 60);",
        )
        .unwrap();
        drop(live);
        fs::write(data.join("library-identities.json"), "{\"version\":2}").unwrap();

        assert!(super::data_was_upgraded(&data, &snapshot));
        super::restore_data(&data, &snapshot).unwrap();
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert_eq!(progress_books(&data), ["before-update", "in-wal"]);
        assert_eq!(
            fs::read_to_string(data.join("library-identities.json")).unwrap(),
            "{\"version\":1,\"books\":[]}"
        );
        assert!(!super::data_was_upgraded(&data, &snapshot));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_restore_that_stops_partway_keeps_the_snapshot_for_another_try() {
        let root = scratch("data-partial-restore");
        let data = root.join("data");
        let snapshot = root.join("snapshot");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &snapshot).unwrap();
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();
        // The database goes back, then the identities cannot be replaced.
        let identities = data.join("library-identities.json");
        fs::remove_file(&identities).unwrap();
        fs::create_dir_all(identities.join("blocked")).unwrap();
        assert!(super::restore_data(&data, &snapshot).is_err());
        assert_eq!(
            super::schema_version(&snapshot.join("operalibre.db")),
            Ok(4)
        );
        assert_eq!(
            fs::read_to_string(snapshot.join("library-identities.json")).unwrap(),
            "{\"version\":1}"
        );
        assert!(!data.join("library-identities.json.restoring").exists());
        assert!(
            super::restore_copies(&snapshot)
                .join("library-identities.json")
                .is_file()
        );

        // Restarting the failed build would migrate the restored database again.
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();
        fs::remove_dir_all(&identities).unwrap();
        fs::write(&identities, "{\"version\":2}").unwrap();
        assert!(super::data_was_upgraded(&data, &snapshot));
        super::restore_data(&data, &snapshot).unwrap();
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert_eq!(super::identity_version(&identities), Ok(1));
        assert_eq!(progress_books(&data), ["before-update"]);
        assert!(snapshot.join("operalibre.db").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    /// Rollback can run on a disk the failed build filled. What it records
    /// is prepared before the new build runs, and failing to record it never
    /// stops the snapshot going back.
    #[test]
    fn the_data_goes_back_even_when_nothing_else_can_be_recorded() {
        let root = scratch("data-rollback-records");
        let data = root.join("data");
        let backup = root.join("backup");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &backup.join("data")).unwrap();
        super::prepare_rollback_records(&backup).unwrap();
        assert!(backup.join(super::FAILED_DATA_PARTIAL).is_dir());
        assert!(backup.join(super::RESTORE_PENDING).is_file());
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();

        // Neither the marker nor the kept folder can land.
        fs::remove_file(backup.join(super::RESTORE_PENDING)).unwrap();
        fs::create_dir_all(backup.join(super::RESTORE_REQUIRED).join("blocked")).unwrap();
        fs::write(backup.join(super::FAILED_DATA), b"blocked").unwrap();
        super::roll_back_data(&root, &data, &backup).unwrap();
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        fs::remove_dir_all(root).unwrap();
    }

    /// A rollback run again, after the previous build failed to start on the
    /// restored data, must not top up what was kept with the restored files.
    #[test]
    fn a_second_rollback_never_mixes_restored_files_into_the_kept_data() {
        let root = scratch("data-rollback-twice");
        let data = root.join("data");
        let backup = root.join("backup");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &backup.join("data")).unwrap();
        super::prepare_rollback_records(&backup).unwrap();
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();
        fs::write(data.join("library-identities.json"), "{\"version\":2}").unwrap();
        // Keeping the failed data cannot finish.
        let partial = backup.join(super::FAILED_DATA_PARTIAL);
        fs::write(backup.join(super::FAILED_DATA), b"blocked").unwrap();
        super::roll_back_data(&root, &data, &backup).unwrap();
        assert_eq!(
            super::identity_version(&data.join("library-identities.json")),
            Ok(1)
        );
        assert!(backup.join(super::RESTORE_REQUIRED).is_file());

        // The previous build starts, writes a log, and fails readiness.
        fs::write(data.join("operalibre.db-wal"), b"previous build wal").unwrap();
        fs::remove_file(backup.join(super::FAILED_DATA)).unwrap();
        super::roll_back_data(&root, &data, &backup).unwrap();
        assert_eq!(
            super::identity_version(&partial.join("library-identities.json")),
            Ok(2)
        );
        assert!(!partial.join("operalibre.db-wal").exists());
        assert!(!backup.join(super::FAILED_DATA).exists());
        assert_eq!(super::schema_version(&partial.join("operalibre.db")), Ok(5));
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert!(!data.join("operalibre.db-wal").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_rollback_records_its_restore_with_a_rename() {
        let root = scratch("data-rollback-marker");
        let data = root.join("data");
        let backup = root.join("backup");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &backup.join("data")).unwrap();
        super::prepare_rollback_records(&backup).unwrap();
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();

        super::roll_back_data(&root, &data, &backup).unwrap();
        assert!(backup.join(super::RESTORE_REQUIRED).is_file());
        assert!(!backup.join(super::RESTORE_PENDING).exists());
        assert!(
            backup
                .join(super::FAILED_DATA)
                .join("operalibre.db")
                .is_file()
        );
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_failed_builds_data_is_kept_before_the_snapshot_goes_back() {
        let root = scratch("data-failed-kept");
        let data = root.join("data");
        let backup = root.join("backup");
        let snapshot = backup.join("data");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &snapshot).unwrap();
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute_batch(
                "UPDATE schema_version SET version = 5; INSERT INTO progress VALUES ('new-build', 60);",
            )
            .unwrap();
        fs::write(data.join("library-identities.json"), "{\"version\":2}").unwrap();
        // Left behind by a build that stopped without checkpointing.
        fs::write(data.join("operalibre.db-wal"), b"failed build wal").unwrap();
        fs::write(data.join("operalibre.db-shm"), b"failed build shm").unwrap();

        let kept = super::preserve_failed_data(&data, &backup).unwrap();
        assert_eq!(kept, backup.join("failed-data"));
        assert!(!backup.join("failed-data.partial").exists());
        // Its log and shared memory moved with it, so nothing is replayed onto
        // the restored database.
        assert!(!data.join("operalibre.db-wal").exists());
        assert!(!data.join("operalibre.db-shm").exists());
        assert_eq!(
            fs::read(kept.join("operalibre.db-wal")).unwrap(),
            b"failed build wal"
        );
        super::restore_data(&data, &snapshot).unwrap();

        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert_eq!(progress_books(&data), ["before-update"]);
        fs::remove_file(kept.join("operalibre.db-wal")).unwrap();
        fs::remove_file(kept.join("operalibre.db-shm")).unwrap();
        assert_eq!(super::schema_version(&kept.join("operalibre.db")), Ok(5));
        assert_eq!(progress_books(&kept), ["before-update", "new-build"]);
        assert_eq!(
            super::identity_version(&kept.join("library-identities.json")),
            Ok(2)
        );
        // A second run finds it kept and leaves it alone.
        assert_eq!(super::preserve_failed_data(&data, &backup).unwrap(), kept);
        assert_eq!(super::schema_version(&kept.join("operalibre.db")), Ok(5));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeping_the_failed_data_resumes_after_an_interruption() {
        let root = scratch("data-failed-resume");
        let data = root.join("data");
        let backup = root.join("backup");
        drop(seed_data(&data, 5, "{\"version\":2}"));
        fs::write(data.join("operalibre.db-wal"), b"failed build wal").unwrap();
        // Stopped after the database was kept and before the log moved.
        let partial = backup.join("failed-data.partial");
        fs::create_dir_all(&partial).unwrap();
        fs::hard_link(data.join("operalibre.db"), partial.join("operalibre.db")).unwrap();

        let kept = super::preserve_failed_data(&data, &backup).unwrap();
        assert!(!partial.exists());
        assert_eq!(
            fs::read(kept.join("operalibre.db-wal")).unwrap(),
            b"failed build wal"
        );
        fs::remove_file(kept.join("operalibre.db-wal")).unwrap();
        assert_eq!(super::schema_version(&kept.join("operalibre.db")), Ok(5));
        assert!(kept.join("library-identities.json").is_file());
        // The live files the restore replaces are still there.
        assert!(data.join("operalibre.db").is_file());
        assert!(data.join("library-identities.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn putting_back_a_backup_twice_keeps_what_the_first_run_restored() {
        let root = scratch("restore-backed-up");
        fs::create_dir_all(&root).unwrap();
        let backup = root.join("backup-server");
        let installed = root.join("server");
        fs::write(&backup, "previous build").unwrap();
        fs::write(&installed, "failed build").unwrap();

        super::restore_backed_up(&backup, &installed).unwrap();
        assert_eq!(fs::read_to_string(&installed).unwrap(), "previous build");
        // The previous build failed to start and the rollback runs again.
        super::restore_backed_up(&backup, &installed).unwrap();
        assert_eq!(fs::read_to_string(&installed).unwrap(), "previous build");
        fs::remove_file(&installed).unwrap();
        assert!(super::restore_backed_up(&backup, &installed).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_a_clear_commit_answer_counts() {
        use super::{TrialCommit, parse_commit_response};
        assert_eq!(
            parse_commit_response(b"HTTP/1.1 204 No Content\r\n\r\n"),
            Ok(TrialCommit::Committed)
        );
        assert_eq!(
            parse_commit_response(b"HTTP/1.1 404 Not Found\r\n\r\n{}"),
            Ok(TrialCommit::Unsupported)
        );
        assert!(parse_commit_response(b"HTTP/1.1 403 Forbidden\r\n\r\n").is_err());
        assert!(parse_commit_response(b"HTTP/1.1 500 Internal Server Error\r\n\r\n").is_err());
        assert!(parse_commit_response(b"").is_err());
    }

    #[test]
    fn update_trial_tokens_are_long_and_fresh() {
        let first = super::update_trial_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, super::update_trial_token().unwrap());
    }

    #[test]
    fn rollback_restores_from_copies_prepared_before_the_swap() {
        let root = scratch("data-prepared-restore");
        let data = root.join("data");
        let snapshot = root.join("snapshot");
        drop(seed_data(&data, 4, "{\"version\":1}"));
        super::snapshot_data(&data, &snapshot).unwrap();
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();
        fs::write(data.join("library-identities.json"), "{\"version\":2}").unwrap();
        // Rollback-time copies fail, as they would on a disk the failed build
        // filled; the prepared copies need only renames.
        for name in ["operalibre.db", "library-identities.json"] {
            fs::create_dir_all(data.join(format!("{name}.restoring")).join("blocked")).unwrap();
        }
        super::restore_data(&data, &snapshot).unwrap();
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert_eq!(
            super::identity_version(&data.join("library-identities.json")),
            Ok(1)
        );
        assert_eq!(progress_books(&data), ["before-update"]);

        // Once used, a later restore copies from the snapshot, which is whole.
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("UPDATE schema_version SET version = 5", [])
            .unwrap();
        assert!(super::restore_data(&data, &snapshot).is_err());
        for name in ["operalibre.db", "library-identities.json"] {
            fs::remove_dir_all(data.join(format!("{name}.restoring"))).unwrap();
        }
        super::restore_data(&data, &snapshot).unwrap();
        assert_eq!(super::schema_version(&data.join("operalibre.db")), Ok(4));
        assert!(!data.join("operalibre.db.restoring").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failure_preparing_restore_copies_stops_the_update_before_the_swap() {
        let install = scratch("data-prepare-failure");
        let backup = install.join("data/update-backups/1");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("server.config"), "data_dir = data\n").unwrap();
        fs::write(install.join(super::server_binary_name()), "old server").unwrap();
        fs::write(install.join("VERSION.txt"), "old version").unwrap();
        drop(seed_data(&install.join("data"), 4, "{\"version\":1}"));
        // The snapshot can be written but its restore copies cannot.
        fs::create_dir_all(backup.join("data")).unwrap();
        fs::write(super::restore_copies(&backup.join("data")), "occupied").unwrap();

        assert!(
            super::prepare_update(&install, &super::data_dir(&install), &backup, false).is_err()
        );
        assert_eq!(
            fs::read_to_string(install.join(super::server_binary_name())).unwrap(),
            "old server"
        );
        assert_eq!(
            fs::read_to_string(install.join("VERSION.txt")).unwrap(),
            "old version"
        );
        assert!(!backup.join(super::server_binary_name()).exists());
        assert!(!backup.join("data").exists());
        assert_eq!(
            super::schema_version(&install.join("data/operalibre.db")),
            Ok(4)
        );
        fs::remove_dir_all(install).unwrap();
    }

    #[test]
    fn rollback_keeps_data_the_previous_build_still_reads() {
        let root = scratch("data-compatible");
        let data = root.join("data");
        let snapshot = root.join("snapshot");
        drop(seed_data(&data, 4, "{\"books\":[]}"));
        super::snapshot_data(&data, &snapshot).unwrap();
        // Progress saved while the new build was up must survive the rollback.
        rusqlite::Connection::open(data.join("operalibre.db"))
            .unwrap()
            .execute("INSERT INTO progress VALUES ('new-build', 60)", [])
            .unwrap();
        assert!(!super::data_was_upgraded(&data, &snapshot));

        // Pre-versioned identities rewritten in the versioned format count as
        // an upgrade, and so does a database the launcher cannot read.
        fs::write(data.join("library-identities.json"), "{\"version\":1}").unwrap();
        assert!(super::data_was_upgraded(&data, &snapshot));
        fs::write(data.join("library-identities.json"), "{\"books\":[]}").unwrap();
        fs::write(data.join("operalibre.db"), "not a database").unwrap();
        assert!(super::data_was_upgraded(&data, &snapshot));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_snapshot_leaves_nothing_to_roll_back_to() {
        let root = scratch("data-snapshot-failure");
        let data = root.join("data");
        let snapshot = root.join("snapshot");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("library-identities.json"), "{}").unwrap();
        fs::write(data.join("operalibre.db"), "not a database").unwrap();
        assert!(super::snapshot_data(&data, &snapshot).is_err());
        assert!(!snapshot.exists());
        assert!(!super::data_was_upgraded(&data, &snapshot));

        // An installation that has no database yet still snapshots.
        fs::remove_file(data.join("operalibre.db")).unwrap();
        super::snapshot_data(&data, &snapshot).unwrap();
        assert!(!data.join("operalibre.db").exists());
        fs::remove_dir_all(root).unwrap();
    }

    use super::{
        ServerReadiness, data_dir, named_update_argument, optional_named_update_argument,
        parse_health_response, process_command_matches,
    };
    use super::{configured_value_in, port_from};
    use std::{env, ffi::OsString, fs, path::Path};

    #[test]
    fn explicit_deployment_owns_update_state_and_holds_both_locks() {
        let root = scratch("explicit-deployment");
        let install = root.join("install");
        let selected = root.join("server-data");
        fs::create_dir_all(install.join("data")).unwrap();
        fs::create_dir_all(&selected).unwrap();
        fs::write(
            install.join("server.config"),
            "data_dir = data\nport = 4101\n",
        )
        .unwrap();
        let config = root.join("server.config");
        // The updater must not select data or port by parsing this file again.
        fs::write(&config, "data_dir = different\nport = 4102\n").unwrap();
        let arguments: Vec<OsString> = vec![
            "--server-config".into(),
            config.clone().into_os_string(),
            "--server-data-dir".into(),
            selected.clone().into_os_string(),
            "--server-port".into(),
            "4103".into(),
        ];
        let deployment = super::update_deployment(&arguments, &install).unwrap();
        deployment.validate_update().unwrap();
        assert_eq!(deployment.data_dir, selected);
        assert_eq!(deployment.port, 4103);
        assert_eq!(deployment.config_path, Some(config.clone()));
        let locks = super::update_lock(&install, &deployment.data_dir).unwrap();
        assert_eq!(locks.len(), 2);
        let contenders: Vec<_> = [
            selected.join("update.lock"),
            install.join("data/update.lock"),
        ]
        .iter()
        .map(|path| {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap()
        })
        .collect();
        for file in &contenders {
            assert!(file.try_lock().is_err());
        }
        super::publish_update_result(&install, &deployment.data_dir, &Ok(())).unwrap();
        assert!(selected.join("update-result.txt").is_file());
        assert!(!install.join("data/update-result.txt").exists());
        drop(locks);
        for file in contenders {
            file.try_lock().unwrap();
        }
        fs::remove_file(config).unwrap();
        assert!(deployment.validate_update().is_err());
        let mut arguments = arguments;
        arguments[1] = "none".into();
        let deployment = super::update_deployment(&arguments, &install).unwrap();
        deployment.validate_update().unwrap();
        assert!(deployment.config_path.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_deployment_and_default_lock_paths_stay_in_the_installation() {
        let root = scratch("legacy-deployment");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("server.config"), "data_dir = data\nport = 4101\n").unwrap();
        let deployment = super::update_deployment(&[], &root).unwrap();
        assert_eq!(deployment.data_dir, root.join("data"));
        assert_eq!(deployment.config_path, Some(root.join("server.config")));
        assert_eq!(deployment.port, 4101);
        let locks = super::update_lock(&root, &deployment.data_dir).unwrap();
        assert_eq!(locks.len(), 1);
        assert_eq!(
            super::pid_path(&root),
            root.join("data/operalibre-server.pid")
        );
        assert_eq!(super::server_log_path(&root), root.join("data/server.log"));
        super::publish_update_result(&root, &deployment.data_dir, &Ok(())).unwrap();
        assert!(root.join("data/update-result.txt").is_file());
        drop(locks);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_values_match_the_servers_key_rules() {
        let contents = "# comment\nPort = \"4123\"\nData-Dir = 'state'\nlibrary_root = books\n";
        assert_eq!(
            configured_value_in(contents, "port").as_deref(),
            Some("4123")
        );
        assert_eq!(
            configured_value_in(contents, "data_dir").as_deref(),
            Some("state")
        );
        assert_eq!(configured_value_in(contents, "web_dist_dir"), None);
    }

    #[test]
    fn a_repeated_key_takes_its_last_value_like_the_server() {
        let contents = "port = 4920\n# port = 1\nPORT = 48917\n";
        assert_eq!(
            configured_value_in(contents, "port").as_deref(),
            Some("48917")
        );
        assert_eq!(
            configured_value_in("web_dist_dir = web\nweb-dist-dir =\n", "web_dist_dir").as_deref(),
            Some("")
        );
    }

    #[test]
    fn a_blank_port_falls_back_to_the_port_variable_like_the_server() {
        let last_blank = configured_value_in("port = 4000\nport =\n", "port");
        assert_eq!(
            port_from(last_blank.clone(), Some("4000".into())).unwrap(),
            Some(4000)
        );
        assert_eq!(port_from(last_blank, None).unwrap(), None);
        assert_eq!(
            port_from(Some("48917".into()), Some("4000".into())).unwrap(),
            Some(48917)
        );
        assert_eq!(port_from(None, Some(" 4100 ".into())).unwrap(), Some(4100));
        assert_eq!(port_from(None, Some(" ".into())).unwrap(), None);
    }

    #[test]
    fn only_one_matching_pair_of_quotes_is_stripped_like_the_server() {
        for (value, expected) in [
            ("\"state\"", "state"),
            ("'state'", "state"),
            ("\"state'", "\"state'"),
            ("\"\"state\"\"", "\"state\""),
            ("\"", "\""),
        ] {
            assert_eq!(
                configured_value_in(&format!("data_dir = {value}\n"), "data_dir").as_deref(),
                Some(expected),
                "{value}"
            );
        }
    }

    #[test]
    fn data_dir_follows_server_config() {
        let root = env::temp_dir().join(format!("operalibre-launcher-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let config = root.join("server.config");

        assert_eq!(data_dir(&root), root.join("data"));

        fs::write(&config, "port = 4000\ndata_dir = state/live\n").unwrap();
        assert_eq!(data_dir(&root), root.join("state/live"));

        let absolute = root.join("elsewhere");
        fs::write(&config, format!("data_dir = {}\n", absolute.display())).unwrap();
        assert_eq!(data_dir(&root), absolute);

        fs::write(&config, "data_dir =\n").unwrap();
        assert_eq!(data_dir(&root), root.join("data"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_layout_argument_is_optional() {
        let arguments = [
            OsString::from("operalibre-updater"),
            OsString::from("--apply-update"),
            OsString::from("/tmp/update"),
        ];
        assert_eq!(optional_named_update_argument(&arguments, "--layout"), None);
    }

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

    #[test]
    fn process_verification_requires_the_exact_server_executable() {
        let expected = Path::new("/Applications/Opera Libre/operalibre-server");
        assert!(process_command_matches(
            "/Applications/Opera Libre/operalibre-server",
            expected
        ));
        assert!(process_command_matches(
            "/Applications/Opera Libre/operalibre-server --config server.config",
            expected
        ));
        assert!(!process_command_matches(
            "/Applications/Opera Libre/operalibre-server-helper",
            expected
        ));
        assert!(!process_command_matches(
            "/usr/bin/python server.py",
            expected
        ));
    }

    #[test]
    fn health_response_requires_a_published_catalogue() {
        assert_eq!(
            parse_health_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: 62\r\n\r\n{\"ok\":true,\"scanning\":true,\"ready\":false,\"catalogueError\":false}"
            ),
            ServerReadiness::Starting
        );
        assert_eq!(
            parse_health_response(
                b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"scanning\":false,\"ready\":false,\"catalogueError\":true}"
            ),
            ServerReadiness::Unavailable
        );
        assert_eq!(
            parse_health_response(
                b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"scanning\":false,\"ready\":true,\"catalogueError\":false}"
            ),
            ServerReadiness::Ready
        );
    }

    #[test]
    fn health_response_remains_compatible_with_older_servers() {
        assert_eq!(
            parse_health_response(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"scanning\":false}"),
            ServerReadiness::Ready
        );
    }
}
