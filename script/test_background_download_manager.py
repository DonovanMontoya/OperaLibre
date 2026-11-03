"""Run production manager bodies on macOS with disposable storage and URLSession.

Only platform/storage seams are substituted. No manager control flow or budget
logic is rewritten; the Swift assertions compile in the same file for access to
private persisted records. iOS background transport still needs simulator tests.
"""
from pathlib import Path
import subprocess
import tempfile
import re
import os
import uuid

ROOT = Path(__file__).resolve().parents[1]

def replace_once(source, old, new):
    assert source.count(old) == 1, old
    return source.replace(old, new)

with tempfile.TemporaryDirectory(prefix="ol-manager-") as directory:
    scratch = Path(directory)
    manager = (ROOT / "apps/web/ios/App/App/BackgroundDownloads.swift").read_text()
    manager = manager.split("@objc(BackgroundDownloadsPlugin)")[0]
    manager = replace_once(manager, "import Capacitor\n", "")
    manager = replace_once(manager, "URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)", "URLSessionConfiguration.ephemeral")
    manager = replace_once(manager, "configuration.sessionSendsLaunchEvents = true", "")
    manager = replace_once(manager, "configuration.waitsForConnectivity = true", "")
    manager = re.sub(r"\b(?:private|fileprivate)\b", "", manager)
    manager = manager.replace("UserDefaults.standard", 'UserDefaults(suiteName: ProcessInfo.processInfo.environment["OL_TEST_SUITE"]!)!')
    policy = (ROOT / "apps/web/ios/App/App/BackgroundDownloadPolicy.swift").read_text()
    policy = replace_once(policy, "25 * 1024 * 1024 * 1024", "12")
    policy = replace_once(policy, 'FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first', 'URL(string: ProcessInfo.processInfo.environment["OL_TEST_ROOT"]!)')
    combined = scratch / "main.swift"
    combined.write_text(policy + "\n" + manager + "\n" + (ROOT / "apps/web/ios/Tests/BackgroundDownloadManagerTests.swift").read_text())
    if os.environ.get("OL_MANAGER_SOURCE"):
        Path(os.environ["OL_MANAGER_SOURCE"]).write_text(combined.read_text())
    binary = scratch / "tests"
    subprocess.run(["swiftc", "-module-cache-path", str(scratch / "cache"), str(combined), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], env={**os.environ, "OL_TEST_ROOT": scratch.as_uri(), "OL_TEST_SUITE": "ol-manager-" + str(uuid.uuid4())}, check=True)
