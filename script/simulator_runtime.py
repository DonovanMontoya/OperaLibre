"""Select an installed iOS runtime matching the active simulator SDK."""


def select_ios_runtime(runtimes, sdk_version):
    sdk = tuple(int(part) for part in sdk_version.strip().split('.'))
    matches = []
    for runtime in runtimes:
        if not runtime.get('isAvailable') or not runtime['identifier'].startswith(
            'com.apple.CoreSimulator.SimRuntime.iOS-'
        ):
            continue
        version = tuple(int(part) for part in runtime['version'].split('.'))
        if version[:2] == sdk[:2]:
            matches.append((version, runtime))
    if not matches:
        raise ValueError(
            f'Install an available iOS {sdk[0]}.{sdk[1]} Simulator runtime '
            f'for the selected Xcode SDK {sdk_version.strip()}.'
        )
    return max(matches, key=lambda match: match[0])[1]
