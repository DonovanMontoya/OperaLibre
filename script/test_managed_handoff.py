"""Linux integration test; uses isolated fake servers, never installed services."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

LAUNCHER = Path(sys.argv[1]).resolve()
SELECTED = set(sys.argv[2:])
REPOSITORY = Path(__file__).resolve().parent.parent
SERVER = r'''
use std::{env, fs, io::{Read, Write}, net::TcpListener, process::Command, time::{Instant, Duration}};
fn main() {
    let root = env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let version = fs::read_to_string(root.join("VERSION.txt")).unwrap();
    let config = env::var_os("OPERALIBRE_SERVER_CONFIG").map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("server.config"));
    if env::var_os("TEST_REQUIRE_ABSOLUTE_CONFIG").is_some() {
        assert!(config.is_absolute(), "the restarted server needs an absolute config path");
    }
    let values = fs::read_to_string(&config).unwrap();
    let value = |key: &str| values.lines().find_map(|line| {
        let (name, value) = line.split_once('=')?;
        (name.trim() == key).then(|| value.trim())
    }).unwrap();
    let data = config.parent().unwrap().join(value("data_dir"));
    let port = value("port");
    let new = version.trim() == "2.0.0";
    // Opening the data dir: the new build writes and may upgrade it; the old
    // build refuses a format newer than its own, as the real server does.
    let hook = env::var("TEST_DATA_HOOK").unwrap();
    if !Command::new("python3").args(["-I", &hook, version.trim()]).env("TEST_DATA_DIR", &data).status().unwrap().success() {
        std::process::exit(3);
    }
    if env::var_os("TEST_FAIL_NEW").is_some() && new {
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(2);
    }
    // The library cannot be loaded, as with a missing drive.
    let unavailable = new && env::var_os("TEST_UNAVAILABLE_NEW").is_some();
    // An update trial waits for the updater's commit, as the real server
    // does; a new build marked legacy predates trials and has no such route.
    let trial = env::var("OPERALIBRE_UPDATE_TRIAL").ok().filter(|_| env::var_os("TEST_LEGACY_NEW").is_none());
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).unwrap();
    let start = Instant::now();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut buffer = [0; 2048];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]).to_string();
        if request.starts_with("POST /api/update-trial/commit ") {
            let status = match &trial {
                None => "404 Not Found",
                Some(token) if request.contains(&format!("X-OperaLibre-Update-Trial: {token}\r\n")) => {
                    fs::write(data.join("trial-committed"), version.trim()).unwrap();
                    "204 No Content"
                }
                Some(_) => "403 Forbidden",
            };
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let ready = start.elapsed() > Duration::from_secs(2);
        let body = if unavailable {
            "{\"ok\":true,\"ready\":false,\"catalogueError\":true}".to_string()
        } else {
            format!("{{\"ok\":true,\"ready\":{ready}}}")
        };
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    }
}
'''
DATA_HOOK = '''
import json, os, sqlite3, sys
database = sqlite3.connect(os.path.join(os.environ["TEST_DATA_DIR"], "operalibre.db"))
identities = os.path.join(os.environ["TEST_DATA_DIR"], "library-identities.json")
if sys.argv[1] == "2.0.0":
    upgrade = os.environ.get("TEST_UPGRADE_DATA")
    with database:
        database.execute("INSERT OR IGNORE INTO progress VALUES ('new-build')")
        if upgrade:
            database.execute("UPDATE schema_version SET version = 5")
    if upgrade:
        with open(identities, "w") as file:
            json.dump({"version": 2}, file)
    sys.exit(0)
schema = database.execute("SELECT version FROM schema_version").fetchone()[0]
with open(identities) as file:
    identity_format = json.load(file).get("version", 0)
sys.exit(0 if schema <= 4 and identity_format <= 1 else 1)
'''

def seed_data(data):
    database = sqlite3.connect(data / "operalibre.db")
    with database:
        database.executescript("""
            PRAGMA journal_mode = WAL;
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version VALUES (4);
            CREATE TABLE progress (book TEXT PRIMARY KEY);
            INSERT INTO progress VALUES ('before-update');
        """)
    database.close()
    (data / "library-identities.json").write_text('{"version": 1}')

def read_data(data):
    database = sqlite3.connect(f"file:{data / 'operalibre.db'}?mode=ro", uri=True)
    try:
        schema = database.execute("SELECT version FROM schema_version").fetchone()[0]
        books = [row[0] for row in database.execute("SELECT book FROM progress ORDER BY book")]
    finally:
        database.close()
    identities = json.loads((data / "library-identities.json").read_text()).get("version", 0)
    return schema, identities, books

def until(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for handoff")

def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
            return json.load(response).get("ready") is True
    except (OSError, ValueError):
        return False

with tempfile.TemporaryDirectory(prefix="operalibre-handoff-") as scratch:
    scratch = Path(scratch)
    # Exercise the launchers still installed when staging fails, rather than
    # approximating their PID lookup in Python.
    old_source = scratch / "old-launcher"
    (old_source / "src").mkdir(parents=True)
    old_files = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", "origin/main", "apps/launcher"], cwd=REPOSITORY).decode().splitlines()
    for name in old_files:
        contents = subprocess.check_output(["git", "show", f"origin/main:{name}"], cwd=REPOSITORY)
        destination = old_source / Path(name).relative_to("apps/launcher")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)
    old_target = scratch / "old-target"
    subprocess.run(["cargo", "build", "--locked", "--manifest-path", str(old_source / "Cargo.toml"),
        "--target-dir", str(old_target)], check=True)
    old_launcher = old_target / "debug/operalibre-launcher"
    source = scratch / "fake.rs"
    source.write_text(SERVER)
    hook = scratch / "data_hook.py"
    hook.write_text(DATA_HOOK)
    binary = scratch / "fake-server"
    subprocess.run(["rustc", "--edition=2024", str(source), "-o", str(binary)], check=True)
    for scenario in ("success", "legacy-target", "startup-failure", "upgraded-data-rollback", "staging-failure", "stop-handoff", "external-config", "relative-config", "external-config-rollback", "external-staging-failure", "external-stop-handoff",
                     "missing-config-stop", "invalid-config-stop", "stale-effective-stop", "default-old-stop"):
        if SELECTED and scenario not in SELECTED:
            continue
        stop_only = scenario in ("missing-config-stop", "invalid-config-stop", "stale-effective-stop", "default-old-stop")
        staging_failure = scenario in ("staging-failure", "external-staging-failure")
        fails = scenario in ("startup-failure", "upgraded-data-rollback", "external-config-rollback")
        external = scenario in ("external-config", "relative-config", "external-config-rollback", "external-staging-failure", "external-stop-handoff")
        root = scratch / scenario
        package = root / "package"
        for directory in (root / "data", root / "web", package / "web"):
            directory.mkdir(parents=True)
        with socket.socket() as port_probe:
            port_probe.bind(("127.0.0.1", 0))
            port = port_probe.getsockname()[1]
        (root / "server.config").write_text(f"port = {port}\ndata_dir = data\n")
        (root / "VERSION.txt").write_text("1.0.0\n")
        data = root / "data"
        config = root / "server.config"
        if stop_only and scenario != "default-old-stop":
            data = root / "legacy-state"
            data.mkdir()
            config.write_text(f"port = {port}\ndata_dir = legacy-state\n")
        legacy_pid = data / "operalibre-server.pid"
        if external:
            external_dir = scratch / f"{scenario}-deployment"
            data = external_dir / "state"
            data.mkdir(parents=True)
            config = external_dir / "custom.config"
            config.write_text(f"port = {port}\ndata_dir = state\n")
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                wrong_port = probe.getsockname()[1]
            (root / "server.config").write_text(f"port = {wrong_port}\ndata_dir = data\n")
            seed_data(root / "data")
            with sqlite3.connect(root / "data/operalibre.db") as wrong:
                wrong.execute("UPDATE schema_version SET version = 1")
        seed_data(data)
        (package / "VERSION.txt").write_text("2.0.0\n")
        for destination in (root / "operalibre-server", package / "operalibre-server"):
            shutil.copy2(binary, destination)
        for destination in (root / "operalibre-service", package / "operalibre-updater"):
            shutil.copy2(LAUNCHER, destination)
        if scenario == "external-staging-failure":
            shutil.copy2(old_launcher, root / "operalibre-service")
        if staging_failure:
            # Backup preparation fails before any new files are installed.
            (data / "update-backups").write_text("not a directory")
        env = dict(os.environ, TEST_DATA_HOOK=str(hook))
        for variable in ("OPERALIBRE_SERVER_CONFIG", "OPERALIBRE_DATA_DIR", "PORT"):
            env.pop(variable, None)
        if external:
            env["OPERALIBRE_SERVER_CONFIG"] = str(config.relative_to(scratch) if scenario == "relative-config" else config)
        if scenario == "startup-failure":
            env["TEST_FAIL_NEW"] = "1"
        if scenario in ("upgraded-data-rollback", "external-config-rollback"):
            env["TEST_UNAVAILABLE_NEW"] = "1"
            env["TEST_UPGRADE_DATA"] = "1"
        if scenario == "legacy-target":
            env["TEST_LEGACY_NEW"] = "1"
        if stop_only:
            shutil.copy2(old_launcher, root / "old-service")
        old = subprocess.Popen([str(root / "old-service"), "--service-start"] if stop_only else [str(root / "operalibre-server")],
            cwd=scratch if external else root, env=env)
        if external:
            env["TEST_REQUIRE_ABSOLUTE_CONFIG"] = "1"
        if not stop_only:
            # The server being replaced was started by an old installed launcher.
            legacy_pid.write_text(str(old.pid))
        updater = starter = None
        try:
            if stop_only:
                until(lambda: healthy(port))
                assert legacy_pid.read_text() == str(old.pid)
                stop_env = dict(env)
                if scenario != "default-old-stop":
                    explicit = root / "unreadable.config"
                    if scenario == "invalid-config-stop":
                        explicit.write_bytes(b"\xff\xfe")
                    stop_env["OPERALIBRE_SERVER_CONFIG"] = str(explicit)
                    if scenario == "stale-effective-stop":
                        exited = subprocess.Popen(["true"])
                        exited.wait(timeout=5)
                        (root / "data/operalibre-server.pid").write_text(str(exited.pid))
                subprocess.run([str(root / "operalibre-service"), "--stop"], cwd=root, env=stop_env, check=True)
                old.wait(timeout=5)
                assert not legacy_pid.exists()
                assert not (root / "data/operalibre-server.pid").exists()
                if scenario == "default-old-stop":
                    # New service start publishes the same single file old Stop reads.
                    starter = subprocess.Popen([str(root / "operalibre-service"), "--service-start"], cwd=root, env=env)
                    until(lambda: healthy(port))
                    assert legacy_pid.read_text() == str(starter.pid)
                    assert stat.S_IMODE(legacy_pid.stat().st_mode) == 0o600
                    assert list(root.rglob("operalibre-server.pid")) == [legacy_pid]
                    subprocess.run([str(root / "old-service"), "--stop"], cwd=root, env=env, check=True)
                    starter.wait(timeout=5)
                    assert not legacy_pid.exists()
                print(f"PASS: {scenario} stops the owned server and retires its PID", flush=True)
                continue
            updater = subprocess.Popen([str(package / "operalibre-updater"), "--apply-update", str(package),
                "--install-root", str(root), "--server-pid", str(old.pid), "--port", str(port), "--layout", "combined"], cwd=scratch if external else root, env=env)
            until(lambda: (data / "update.lock").exists())
            if scenario in ("stop-handoff", "external-stop-handoff"):
                subprocess.run([str(root / "operalibre-service"), "--stop"], cwd=scratch if external else root, env=env, check=True)
                old.wait(timeout=5)
                assert updater.wait(timeout=20) == 0
                pid = int((data / "operalibre-server.pid").read_text())
                assert pid != old.pid
                assert os.readlink(f"/proc/{pid}/exe") == str(root / "operalibre-server")
                until(lambda: healthy(port))
                assert legacy_pid.read_text() == str(pid)
                print(f"PASS: {scenario} preserves both restarted server PID copies", flush=True)
                continue
            old.terminate()
            old.wait(timeout=5)
            if staging_failure:
                assert updater.wait(timeout=20) == 1
                result = (data / "update-result.txt").read_text()
                assert result.startswith("Failed:"), result
                assert "previous server was restarted" in result, result
                assert (root / "VERSION.txt").read_text().strip() == "1.0.0"
                until(lambda: healthy(port))
                restarted_pid = int((data / "operalibre-server.pid").read_text())
                subprocess.run([str(root / "operalibre-service"), "--stop"], cwd=root, env=env, check=True)
                until(lambda: not healthy(port))
                assert not Path(f"/proc/{restarted_pid}/exe").exists()
                # Old Stop knows only the legacy file; new Stop retires the stale effective copy.
                if external:
                    shutil.copy2(LAUNCHER, root / "new-service")
                    subprocess.run([str(root / "new-service"), "--stop"], cwd=root, env=env, check=True)
                assert not (data / "operalibre-server.pid").exists()
                assert not legacy_pid.exists()
                print(f"PASS: {scenario} lets installed Stop retire the restarted previous server", flush=True)
                continue
            until(lambda: (root / "VERSION.txt").exists() and (root / "VERSION.txt").read_text().strip() == "2.0.0")
            assert not (data / "update-result.txt").exists()
            # Deliberately request takeover before readiness, reproducing the
            # old VERSION watcher timing. The shared lock must defer it.
            # The service start runs from the installation, where relative
            # config paths have always resolved, so it gets the absolute path.
            starter_env = dict(env, OPERALIBRE_SERVER_CONFIG=str(config)) if external else env
            starter = subprocess.Popen([str(root / "operalibre-service"), "--service-start"], cwd=scratch if external else root, env=starter_env)
            assert updater.wait(timeout=20) == (1 if fails else 0)
            result = (data / "update-result.txt").read_text()
            assert result.startswith("Failed:" if fails else "Succeeded:"), result
            until(lambda: (data / "operalibre-server.pid").read_text() == str(starter.pid))
            until(lambda: os.readlink(f"/proc/{starter.pid}/exe") == str(root / "operalibre-server"))
            assert (root / "VERSION.txt").read_text().strip() == ("1.0.0" if fails else "2.0.0")
            until(lambda: healthy(port))
            # Data the old build can read is kept, with what the new build
            # saved; data the new build upgraded goes back to the snapshot.
            if scenario in ("upgraded-data-rollback", "external-config-rollback"):
                assert read_data(data) == (4, 1, ["before-update"]), read_data(data)
                # The failed build's own data is kept for recovery by hand.
                kept = list((data / "update-backups").glob("*/failed-data"))
                assert len(kept) == 1, kept
                assert read_data(kept[0]) == (5, 2, ["before-update", "new-build"]), read_data(kept[0])
                assert not list((data / "update-backups").glob("*/restore-required"))
            else:
                assert read_data(data) == (4, 1, ["before-update", "new-build"]), read_data(data)
            # Only an update to a build with trials is committed; a failed one never is.
            committed = data / "trial-committed"
            assert committed.exists() == (scenario in ("success", "external-config", "relative-config")), scenario
            assert not list((data / "update-backups").glob("*/data")), "the data snapshot was kept"
            if external:
                assert not (root / "data/update.lock").exists()
                assert not (root / "data/update-result.txt").exists()
                assert legacy_pid.read_text() == str(starter.pid)
                assert stat.S_IMODE(legacy_pid.stat().st_mode) == 0o600
                assert read_data(root / "data") == (1, 1, ["before-update"])
            with (data / "update.lock").open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(f"PASS: {scenario} survives early takeover; PID owned, data readable by the running build, lock released", flush=True)
        finally:
            for process in (updater, starter, old):
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
            # If an assertion fails before takeover, retire only the fake
            # server belonging to this temporary fixture, never another PID.
            try:
                pid = int((data / "operalibre-server.pid").read_text())
                if os.readlink(f"/proc/{pid}/exe") == str(root / "operalibre-server"):
                    os.kill(pid, 15)
            except (OSError, ValueError):
                pass
