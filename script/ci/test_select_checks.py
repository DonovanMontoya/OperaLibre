import unittest
from select_checks import CHECKS, select


class SelectionTests(unittest.TestCase):
    def test_docs_only(self):
        self.assertEqual(select(['docs/api.md', 'README.md']), set())

    def test_unknown_and_shared_inputs_fail_open(self):
        for path in ['new-area/file', 'package-lock.json', 'script/test_car_artwork.py', '.github/workflows/ci.yml']:
            with self.subTest(path=path):
                self.assertEqual(select([path]), CHECKS)

    def test_server_contract_and_playback(self):
        self.assertTrue({'server', 'server_windows', 'bookplayer', 'playback', 'web'} <= select(['apps/server/src/http.rs']))

    def test_web_reaches_packaged_android(self):
        self.assertEqual(select(['apps/web/src/App.tsx']), {'web', 'playback', 'android'})

    def test_native_checks_remain_separate(self):
        self.assertEqual(select(['apps/web/ios/App/App/CarLibrary.swift']), {'apple', 'carplay', 'web'})
        self.assertEqual(select(['apps/macos/Sources/App.swift']), {'apple'})

    def test_mixed_changes_union_coverage(self):
        self.assertEqual(select(['docs/api.md', 'apps/launcher/src/main.rs', 'apps/web/src/App.tsx']), {'launcher', 'web', 'playback', 'android'})
