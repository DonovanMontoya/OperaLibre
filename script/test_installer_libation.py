"""Exercise the installer's Audible import setup with a real controlling terminal."""

import errno
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import tempfile
import time
import unittest


INSTALLER = Path(__file__).with_name("install.sh").read_text()


def function(name):
    return re.search(rf"^{name}\(\) \{{\n.*?^\}}", INSTALLER, re.M | re.S)[0]


# Run the actual options, terminal detection and complete optional Libation
# section. Exclude release download/installation and server startup.
PRELUDE = INSTALLER.split("# OperaLibre needs no privileges")[0]
HELPERS = "\n".join(function(name) for name in (
    "expand_home", "absolute_path", "config_value", "set_config", "need"))
SECTION = INSTALLER.split("# --- Optional Audible import (Libation)")[1]
SECTION = SECTION[SECTION.index("\n"):].split("\nPORT=$(configured_port)")[0]


class InstallerLibationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="operalibre-libation-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        # Paths with shell and sed metacharacters must survive into the config.
        self.install = self.root / "Reader's $books `library`"
        self.install.mkdir()
        self.cli = self.install / "Libation CLI"
        self.cli.write_text("#!/bin/sh\n")
        self.cli.chmod(0o755)
        self.dependency_record = self.root / "dependency-calls"
        self.icu_marker = self.root / "icu-installed"
        self.config = self.install / "server.config"
        self.config.write_text("libation_files_dir = custom settings\n")
        self.settings = self.install / "custom settings"
        self.env = {**os.environ, "OPERALIBRE_DIR": str(self.install),
                    "OPERALIBRE_LIBATION_PATH": "", "TEST_CLI": str(self.cli),
                    "DEPENDENCY_RECORD": str(self.dependency_record),
                    "ICU_MARKER": str(self.icu_marker)}
        # Never discover or download a real Libation.
        section = SECTION.replace(function("find_libation"),
                                  'find_libation() { printf "%s" "$TEST_CLI"; }')
        section = section.replace(function("install_libation"),
                                  'install_libation() { LIBATION_PATH=$TEST_CLI; }')
        self.script = self.root / "fixture.sh"
        self.script.write_text(PRELUDE + HELPERS + "\nos=macos\n" + section +
                               '\nsay "INSTALLATION_CONTINUES:$LIBATION_READY"\n')

    def run_setup(self, responses=(), args=(), terminal=True):
        # The shell reads its script on stdin, just as in curl | sh. Interactive
        # answers must come from /dev/tty and must not consume that script.
        if not terminal:
            result = subprocess.run(["sh", "-s", "--", *args],
                input=self.script.read_text(), text=True, capture_output=True,
                env=self.env, start_new_session=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        pid, fd = pty.fork()
        if pid == 0:
            source = os.open(self.script, os.O_RDONLY)
            os.dup2(source, 0)
            os.close(source)
            os.execvpe("sh", ["sh", "-s", "--", *args], self.env)
        output = b""
        pending = list(responses)
        consumed = 0
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    output += chunk
                if pending:
                    prompt, reply = pending[0]
                    index = output.find(prompt.encode(), consumed)
                    if index >= 0:
                        consumed = index + len(prompt)
                        os.write(fd, (reply + "\n").encode())
                        pending.pop(0)
            else:
                self.fail(f"Installer timed out; remaining prompts: {pending}\n{output.decode()}")
            _, status = os.waitpid(pid, 0)
            pid = None
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, output.decode())
            self.assertFalse(pending, output.decode())
        finally:
            if pid is not None:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(fd)
        return output.decode()

    def use_linux_without_icu(self, install_succeeds=True):
        apt_get = self.root / "apt-get"
        apt_get.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$DEPENDENCY_RECORD\"\n" +
                           ("[ \"$1\" != install ] || touch \"$ICU_MARKER\"\nexit 0\n"
                            if install_succeeds else "exit 1\n"))
        apt_get.chmod(0o755)
        apt_cache = self.root / "apt-cache"
        apt_cache.write_text("#!/bin/sh\nprintf '  Depends: libicu74\\n'\n")
        apt_cache.chmod(0o755)
        sudo = self.root / "sudo"
        sudo.write_text("#!/bin/sh\nexec \"$@\"\n")
        sudo.chmod(0o755)
        self.env["PATH"] = f"{self.root}{os.pathsep}{self.env['PATH']}"
        script = self.script.read_text().replace("os=macos", "os=linux")
        script = script.replace(function("libation_icu_available"),
            'libation_icu_available() { [ -f "$ICU_MARKER" ]; }')
        self.script.write_text(script)

    def assert_configured(self):
        self.assertIn(f"libation_cli_path = {self.cli}", self.config.read_text())

    def test_interactive_install_sets_up_import_without_sign_in(self):
        # Any further question would wait on the terminal and time the run out.
        output = self.run_setup([
            ("Set up the Audible import now? [y/N]:", "y"), ("Use it? [Y/n]:", "")])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assert_configured()
        for name in ("Settings.json", "AccountsSettings.json"):
            self.assertEqual((self.settings / name).read_text(), "{}")

    def test_download_when_found_libation_is_declined(self):
        output = self.run_setup([("Use it? [Y/n]:", "n"),
            ("Download Libation from its official GitHub release? [Y/n]:", "")],
            ["--libation"])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assert_configured()

    def test_unattended_install_sets_up_import(self):
        for terminal, options in ((True, ["--yes"]), (False, [])):
            with self.subTest(terminal=terminal):
                self.config.write_text("libation_files_dir = custom settings\n")
                output = self.run_setup(args=["--libation-path", str(self.cli), *options], terminal=terminal)
                self.assertIn("INSTALLATION_CONTINUES:1", output)
                self.assert_configured()

    def test_yes_installs_linux_icu_and_completes_libation_setup(self):
        self.use_linux_without_icu()
        output = self.run_setup(
            args=["--libation-path", str(self.cli), "--yes"], terminal=False)
        self.assertIn("Libation needs the ICU runtime on Linux", output)
        self.assertIn("ICU is installed. Continuing Libation setup.", output)
        self.assertEqual(self.dependency_record.read_text().splitlines(),
                         ["update", "install -y --no-install-recommends libicu74"])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assert_configured()

    def test_declining_linux_icu_leaves_import_disabled(self):
        self.use_linux_without_icu()
        output = self.run_setup(
            [("Install the ICU runtime now? [Y/n]:", "n")],
            ["--libation-path", str(self.cli)])
        self.assertIn("apt-get update && apt-get install -y libicu-dev", output)
        self.assertFalse(self.dependency_record.exists())
        self.assertNotIn("libation_cli_path", self.config.read_text())
        self.assertIn("INSTALLATION_CONTINUES:0", output)

    def test_failed_linux_icu_install_leaves_import_disabled(self):
        self.use_linux_without_icu(install_succeeds=False)
        output = self.run_setup(
            args=["--libation-path", str(self.cli), "--yes"], terminal=False)
        self.assertIn("ICU could not be installed.", output)
        self.assertNotIn("libation_cli_path", self.config.read_text())
        self.assertIn("INSTALLATION_CONTINUES:0", output)

    def test_unattended_upgrade_does_not_install_linux_icu(self):
        self.config.write_text(self.config.read_text() +
                               f"libation_cli_path = {self.cli}\n")
        self.use_linux_without_icu()
        output = self.run_setup(terminal=False)
        self.assertIn("apt-get update && apt-get install -y libicu-dev", output)
        self.assertFalse(self.dependency_record.exists())
        self.assert_configured()
        self.assertIn("INSTALLATION_CONTINUES:0", output)

    def test_skipped_import_stays_off(self):
        original = self.config.read_text()
        for args, responses in ((["--no-libation"], []), ([], [("Set up the Audible import now? [y/N]:", "n")])):
            with self.subTest(args=args):
                output = self.run_setup(responses, args)
                self.assertIn("INSTALLATION_CONTINUES:0", output)
                self.assertEqual(self.config.read_text(), original)
                self.assertFalse(self.settings.exists())

    def test_existing_setup_is_kept_without_questions(self):
        original = self.config.read_text() + f"libation_cli_path = {self.cli}\n"
        self.config.write_text(original)
        self.settings.mkdir()
        for name in ("Settings.json", "AccountsSettings.json"):
            (self.settings / name).write_text('{"preserve":"fixture"}')
        for args in ([], ["--libation"]):
            with self.subTest(args=args):
                output = self.run_setup(args=args)
                self.assertIn("INSTALLATION_CONTINUES:1", output)
                self.assertEqual(self.config.read_text(), original)
                for name in ("Settings.json", "AccountsSettings.json"):
                    self.assertEqual((self.settings / name).read_text(), '{"preserve":"fixture"}')

    def test_settings_failure_continues(self):
        self.settings.write_text("not a directory")
        original = self.config.read_text()
        for existing in (False, True):
            with self.subTest(existing=existing):
                self.config.write_text(original +
                                       (f"libation_cli_path = {self.cli}\n" if existing else ""))
                args = [] if existing else ["--libation-path", str(self.cli)]
                output = self.run_setup(args=args)
                self.assertIn("Could not set up Libation's settings folder", output)
                self.assertIn("INSTALLATION_CONTINUES:0", output)

    def test_upgrade_backfills_missing_settings_without_questions(self):
        self.config.write_text(self.config.read_text() +
                               f"libation_cli_path = {self.cli}\n")
        output = self.run_setup()
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assert_configured()
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o700)
        for name in ("Settings.json", "AccountsSettings.json"):
            self.assertEqual((self.settings / name).read_text(), "{}")
            self.assertEqual((self.settings / name).stat().st_mode & 0o777, 0o600)

    def test_partial_settings_are_preserved_and_missing_accounts_are_private(self):
        self.settings.mkdir()
        (self.settings / "Settings.json").write_text('{"preserve":"fixture"}')
        output = self.run_setup(args=["--libation-path", str(self.cli)])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assertEqual((self.settings / "Settings.json").read_text(), '{"preserve":"fixture"}')
        self.assertEqual((self.settings / "AccountsSettings.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
