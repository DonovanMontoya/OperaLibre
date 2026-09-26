import fcntl
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import corpus


class ScheduledWorkerTests(unittest.TestCase):
    def test_failed_library_run_remains_failed_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'source/script/follow-along'; source.mkdir(parents=True)
            (source/'verify.py').write_text('raise SystemExit(3)\n')
            corpus.save(root/'worker.json',dict(source=str(root/'source'),plan='fixture',cli='fixture'))
            result=subprocess.run([sys.executable,str(Path(__file__).with_name('worker.py')),'--config',str(root/'worker.json')],capture_output=True)
            self.assertEqual(result.returncode,3)
            report=corpus.load(root/'latest-scheduled.json')
            self.assertEqual(report['status'],'needs-review')
            self.assertEqual(report['exitCode'],3)
            self.assertEqual((root/'latest-scheduled.json').stat().st_mode & 0o077,0)

    def test_existing_run_lock_prevents_a_second_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); corpus.save(root/'worker.json',{})
            with (root/'library-worker.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('worker.py')),'--config',str(root/'worker.json')],capture_output=True)
                self.assertEqual(result.returncode,0)
                self.assertFalse((root/'latest-scheduled.json').exists())

if __name__=='__main__': unittest.main()
