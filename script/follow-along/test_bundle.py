from pathlib import Path
import tempfile
import unittest
import bundle
import corpus


class PortableCorpusTests(unittest.TestCase):
    def test_relocation_keeps_absolute_timing_and_detects_changed_clips(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); folder=root/'book';folder.mkdir()
            (folder/'sample.flac').write_bytes(b'owned sample');(folder/'book.epub').write_bytes(b'owned epub')
            corpus.save(root/'plan.json',dict(bundleRoot='/other/machine',books=[dict(id='book',
                epub='/other/machine/book/book.epub',epubSha256=corpus.digest(folder/'book.epub'),
                audio='/other/machine/book/sample.flac',scopeManifest='/other/machine/book/scopes.json',
                sourceAudioSha256='original',scopes=[7],audioSamples={'7':[90000.125,90480.125]},
                audioClips={'7':dict(path='/other/machine/book/sample.flac',start=90000.125,end=90480.125,sha256=corpus.digest(folder/'sample.flac'))})]))
            plan=bundle.relocate(root/'plan.json',root/'local.json');book=plan['books'][0]
            self.assertEqual(book['audioClips']['7']['start'],90000.125)
            self.assertEqual(corpus.audio_fingerprint(book)['audioSha256'],'original')
            book['audioClips']['7']['start']=0
            with self.assertRaisesRegex(ValueError,'bounds'):corpus.audio_fingerprint(book)
            book['audioClips']['7']['start']=90000.125
            (folder/'sample.flac').write_bytes(b'changed audio')
            with self.assertRaisesRegex(ValueError,'changed'):corpus.audio_fingerprint(book)

if __name__=='__main__':unittest.main()
