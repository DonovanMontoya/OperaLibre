"""Linux integration test; uses isolated fake servers, never installed services."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

LAUNCHER = Path(sys.argv[1]).resolve()
SERVER = r'''
use std::{env, fs, io::{Read, Write}, net::TcpListener, process::Command, time::{Instant, Duration}};
fn main() {
    let version = fs::read_to_string("VERSION.txt").unwrap();
    let new = version.trim() == "2.0.0";
    // Opening the data dir: the new build writes and may upgrade it; the old
    // build refuses a format newer than its own, as the real server does.
    let hook = env::var("TEST_DATA_HOOK").unwrap();
    if !Command::new("python3").args(["-I", &hook, version.trim()]).status().unwrap().success() {
        std::process::exit(3);
    }
    if env::var_os("TEST_FAIL_NEW").is_some() && new {
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(2);
    }
    // The library cannot be loaded, as with a missing drive.
    let unavailable = new && env::var_os("TEST_UNAVAILABLE_NEW").is_some();
    let listener = TcpListener::bind(format!("127.0.0.1:{}", env::var("TEST_PORT").unwrap())).unwrap();
    let start = Instant::now();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut buffer = [0; 2048];
        let _ = stream.read(&mut buffer);
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
database = sqlite3.connect("data/operalibre.db")
identities = "data/library-identities.json"
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
    source = scratch / "fake.rs"
    source.write_text(SERVER)
    hook = scratch / "data_hook.py"
    hook.write_text(DATA_HOOK)
    binary = scratch / "fake-server"
    subprocess.run(["rustc", "--edition=2024", str(source), "-o", str(binary)], check=True)
    for scenario in ("success", "startup-failure", "upgraded-data-rollback", "staging-failure", "stop-handoff"):
        fails = scenario in ("startup-failure", "upgraded-data-rollback")
        root = scratch / scenario
        package = root / "package"
        for directory in (root / "data", root / "web", package / "web"):
            directory.mkdir(parents=True)
        with socket.socket() as port_probe:
            port_probe.bind(("127.0.0.1", 0))
            port = port_probe.getsockname()[1]
        (root / "server.config").write_text(f"port = {port}\ndata_dir = data\n")
        (root / "VERSION.txt").write_text("1.0.0\n")
        seed_data(root / "data")
        (package / "VERSION.txt").write_text("2.0.0\n")
        for destination in (root / "operalibre-server", package / "operalibre-server"):
            shutil.copy2(binary, destination)
        for destination in (root / "operalibre-service", package / "operalibre-updater"):
            shutil.copy2(LAUNCHER, destination)
        if scenario == "staging-failure":
            # Backup preparation fails before any new files are installed.
            (root / "data/update-backups").write_text("not a directory")
        env = dict(os.environ, TEST_PORT=str(port), TEST_DATA_HOOK=str(hook))
        if scenario == "startup-failure":
            env["TEST_FAIL_NEW"] = "1"
        if scenario == "upgraded-data-rollback":
            env["TEST_UNAVAILABLE_NEW"] = "1"
            env["TEST_UPGRADE_DATA"] = "1"
        old = subprocess.Popen([str(root / "operalibre-server")], cwd=root, env=env)
        (root / "data/operalibre-server.pid").write_text(str(old.pid))
        updater = starter = None
        try:
            updater = subprocess.Popen([str(package / "operalibre-updater"), "--apply-update", str(package),
                "--install-root", str(root), "--server-pid", str(old.pid), "--port", str(port), "--layout", "combined"], env=env)
            until(lambda: (root / "data/update.lock").exists())
            if scenario == "stop-handoff":
                subprocess.run([str(root / "operalibre-service"), "--stop"], env=env, check=True)
                old.wait(timeout=5)
                assert updater.wait(timeout=20) == 0
                pid = int((root / "data/operalibre-server.pid").read_text())
                assert pid != old.pid
                assert os.readlink(f"/proc/{pid}/exe") == str(root / "operalibre-server")
                until(lambda: healthy(port))
                print("PASS: stopping the old server preserves the restarted server PID", flush=True)
                continue
            old.terminate()
            old.wait(timeout=5)
            if scenario == "staging-failure":
                assert updater.wait(timeout=20) == 1
                result = (root / "data/update-result.txt").read_text()
                assert result.startswith("Failed:"), result
                assert "previous server was restarted" in result, result
                assert (root / "VERSION.txt").read_text().strip() == "1.0.0"
                until(lambda: healthy(port))
                print("PASS: backup preparation failure restarts the previous server", flush=True)
                continue
            until(lambda: (root / "VERSION.txt").exists() and (root / "VERSION.txt").read_text().strip() == "2.0.0")
            assert not (root / "data/update-result.txt").exists()
            # Deliberately request takeover before readiness, reproducing the
            # old VERSION watcher timing. The shared lock must defer it.
            starter = subprocess.Popen([str(root / "operalibre-service"), "--service-start"], env=env)
            assert updater.wait(timeout=20) == (1 if fails else 0)
            result = (root / "data/update-result.txt").read_text()
            assert result.startswith("Failed:" if fails else "Succeeded:"), result
            until(lambda: (root / "data/operalibre-server.pid").read_text() == str(starter.pid))
            until(lambda: os.readlink(f"/proc/{starter.pid}/exe") == str(root / "operalibre-server"))
            assert (root / "VERSION.txt").read_text().strip() == ("1.0.0" if fails else "2.0.0")
            until(lambda: healthy(port))
            # Data the old build can read is kept, with what the new build
            # saved; data the new build upgraded goes back to the snapshot.
            if scenario == "upgraded-data-rollback":
                assert read_data(root / "data") == (4, 1, ["before-update"]), read_data(root / "data")
            else:
                assert read_data(root / "data") == (4, 1, ["before-update", "new-build"]), read_data(root / "data")
            assert not list((root / "data/update-backups").glob("*/data")), "the data snapshot was kept"
            with (root / "data/update.lock").open("r+") as lock:
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
                pid = int((root / "data/operalibre-server.pid").read_text())
                if os.readlink(f"/proc/{pid}/exe") == str(root / "operalibre-server"):
                    os.kill(pid, 15)
            except (OSError, ValueError):
                pass
