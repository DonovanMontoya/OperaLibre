//! Storage guard for Libation's external writer. Callers hold the Libation job lock.

use crate::{AppState, LibationConfig, normalize_asin};
use anyhow::{Context, ensure};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

// Leave room for writes between observations. This is a watchdog, not an OS quota.
const WRITE_HEADROOM: u64 = 64 * 1024 * 1024;

pub(crate) fn sweep_staging(root: &Path) -> std::io::Result<usize> {
    let mut removed = 0;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with(".operalibre-libation-")
        {
            std::fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub(crate) async fn download_title(
    state: &AppState,
    config: &LibationConfig,
    asin: &str,
) -> anyhow::Result<std::process::Output> {
    if crate::find_book_id_by_asin(&state.library.read().await.books, asin).is_some() {
        return Ok(already_imported());
    }
    download_with_budget(
        config,
        asin,
        Budget {
            limit: state.max_upload_bytes,
            reserve: state.min_download_free_bytes,
            available_space: |path| fs2::available_space(path),
        },
    )
    .await
}

fn already_imported() -> std::process::Output {
    std::process::Output {
        status: std::process::ExitStatus::default(),
        stdout: b"Audible title is already imported.\n".to_vec(),
        stderr: Vec::new(),
    }
}

#[derive(Clone, Copy)]
struct Budget {
    limit: Option<u64>,
    reserve: u64,
    available_space: fn(&Path) -> std::io::Result<u64>,
}

async fn download_with_budget(
    config: &LibationConfig,
    asin: &str,
    budget: Budget,
) -> anyhow::Result<std::process::Output> {
    let asin = normalize_asin(asin).context("Invalid Audible ASIN")?;
    let destination = config.library_root.join(format!("Audible [{asin}]"));
    // A completed import is never overwritten or duplicated by a repeated request.
    if destination.try_exists()? {
        let existing = crate::walk_audio_files_checked(&destination);
        ensure!(
            existing.errors.is_empty(),
            "Could not inspect previous Audible import"
        );
        if !existing.files.is_empty() {
            return Ok(already_imported());
        }
    }
    let staging = tempfile::Builder::new()
        .prefix(".operalibre-libation-")
        .tempdir_in(&config.library_root)?;
    let books = staging.path().join("books");
    let temporary = staging.path().join("temporary");
    std::fs::create_dir(&books)?;
    std::fs::create_dir(&temporary)?;
    check_budget(staging.path(), budget)?;
    // A previous attempt can mark the Libation record downloaded before our
    // final budget check rejects it. Local presence, not that flag, decides reuse.
    let mut args = vec![
        "liberate".to_string(),
        "--force".to_string(),
        "--id".to_string(),
        asin,
    ];
    args.extend([
        "--override".to_string(),
        format!("InProgress={}", temporary.display()),
        "--override".to_string(),
        format!("Books={}", books.display()),
    ]);
    let mut command = Command::new(
        config
            .cli_path
            .as_ref()
            .context("Libation CLI is not configured")?,
    );
    command
        .args(config.command_args(args))
        .env("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT", "0")
        // .NET otherwise creates diagnostic sockets and pipes in TMPDIR,
        // which the staging guard correctly rejects as special files.
        .env("DOTNET_EnableDiagnostics", "0")
        .env("TMPDIR", &temporary)
        .env("TMP", &temporary)
        .env("TEMP", &temporary)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    #[cfg(unix)]
    let process_group = ProcessGroup(child.id().context("Missing Libation process ID")?);
    #[cfg(windows)]
    let process_group = match ProcessGroup::new(&child) {
        Ok(group) => group,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let mut stdout = child.stdout.take().context("Missing Libation stdout")?;
    let mut stderr = child.stderr.take().context("Missing Libation stderr")?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let result = {
        let completion = async {
            tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err),)?;
            Ok::<_, anyhow::Error>(child.wait().await?)
        };
        tokio::select! {
            result = completion => result,
            result = monitor_budget(staging.path(), budget) => result,
        }
    };
    #[cfg(any(unix, windows))]
    drop(process_group);
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            // Reap the writer before removing its partial files.
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    if status.success() {
        check_budget(staging.path(), budget)?;
        let audio = crate::walk_audio_files_checked(&books);
        ensure!(audio.errors.is_empty(), "Could not inspect Libation output");
        if !audio.files.is_empty() {
            // Both paths are on the library volume. The scanner sees the whole
            // title only after this rename, including chapter files and sidecars.
            std::fs::create_dir_all(&destination)?;
            let import_name = staging
                .path()
                .file_name()
                .context("Missing staging directory name")?
                .to_string_lossy()
                .replace(".operalibre-libation-", "import-");
            std::fs::rename(&books, destination.join(import_name))?;
        }
    }
    Ok(std::process::Output {
        status,
        stdout: out,
        stderr: err,
    })
}

async fn monitor_budget(
    staging: &Path,
    budget: Budget,
) -> anyhow::Result<std::process::ExitStatus> {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let path = staging.to_path_buf();
        tokio::task::spawn_blocking(move || check_budget(&path, budget)).await??;
    }
}

fn check_budget(staging: &Path, budget: Budget) -> anyhow::Result<()> {
    ensure!(
        (budget.available_space)(staging)? > budget.reserve.saturating_add(WRITE_HEADROOM),
        "Libation download stopped: insufficient free space to preserve min_download_free_gib"
    );
    let mut bytes = 0u64;
    for entry in walkdir::WalkDir::new(staging).follow_links(false) {
        // Libation moves and deletes temporary files during decryption.
        let entry = match entry {
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            entry => entry?,
        };
        ensure!(
            entry.file_type().is_dir() || entry.file_type().is_file(),
            "Libation output contains a link or special file"
        );
        if entry.file_type().is_file() {
            let metadata = match entry.metadata() {
                Err(error)
                    if error
                        .io_error()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue;
                }
                metadata => metadata?,
            };
            bytes = bytes.saturating_add(metadata.len());
            ensure!(
                budget.limit.is_none_or(|limit| bytes <= limit),
                "Libation download stopped: title exceeds max_upload_gib (including temporary files)"
            );
        }
    }
    Ok(())
}

// Only the process group created for this invocation is signalled. This also
// stops decoder subprocesses when the job future is cancelled.
#[cfg(unix)]
struct ProcessGroup(u32);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SAFETY: the PID comes from our child, started in its own process group.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

// Windows has no process groups to signal. A job object that kills its members
// when the last handle closes gives the same reach over decoder subprocesses.
// The child is assigned just after it starts, so a grandchild it launched in
// that instant would escape.
#[cfg(windows)]
struct ProcessGroup {
    _job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl ProcessGroup {
    fn new(child: &tokio::process::Child) -> anyhow::Result<Self> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let process = child
            .raw_handle()
            .context("Missing Libation process handle")?;
        // SAFETY: plain Win32 calls; the handle is owned by the returned guard
        // and closed on every path, and `process` outlives the calls.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            ensure!(!job.is_null(), "Could not create a job for Libation");
            let group = Self {
                _job: std::os::windows::io::OwnedHandle::from_raw_handle(job),
            };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            ensure!(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                ) != 0
                    && AssignProcessToJobObject(job, process as _) != 0,
                "Could not place Libation in its job"
            );
            Ok(group)
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[tokio::test]
    async fn job_guard_can_cross_spawn_await_and_stops_its_child() {
        let mut child = Command::new("ping.exe")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let group = ProcessGroup::new(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), child.wait())
                .await
                .is_err(),
            "The fixture exited before closing its job"
        );

        // Production holds the job across awaits inside a spawned job future.
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            drop(group);
        })
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("Closing the job did not stop its child")
            .unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(script: &str) -> (tempfile::TempDir, LibationConfig) {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let config = state.libation_config;
        let cli = config.cli_path.as_ref().unwrap();
        std::fs::write(
            cli,
            format!(
                r#"#!/usr/bin/env python3
import os, pathlib, signal, sys
settings = dict(arg.split('=', 1) for arg in sys.argv if arg.startswith(('Books=', 'InProgress=')))
books = pathlib.Path(settings['Books'])
temporary = pathlib.Path(settings['InProgress'])
assert books.parent == temporary.parent
assert pathlib.Path(os.environ['TMPDIR']) == temporary
{script}
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        (root, config)
    }

    fn budget() -> Budget {
        Budget {
            limit: Some(1024),
            reserve: 2048,
            available_space: |_| Ok(u64::MAX),
        }
    }

    async fn run(config: &LibationConfig, budget: Budget) -> anyhow::Result<std::process::Output> {
        tokio::time::timeout(
            Duration::from_secs(10),
            download_with_budget(config, "B000TEST00", budget),
        )
        .await
        .expect("Libation watchdog did not stop the writer")
    }

    fn assert_empty(config: &LibationConfig) {
        assert_eq!(std::fs::read_dir(&config.library_root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn publishes_complete_title_and_does_not_duplicate_it() {
        let (_root, config) = fixture(
            "(books / 'book.m4b').write_bytes(b'audio')\n(books / 'book.metadata.json').write_text('{}')",
        );
        assert!(run(&config, budget()).await.unwrap().status.success());
        let title = std::fs::read_dir(config.library_root.join("Audible [B000TEST00]"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read(title.join("book.m4b")).unwrap(), b"audio");
        assert!(title.join("book.metadata.json").is_file());
        std::fs::remove_file(config.cli_path.as_ref().unwrap()).unwrap();
        assert!(run(&config, budget()).await.unwrap().status.success());
        assert_eq!(std::fs::read_dir(&config.library_root).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn imports_without_runtime_diagnostic_special_files() {
        let (_root, config) = fixture(
            r#"if os.environ.get('DOTNET_EnableDiagnostics') != '0':
    import socket
    diagnostic = socket.socket(socket.AF_UNIX)
    diagnostic.bind(str(temporary / 'dotnet-diagnostic-socket'))
    os.mkfifo(temporary / 'clr-debug-pipe-in')
    os.mkfifo(temporary / 'clr-debug-pipe-out')
(books / 'book.m4b').write_bytes(b'audio')"#,
        );
        assert!(run(&config, budget()).await.unwrap().status.success());
        assert_eq!(
            crate::walk_audio_files_checked(&config.library_root)
                .files
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn rejects_low_space_before_starting_cli() {
        let (_root, config) = fixture("raise Exception('must not run')");
        let mut budget = budget();
        budget.available_space = |_| Ok(WRITE_HEADROOM);
        assert!(
            run(&config, budget)
                .await
                .unwrap_err()
                .to_string()
                .contains("min_download_free_gib")
        );
        assert_empty(&config);
    }

    #[tokio::test]
    async fn can_import_again_after_removing_the_local_book() {
        let (_root, config) = fixture("(books / 'book.m4b').write_bytes(b'audio')");
        assert!(run(&config, budget()).await.unwrap().status.success());
        let title = config.library_root.join("Audible [B000TEST00]");
        let imported = std::fs::read_dir(&title)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::remove_dir_all(imported).unwrap();
        assert!(run(&config, budget()).await.unwrap().status.success());
        assert_eq!(crate::walk_audio_files_checked(&title).files.len(), 1);
    }

    #[tokio::test]
    async fn each_title_checks_space_consumed_by_previous_imports() {
        let (_root, config) = fixture("(books / 'book.m4b').write_bytes(b'audio')");
        let mut budget = budget();
        budget.available_space = |path| {
            Ok(
                if path.parent().unwrap().join("Audible [B000TEST00]").exists() {
                    0
                } else {
                    u64::MAX
                },
            )
        };
        assert!(run(&config, budget).await.unwrap().status.success());
        let error = download_with_budget(&config, "B000TEST01", budget)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("min_download_free_gib"));
        assert_eq!(std::fs::read_dir(&config.library_root).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn kills_writer_when_output_or_temporary_files_exceed_limit() {
        for target in ["books", "temporary"] {
            let (root, config) = fixture(&format!(
                "pathlib.Path(__file__).with_suffix('.pid').write_text(str(os.getpid()))\n({target} / 'large').write_bytes(b'x' * 2048)\nsignal.pause()"
            ));
            assert!(
                run(&config, budget())
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("max_upload_gib")
            );
            let pid: i32 = std::fs::read_to_string(root.path().join("fake-libation.pid"))
                .unwrap()
                .parse()
                .unwrap();
            // SAFETY: signal 0 only checks the PID recorded by our fake CLI.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_empty(&config);
        }
    }

    #[tokio::test]
    async fn kills_writer_when_free_space_drops_and_rechecks_next_job() {
        let (_root, config) = fixture("(books / 'book.m4b').write_bytes(b'audio')\nsignal.pause()");
        let mut budget = budget();
        budget.available_space = |path| {
            Ok(if path.join("books/book.m4b").exists() {
                WRITE_HEADROOM
            } else {
                u64::MAX
            })
        };
        assert!(
            run(&config, budget)
                .await
                .unwrap_err()
                .to_string()
                .contains("min_download_free_gib")
        );
        assert_empty(&config);
        budget.available_space = |_| Ok(0);
        assert!(
            run(&config, budget)
                .await
                .unwrap_err()
                .to_string()
                .contains("min_download_free_gib")
        );
        assert_empty(&config);
    }

    #[tokio::test]
    async fn checks_fast_exit_and_never_publishes_failed_or_unsafe_output() {
        for script in [
            "(books / 'large').write_bytes(b'x' * 2048)",
            "(books / 'link').symlink_to('/tmp')",
            "os.mkfifo(temporary / 'pipe')",
            "import socket\nsock = socket.socket(socket.AF_UNIX)\nsock.bind(str(temporary / 'socket'))",
        ] {
            let (_root, config) = fixture(script);
            assert!(run(&config, budget()).await.is_err());
            assert_empty(&config);
        }
        let (_root, config) = fixture("(books / 'partial.m4b').write_bytes(b'audio')\nsys.exit(1)");
        assert!(!run(&config, budget()).await.unwrap().status.success());
        assert_empty(&config);
    }
}
