import fcntl
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

import corpus
import worker


class ScheduledWorkerTests(unittest.TestCase):
    def test_tracking_waits_for_merge_then_freezes_and_installs_revision_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'source-cache.git').mkdir()
            minimum='a'*40; revision='b'*40
            config=dict(source='bootstrap',cli='bootstrap-cli',sourceTracking=dict(repository='trusted-repo',ref='main',minimumRevision=minimum))
            def pending(command,**kwargs):
                return subprocess.CompletedProcess(command,128 if 'cat-file' in command else 0)
            with patch.object(worker.subprocess,'run',side_effect=pending),patch.object(worker.subprocess,'check_output',return_value=revision+'\n'):
                selected,receipt=worker.refresh_source(config,root,os.environ.copy())
            self.assertEqual(selected,config)
            self.assertEqual(receipt['mode'],'awaiting-merge')
            self.assertFalse((root/'sources').exists())
            data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w') as archive:
                for path in ['addons/readalong-sync/package.json','script/follow-along/verify.py']:
                    content=b'fixture';info=tarfile.TarInfo(path);info.size=len(content);archive.addfile(info,io.BytesIO(content))
            def output(command,**kwargs): return data.getvalue() if 'archive' in command else revision+'\n'
            with patch.object(worker.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run,patch.object(worker.subprocess,'check_output',side_effect=output):
                selected,receipt=worker.refresh_source(config,root,os.environ.copy())
                again,_=worker.refresh_source(config,root,os.environ.copy())
            self.assertEqual(receipt['mode'],'tracked')
            self.assertEqual(selected,again)
            self.assertEqual(Path(selected['source']).name,revision)
            self.assertEqual((Path(selected['source'])/'script/follow-along/verify.py').read_text(),'fixture')
            npm=[c.args[0] for c in run.call_args_list if c.args[0][0]=='npm']
            self.assertEqual([c[1] for c in npm],['ci','test'])

    def test_tracking_fetch_failure_does_not_claim_the_old_source_is_current(self):
        with tempfile.TemporaryDirectory() as directory:
            config=dict(source='bootstrap',sourceTracking=dict(repository='missing',minimumRevision='a'*40))
            with patch.object(worker.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['git','fetch'])):
                with self.assertRaises(subprocess.CalledProcessError):
                    worker.refresh_source(config,Path(directory),os.environ.copy())

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

    def test_edition_suite_runs_after_primary_failure_without_hiding_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'source/script/follow-along'; source.mkdir(parents=True)
            (source/'verify.py').write_text("import sys\nraise SystemExit(2 if sys.argv[sys.argv.index('--plan')+1]=='primary' else 0)\n")
            corpus.save(root/'worker.json',dict(source=str(root/'source'),plan='primary',cli='fixture',
                        additionalSuites=[dict(name='alternate-edition',plan='variant',reference='frozen-reference')]))
            result=subprocess.run([sys.executable,str(Path(__file__).with_name('worker.py')),'--config',str(root/'worker.json')],capture_output=True)
            self.assertEqual(result.returncode,2)
            report=corpus.load(root/'latest-scheduled.json')
            self.assertEqual(report['status'],'needs-review')
            self.assertEqual([s['status'] for s in report['suites']],['needs-review','passed'])
            self.assertEqual([Path(s['output']).name for s in report['suites']],['library','alternate-edition'])

    def test_existing_run_lock_prevents_a_second_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); corpus.save(root/'worker.json',{})
            with (root/'library-worker.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('worker.py')),'--config',str(root/'worker.json')],capture_output=True)
                self.assertEqual(result.returncode,0)
                self.assertFalse((root/'latest-scheduled.json').exists())

if __name__=='__main__': unittest.main()
