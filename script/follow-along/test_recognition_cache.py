from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RecognitionReplayTests(unittest.TestCase):
    def test_exact_inputs_replay_but_changed_audio_options_and_runtime_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); cli=root/'cli'; audio=root/'audio.wav'; identity=root/'identity'
            cli.write_text('#!/usr/bin/env python3\nimport pathlib,sys,json\np=pathlib.Path(__file__).with_name("calls")\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\npathlib.Path(sys.argv[3]).write_text(json.dumps({"call":n}))\n')
            cli.chmod(0o700); audio.write_bytes(b'first audio'); identity.write_text('pinned runtime')
            def run(mode='replay',model='base.en',name='output.json'):
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('recognition_cache.py')),
                    '--cli',str(cli),'--identity',str(identity),'--cache',str(root/'cache'),'--mode',mode,
                    '--','transcribe',str(audio),str(root/name),'--engine=whisper','--whisper.model='+model],capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr)
                return (root/name).read_text()
            first=run('record'); self.assertEqual(run(name='another.json'),first)
            self.assertEqual((root/'calls').read_text(),'1')
            self.assertNotEqual(run('record'),first)  # Fresh weekly runs never use cached recognition.
            self.assertEqual(run(),first)  # First output remains immutable.
            audio.write_bytes(b'different audio'); self.assertNotEqual(run(),first)
            self.assertEqual((root/'calls').read_text(),'3')
            run(model='small.en'); self.assertEqual((root/'calls').read_text(),'4')
            identity.write_text('new runtime'); run(); self.assertEqual((root/'calls').read_text(),'5')
            self.assertEqual(next((root/'cache').iterdir()).stat().st_mode & 0o077,0)

    def test_failed_recognition_is_never_replayed_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); cli=root/'cli'; audio=root/'audio.wav'; identity=root/'identity'
            cli.write_text('#!/bin/sh\nexit 7\n'); cli.chmod(0o700)
            audio.write_bytes(b'audio'); identity.write_text('pinned runtime')
            result=subprocess.run([sys.executable,str(Path(__file__).with_name('recognition_cache.py')),
                '--cli',str(cli),'--identity',str(identity),'--cache',str(root/'cache'),'--mode','replay',
                '--','transcribe',str(audio),str(root/'output.json')],capture_output=True)
            self.assertEqual(result.returncode,7)
            self.assertEqual(list((root/'cache').iterdir()),[])

if __name__=='__main__': unittest.main()
