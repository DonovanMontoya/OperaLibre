"""Exercise real release packages in disposable installations (Python 3.12+).

This tests the packaged updater, restart, persistence and startup rollback.
It invokes the updater directly: download selection/signature verification are
covered separately, and no public release or production signing key is needed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def until(check, description, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    raise AssertionError(f"Timed out: {description}")


def extract(archive, destination):
    destination.mkdir()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                target = (destination / member.filename).resolve()
                require(target.is_relative_to(destination.resolve()), "Unsafe ZIP member")
                require((member.external_attr >> 16) & 0o170000 != 0o120000,
                        "ZIP links are not supported")
            package.extractall(destination)
    else:
        with tarfile.open(archive) as package:
            package.extractall(destination, filter="data")
    roots = list(destination.iterdir())
    require(len(roots) == 1 and roots[0].is_dir(), "Expected one package folder")
    return roots[0]


def digest(file):
    with file.open("rb") as contents:
        return hashlib.file_digest(contents, "sha256").hexdigest()


def stop_launcher(root):
    if os.name == "nt":
        return root / "Stop OperaLibre.exe"
    app = root / "Stop OperaLibre.app/Contents/MacOS/operalibre-launcher"
    return app if app.is_file() else root / "stop-operalibre"


def scenario(baseline, candidate, layout, rollback):
    label = f"{layout}/{'rollback' if rollback else 'upgrade'}"
    with tempfile.TemporaryDirectory(prefix="operalibre-upgrade-") as scratch:
        scratch = Path(scratch).resolve()
        root = extract(baseline, scratch / "installed")
        package = extract(candidate, scratch / "candidate")
        suffix = ".exe" if os.name == "nt" else ""
        server_name = f"operalibre-server{suffix}"
        updater = package / f"operalibre-updater{suffix}"
        old_version = (root / "VERSION.txt").read_text().strip()
        new_version = (package / "VERSION.txt").read_text().strip()
        metadata = json.loads((package / "UPDATE.json").read_text())
        require(metadata["version"] == new_version, "UPDATE.json version mismatch")
        old_server_digest = digest(root / server_name)
        expected_digest = old_server_digest if rollback else digest(package / server_name)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        # Both duplicate-key parsing and the blank-port environment fallback
        # have previously caused a healthy upgrade to wait on the wrong port.
        port_config = f"port = 1\nPORT = {port}" if layout == "combined" else "port = 1\nport ="
        config = (f"deployment_mode = local\nhost = 127.0.0.1\n{port_config}\n"
                  "library_root = audiobooks\ndata_dir = data\n"
                  "progress_file = data/progress.json\nusers_file = data/users.json\n"
                  f"web_dist_dir = {'web' if layout == 'combined' else ''}\n")
        (root / "server.config").write_text(config)
        if layout == "server-only":
            shutil.rmtree(root / "web")
        for folder in ("data", "audiobooks"):
            (root / folder).mkdir(exist_ok=True)
            (root / folder / "upgrade-test.txt").write_text(f"preserve {folder}")
        if rollback:
            # A non-executable image reliably exercises startup failure on
            # Windows as well as Unix, without waiting for the startup ceiling.
            (package / server_name).write_bytes(b"deliberately invalid executable\n")

        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("OPERALIBRE_") and key != "PORT"}
        if layout == "server-only":
            environment["PORT"] = str(port)
        base = f"http://127.0.0.1:{port}"
        token = None

        def request(route, payload=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            data = json.dumps(payload).encode() if payload is not None else None
            with urllib.request.urlopen(urllib.request.Request(
                    base + route, data=data, headers=headers), timeout=3) as response:
                return json.load(response)

        def ready():
            return request("/api/health").get("ready") is True

        old = worker = None
        with (scratch / "process.log").open("wb") as log:
            try:
                old = subprocess.Popen([str(root / server_name)], cwd=root,
                                       env=environment, stdout=log, stderr=log)
                (root / "data/operalibre-server.pid").write_text(str(old.pid))
                until(ready, "baseline server startup")
                account = request("/api/auth/setup", {
                    "username": "upgrade-test-owner", "password": secrets.token_urlsafe(24)})
                token = account["token"]
                user_id = account["user"]["id"]
                worker = subprocess.Popen([
                    str(updater), "--apply-update", str(package), "--install-root", str(root),
                    "--server-pid", str(old.pid), "--port", str(port), "--layout", layout,
                ], env=environment, stdout=log, stderr=log)
                # The packaged updater waits for the old server to finish.
                # Do not race it by replacing a live executable ourselves.
                old.terminate()
                old.wait(timeout=15)
                result = worker.wait(timeout=90)
                expected_version = old_version if rollback else new_version
                message = (root / "data/update-result.txt").read_text().strip()
                require(result == (1 if rollback else 0), f"{label}: updater exit {result}: {message}")
                if rollback:
                    require("restored the previous version" in message, message)
                else:
                    require(message == f"Succeeded: {new_version}", message)
                until(ready, "server restart")
                require((root / "VERSION.txt").read_text().strip() == expected_version,
                        "Installed version mismatch")
                require(digest(root / server_name) == expected_digest, "Wrong server binary")
                require((root / "server.config").read_text() == config, "Configuration changed")
                for folder in ("data", "audiobooks"):
                    require((root / folder / "upgrade-test.txt").read_text() == f"preserve {folder}",
                            f"{folder} was not preserved")
                status = request("/api/auth/status")
                require(status["user"]["id"] == user_id, "Account/session was not preserved")
                if layout == "combined":
                    require((root / "web/VERSION.txt").read_text().strip() == expected_version,
                            "Web version mismatch")
                else:
                    require(not (root / "web").exists(), "Server-only gained a web folder")
                print(f"PASS: {label}: {old_version} -> {expected_version}; "
                      "healthy, account/session, configuration and files preserved", flush=True)
            finally:
                # All commands target launchers inside this disposable tree.
                # Their stop path checks that the PID belongs to its server.
                if worker is not None and worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=10)
                if old is not None and old.poll() is None:
                    old.terminate()
                    old.wait(timeout=15)
                subprocess.run([str(stop_launcher(root)), "--stop"], env=environment,
                               stdout=log, stderr=log, timeout=45, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True, help="Older combined ZIP or tar.gz")
    parser.add_argument("--candidate", type=Path, required=True, help="New combined ZIP or tar.gz")
    args = parser.parse_args()
    for layout in ("combined", "server-only"):
        for rollback in (False, True):
            scenario(args.baseline.resolve(), args.candidate.resolve(), layout, rollback)


if __name__ == "__main__":
    main()
