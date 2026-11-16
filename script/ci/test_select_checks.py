import unittest
from select_checks import CHECKS, VERSION_FILES, only_package_version, select


class SelectionTests(unittest.TestCase):
    def test_docs_only(self):
        self.assertEqual(select(['docs/api.md', 'README.md', 'CHANGELOG.md']), set())

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

    def test_changelog_does_not_hide_code_changes(self):
        self.assertEqual(select(['CHANGELOG.md', 'apps/web/src/App.tsx']), {'web', 'playback', 'android'})


class PackageVersionTests(unittest.TestCase):
    def fixture(self, path, name):
        if path.endswith('.toml'):
            return (f'[package]\nname = "{name}"\nversion = "0.5.4"\n'
                    'edition = "2024"\nautobins = true\n[dependencies]\nexample = "1.0"\n')
        return ('version = 4\n[[package]]\nname = "example"\nversion = "1.0.0"\n'
                'checksum = "original"\n[[package]]\n'
                f'name = "{name}"\nversion = "0.5.4"\ndependencies = ["example"]\n')

    def test_own_stable_version_only(self):
        for path, name in VERSION_FILES.items():
            with self.subTest(path=path):
                before = self.fixture(path, name)
                after = before.replace('"0.5.4"', '"0.5.5"')
                self.assertTrue(only_package_version(path, before, after))

    def test_dependency_and_build_changes_still_need_checks(self):
        for path, name in VERSION_FILES.items():
            before = self.fixture(path, name)
            version_bump = before.replace('"0.5.4"', '"0.5.5"')
            if path.endswith('.toml'):
                changes = [('"1.0"', '"2.0"'), ('"2024"', '"2021"'),
                           ('autobins = true', 'autobins = 1'),
                           ('[dependencies]', '[build-dependencies]')]
            else:
                changes = [('"1.0.0"', '"2.0.0"'), ('"original"', '"changed"'),
                           ('["example"]', '[]'), ('version = 4', 'version = 3')]
            for old, new in changes:
                with self.subTest(path=path, change=old):
                    self.assertFalse(only_package_version(path, before, version_bump.replace(old, new)))

    def test_unrecognized_or_malformed_versions_still_need_checks(self):
        path = 'apps/server/Cargo.toml'
        before = self.fixture(path, 'operalibre-server')
        for after in ['', 'invalid TOML', before.replace('0.5.4', '0.5.5-nightly.1'),
                      before.replace('version = "0.5.4"', ''),
                      before.replace('operalibre-server', 'other-package')]:
            with self.subTest(after=after):
                self.assertFalse(only_package_version(path, before, after))
        self.assertFalse(only_package_version('other/Cargo.toml', before, before))

    def test_lockfile_must_have_exactly_one_own_package(self):
        path = 'apps/launcher/Cargo.lock'
        before = self.fixture(path, 'operalibre-launcher')
        for after in [before.replace('operalibre-launcher', 'other-package'),
                      before + '[[package]]\nname = "operalibre-launcher"\nversion = "0.5.5"\n']:
            with self.subTest(after=after):
                self.assertFalse(only_package_version(path, before, after))
