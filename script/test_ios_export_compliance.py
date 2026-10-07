import plistlib
from pathlib import Path
import subprocess
import tempfile
import unittest


CHECK = Path(__file__).with_name("check_ios_export_compliance.sh")
KEY = "ITSAppUsesNonExemptEncryption"


class ExportComplianceTests(unittest.TestCase):
    def check(self, declaration, fmt):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Info.plist"
            path.write_bytes(plistlib.dumps(declaration, fmt=fmt))
            return subprocess.run(
                ["sh", str(CHECK), str(path)], capture_output=True, text=True
            )

    def test_boolean_false_in_source_and_processed_plists(self):
        for fmt in (plistlib.FMT_XML, plistlib.FMT_BINARY):
            with self.subTest(fmt=fmt):
                self.assertEqual(self.check({KEY: False}, fmt).returncode, 0)

    def test_rejects_missing_misspelled_nonexempt_and_wrong_type(self):
        for declaration in ({}, {"ITSAppUsesNonExchangeEncryption": False},
                            {KEY: True}, {KEY: "false"}, {KEY: 0}):
            for fmt in (plistlib.FMT_XML, plistlib.FMT_BINARY):
                with self.subTest(declaration=declaration, fmt=fmt):
                    result = self.check(declaration, fmt)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("error:", result.stderr)

    def test_rejects_missing_file(self):
        result = subprocess.run(
            ["sh", str(CHECK), "/nonexistent/Info.plist"], capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
