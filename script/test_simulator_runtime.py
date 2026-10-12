import unittest

from simulator_runtime import select_ios_runtime


def runtime(version, available=True, platform='iOS'):
    return {
        'identifier': f'com.apple.CoreSimulator.SimRuntime.{platform}-{version.replace(".", "-")}',
        'version': version,
        'isAvailable': available,
    }


class SimulatorRuntimeTests(unittest.TestCase):
    def test_matching_sdk_wins_over_newer_runtime_in_any_order(self):
        matching = runtime('18.5')
        runtimes = [runtime('18.4'), matching, runtime('26.2')]
        for candidates in (runtimes, list(reversed(runtimes))):
            with self.subTest(candidates=candidates):
                self.assertIs(select_ios_runtime(candidates, '18.5\n'), matching)

    def test_patch_runtime_matches_and_newest_patch_wins(self):
        matching = runtime('18.5.1')
        self.assertIs(
            select_ios_runtime([matching, runtime('18.5')], '18.5'), matching
        )

    def test_unavailable_absent_and_other_platform_runtimes_fail_clearly(self):
        for candidates in ([], [runtime('18.5', available=False)],
                           [runtime('26.2')], [runtime('18.5', platform='tvOS')]):
            with self.subTest(candidates=candidates):
                with self.assertRaisesRegex(ValueError, 'iOS 18.5 Simulator runtime'):
                    select_ios_runtime(candidates, '18.5')


if __name__ == '__main__':
    unittest.main()
