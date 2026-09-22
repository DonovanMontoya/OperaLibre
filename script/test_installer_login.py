"""Exercise installer sign-in with a fake CLI and a real controlling terminal."""

import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import sys
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


class InstallerLoginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="operalibre-login-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        # Exercise both execution and printed shell commands with special paths.
        self.install = self.root / "Reader's $books `library`"
        self.install.mkdir()
        self.cli = self.install / "Libation CLI"
        self.record = self.root / "calls.jsonl"
        self.cli.write_text(f"#!{sys.executable}\n" + '''
import json, os, sys
from pathlib import Path
with open(os.environ["CALL_RECORD"], "a") as record:
    record.write(json.dumps({"args": sys.argv[1:], "tty": [os.isatty(i) for i in range(3)],
        "cwd": os.getcwd(), "invariant": os.getenv("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT")}) + "\\n")
assert all(os.isatty(i) for i in range(3)), "CLI requires a terminal"
settings = Path(sys.argv[sys.argv.index("--libationFiles") + 1])
assert (settings / "Settings.json").is_file()
assert (settings / "AccountsSettings.json").is_file()
print("Paste URL: ", end="", flush=True)
sys.exit(0 if input() == "ok" else 1)
''')
        self.cli.chmod(0o755)
        self.config = self.install / "server.config"
        self.config.write_text("libation_files_dir = custom settings\n")
        self.env = {**os.environ, "OPERALIBRE_DIR": str(self.install),
                    "OPERALIBRE_LIBATION_PATH": "", "CALL_RECORD": str(self.record),
                    "TEST_CLI": str(self.cli)}
        # Never discover or download a real Libation or read real accounts.
        section = SECTION.replace(function("find_libation"),
                                  'find_libation() { printf "%s" "$TEST_CLI"; }')
        section = section.replace(function("install_libation"),
                                  'install_libation() { LIBATION_PATH=$TEST_CLI; }')
        self.script = self.root / "fixture.sh"
        self.script.write_text(PRELUDE + HELPERS + "\n" + section +
                               '\nsay "INSTALLATION_CONTINUES:$LIBATION_LOGIN_COMPLETE"\n')

    def calls(self):
        return [json.loads(line) for line in self.record.read_text().splitlines()] if self.record.exists() else []

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

    def login_answers(self, url="ok"):
        return [("during setup? [Y/n]:", ""),
                ("Audible email (press Return to skip sign-in) []:", "reader@example.com"),
                ("Audible country code [us]:", "uk"), ("Paste URL:", url)]

    def test_interactive_install_accepts_import_and_logs_in(self):
        output = self.run_setup([
            ("Set up the Audible import now? [y/N]:", "y"), ("Use it? [Y/n]:", ""),
            *self.login_answers()])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assertEqual(self.calls(), [{"args": ["login-external", "--account",
            "reader@example.com", "--locale", "uk", "--libationFiles",
            str(self.install / "custom settings")], "tty": [True, True, True],
            "cwd": str(self.install), "invariant": "1"}])

    def test_download_then_login(self):
        output = self.run_setup([("Use it? [Y/n]:", "n"),
            ("Download Libation from its official GitHub release? [Y/n]:", ""),
            *self.login_answers()], ["--libation"])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assertEqual(len(self.calls()), 1)

    def test_decline_login_prints_safe_command(self):
        output = self.run_setup([("during setup? [Y/n]:", "n")],
                                ["--libation-path", str(self.cli)])
        self.assertFalse(self.calls())
        self.assertIn("INSTALLATION_CONTINUES:0", output)
        command = next(line.strip() for line in output.splitlines()
                       if line.startswith("  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT="))
        # Execute the emitted command with a capturing shim to verify shell
        # quoting, including $, backticks and apostrophes in configured paths.
        self.cli.write_text('#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n')
        result = subprocess.check_output(["sh", "-c", command], text=True)
        self.assertEqual(result.splitlines(), [str(self.cli), "login-external", "--account",
            "YOUR_EMAIL", "--locale", "us", "--libationFiles", str(self.install / "custom settings")])

    def test_blank_email_skips(self):
        output = self.run_setup(self.login_answers()[:1] +
            [("Audible email (press Return to skip sign-in) []:", "")],
            ["--libation-path", str(self.cli)])
        self.assertFalse(self.calls())
        self.assertIn("INSTALLATION_CONTINUES:0", output)

    def test_cancelled_cli_can_continue_or_retry(self):
        for retry in (False, True):
            with self.subTest(retry=retry):
                self.record.unlink(missing_ok=True)
                responses = self.login_answers("") + [("Try signing in again? [y/N]:", "y" if retry else "n")]
                if retry:
                    responses += self.login_answers()[1:]
                output = self.run_setup(responses, ["--libation-path", str(self.cli)])
                self.assertIn(f"INSTALLATION_CONTINUES:{int(retry)}", output)
                self.assertEqual(len(self.calls()), 2 if retry else 1)

    def test_unattended_install_never_logs_in(self):
        for terminal, options in ((True, ["--yes"]), (False, [])):
            with self.subTest(terminal=terminal):
                output = self.run_setup(args=["--libation-path", str(self.cli), *options], terminal=terminal)
                self.assertNotIn("during setup?", output)
                self.assertIn("YOUR_EMAIL", output)
                self.assertIn("INSTALLATION_CONTINUES:0", output)
                self.assertFalse(self.calls())

    def test_skip_import_never_offers_login(self):
        for args, responses in ((["--no-libation"], []), ([], [("Set up the Audible import now? [y/N]:", "n")])):
            with self.subTest(args=args):
                output = self.run_setup(responses, args)
                self.assertNotIn("during setup?", output)
                self.assertFalse(self.calls())

    def test_existing_config_only_prompts_when_explicitly_requested(self):
        original = self.config.read_text() + f"libation_cli_path = {self.cli}\n"
        self.config.write_text(original)
        settings = self.install / "custom settings"
        settings.mkdir()
        for name in ("Settings.json", "AccountsSettings.json"):
            (settings / name).write_text('{"preserve":"fixture"}')
        output = self.run_setup()
        self.assertNotIn("during setup?", output)
        self.assertFalse(self.calls())
        output = self.run_setup(self.login_answers(), ["--libation"])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assertEqual(self.config.read_text(), original)
        for name in ("Settings.json", "AccountsSettings.json"):
            self.assertEqual((settings / name).read_text(), '{"preserve":"fixture"}')

    def test_settings_failure_skips_login_and_continues(self):
        (self.install / "custom settings").write_text("not a directory")
        output = self.run_setup(args=["--libation-path", str(self.cli)])
        self.assertIn("Could not set up Libation's settings folder", output)
        self.assertIn("INSTALLATION_CONTINUES:0", output)
        self.assertNotIn("during setup?", output)
        self.assertFalse(self.calls())

    def test_partial_settings_are_preserved_and_missing_accounts_are_private(self):
        settings = self.install / "custom settings"
        settings.mkdir()
        (settings / "Settings.json").write_text('{"preserve":"fixture"}')
        output = self.run_setup(self.login_answers(), ["--libation-path", str(self.cli)])
        self.assertIn("INSTALLATION_CONTINUES:1", output)
        self.assertEqual((settings / "Settings.json").read_text(), '{"preserve":"fixture"}')
        self.assertEqual((settings / "AccountsSettings.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
