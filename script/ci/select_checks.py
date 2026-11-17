"""Select PR checks conservatively; main and unfamiliar paths run everything."""
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

CHECKS = {'server', 'server_windows', 'launcher', 'web', 'playback', 'android',
          'apple', 'carplay', 'bookplayer'}
VERSION_FILES = {
    f'apps/{component}/Cargo.{extension}': f'operalibre-{component}'
    for component in ('server', 'launcher') for extension in ('toml', 'lock')
}


def select(paths):
    selected = set()
    for path in paths:
        if path.startswith('docs/') or path in {'README.md', 'CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE.md', 'REVIEW.md'}:
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


def only_package_version(path, before, after):
    """Ignore our own stable version, never dependency versions or other fields."""
    if path not in VERSION_FILES:
        return False
    documents = []
    for content in (before, after):
        try:
            document = tomllib.loads(content)
            packages = document['package']
            if path.endswith('.toml'):
                packages = [packages]
            own = [package for package in packages if package['name'] == VERSION_FILES[path]]
            if len(own) != 1 or not re.fullmatch(r'(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}', own[0]['version']):
                return False
            del own[0]['version']
            documents.append(json.dumps(document, sort_keys=True))
        except (ValueError, KeyError, TypeError):
            return False
    return documents[0] == documents[1]


def select_revision(base, head):
    # Match the PR's three-dot diff, including when its base has moved ahead.
    ancestor = subprocess.check_output(['git', 'merge-base', base, head]).decode().strip()
    paths = subprocess.check_output([
        'git', 'diff', '--name-only', '--no-renames', '-z', ancestor, head,
    ]).decode().split('\0')
    relevant = []
    for path in filter(None, paths):
        if path in VERSION_FILES:
            try:
                before, after = [subprocess.check_output(
                    ['git', 'show', f'{revision}:{path}'], stderr=subprocess.DEVNULL,
                ).decode() for revision in (ancestor, head)]
            except subprocess.CalledProcessError:
                pass  # Added or deleted manifests still need their normal checks.
            else:
                if only_package_version(path, before, after):
                    continue
        relevant.append(path)
    return select(relevant)


if __name__ == '__main__':
    if os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
        selected = select_revision(os.environ['BASE_SHA'], os.environ['HEAD_SHA'])
    else:
        selected = CHECKS
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        for check in sorted(CHECKS):
            output.write(f'{check}={str(check in selected).lower()}\n')
        output.write(f'metadata_only={str(not selected).lower()}\n')
