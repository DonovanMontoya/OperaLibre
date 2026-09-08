"""Linux integration test; uses isolated fake servers, never installed services."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

LAUNCHER = Path(sys.argv[1]).resolve()
SERVER = r'''
use std::{env, fs, io::{Read, Write}, net::TcpListener, time::{Instant, Duration}};
fn main() {
    if env::var_os("TEST_FAIL_NEW").is_some() && fs::read_to_string("VERSION.txt").unwrap().trim() == "2.0.0" {
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(2);
    }
    let listener = TcpListener::bind(format!("127.0.0.1:{}", env::var("TEST_PORT").unwrap())).unwrap();
    let start = Instant::now();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut buffer = [0; 2048];
        let _ = stream.read(&mut buffer);
        let ready = start.elapsed() > Duration::from_secs(2);
        let body = format!("{{\"ok\":true,\"ready\":{ready}}}");
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    }
}
'''

def until(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if check():
            return
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
    binary = scratch / "fake-server"
    subprocess.run(["rustc", "--edition=2024", str(source), "-o", str(binary)], check=True)
    for scenario in ("success", "startup-failure", "staging-failure"):
        fails = scenario == "startup-failure"
        root = scratch / scenario
        package = root / "package"
        for directory in (root / "data", root / "web", package / "web"):
            directory.mkdir(parents=True)
        with socket.socket() as port_probe:
            port_probe.bind(("127.0.0.1", 0))
            port = port_probe.getsockname()[1]
        (root / "server.config").write_text(f"port = {port}\ndata_dir = data\n")
        (root / "VERSION.txt").write_text("1.0.0\n")
        (package / "VERSION.txt").write_text("2.0.0\n")
        for destination in (root / "operalibre-server", package / "operalibre-server"):
            shutil.copy2(binary, destination)
        for destination in (root / "operalibre-service", package / "operalibre-updater"):
            shutil.copy2(LAUNCHER, destination)
        if scenario == "staging-failure":
            # Backup preparation fails before any new files are installed.
            (root / "data/update-backups").write_text("not a directory")
        env = dict(os.environ, TEST_PORT=str(port))
        if fails:
            env["TEST_FAIL_NEW"] = "1"
        old = subprocess.Popen([str(root / "operalibre-server")], cwd=root, env=env)
        (root / "data/operalibre-server.pid").write_text(str(old.pid))
        updater = starter = None
        try:
            updater = subprocess.Popen([str(package / "operalibre-updater"), "--apply-update", str(package),
                "--install-root", str(root), "--server-pid", str(old.pid), "--port", str(port), "--layout", "combined"], env=env)
            until(lambda: (root / "data/update.lock").exists())
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
            with (root / "data/update.lock").open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(f"PASS: {'rollback' if fails else 'success'} survives early takeover; PID owned and lock released", flush=True)
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
