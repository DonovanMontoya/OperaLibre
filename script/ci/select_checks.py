"""Select PR checks conservatively; main and unfamiliar paths run everything."""
import os
from pathlib import Path
import subprocess

CHECKS = {'server', 'server_windows', 'launcher', 'web', 'playback', 'android',
          'apple', 'carplay', 'bookplayer'}


def select(paths):
    selected = set()
    for path in paths:
        if path.startswith('docs/') or path in {'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE.md', 'REVIEW.md'}:
            continue
        if path.startswith('apps/server/'):
            selected.update({'server', 'server_windows', 'playback', 'bookplayer', 'web'})
        elif path.startswith('apps/launcher/'):
            selected.update({'launcher', 'web'})
        elif path.startswith('apps/web/ios/'):
            selected.update({'apple', 'carplay', 'web'})
        elif path.startswith('apps/web/android/'):
            selected.update({'android', 'web'})
        elif path.startswith('apps/web/'):
            selected.update({'web', 'playback', 'android'})
        elif path.startswith('apps/macos/') or path in {'Package.swift', 'Package.resolved'}:
            selected.add('apple')
        else:
            # Scripts, manifests, release assets and new areas can affect multiple
            # consumers. Opt out only after their dependencies are understood.
            return CHECKS.copy()
    return selected


if __name__ == '__main__':
    if os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
        paths = subprocess.check_output([
            'git', 'diff', '--name-only', '--no-renames', '-z',
            os.environ['BASE_SHA'] + '...' + os.environ['HEAD_SHA'],
        ]).decode().split('\0')
        selected = select(filter(None, paths))
    else:
        selected = CHECKS
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        for check in sorted(CHECKS):
            output.write(f'{check}={str(check in selected).lower()}\n')
