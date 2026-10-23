"""Install the Git-pinned worker unarmed. Default: read-only --check.

No API calls, tokens, inference, enable/start/restart or BigWin file writes.
Run from the deployed API checkout, with --install --expected-commit <HEAD>.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


SERVICE = 'wintips-editorial-worker.service'
TIMER = 'wintips-editorial-worker.timer'
WORKER_PATH = 'tools/wintips-editorial-worker'


class InstallRejected(RuntimeError):
    pass


@dataclass(frozen=True)
class Paths:
    worker: Path
    environment: Path = Path('/etc/wintips-editorial-worker.env')
    state: Path = Path('/var/lib/wintips-editorial-worker')
    units: Path = Path('/etc/systemd/system')


def command(argv):
    # Never return command stderr, environment values or response bodies.
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=40, check=False)
    return result.returncode, result.stdout.strip()


def git_identity(paths, expected_commit=None, execute=command):
    api = paths.worker.resolve().parents[1]
    rc, root = execute(['git', '-C', str(api), 'rev-parse', '--show-toplevel'])
    if rc or Path(root).resolve() != api:
        raise InstallRejected('api_git_checkout_required')
    rc, sha = execute(['git', '-C', str(api), 'rev-parse', 'HEAD'])
    if rc or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise InstallRejected('valid_git_head_required')
    if expected_commit is not None and sha != expected_commit:
        raise InstallRejected('git_head_does_not_match_reviewed_commit')
    # A historical dirty yarn.lock elsewhere in the API is intentionally neither
    # overwritten nor rejected. This worker must be clean, including untracked
    # source files (normal Git-ignored caches remain ignored).
    rc, status = execute(['git', '-C', str(api), 'status', '--porcelain',
                          '--untracked-files=all', '--', WORKER_PATH])
    if rc or status:
        raise InstallRejected('committed_clean_worker_required')
    for relative in ['deploy/install.py', 'deploy/environment.example',
                     'deploy/' + SERVICE + '.example', 'deploy/' + TIMER + '.example',
                     'editorial_worker/runner.py', 'editorial_worker/model_runtime.py']:
        rc, _ = execute(['git', '-C', str(api), 'ls-files', '--error-unmatch',
                         WORKER_PATH + '/' + relative])
        if rc:
            raise InstallRejected('worker_templates_must_be_git_tracked')
    return sha


def regular_private(path, *, directory=False):
    """Inspect metadata only; never read an existing credential file."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(info.st_mode) or info.st_uid != 0:
        raise InstallRejected('unsafe_install_target')
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise InstallRejected('existing_private_target_permissions_too_open')
    return True


def unit_target(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
        raise InstallRejected('unsafe_unit_target')


def require_unarmed(execute):
    for unit in (SERVICE, TIMER):
        rc, state = execute(['/usr/bin/systemctl', 'is-active', unit])
        if state not in {'inactive', 'failed', 'unknown', ''} or rc not in {3, 4}:
            raise InstallRejected('stop_wintips_worker_before_install')
    rc, enabled = execute(['/usr/bin/systemctl', 'is-enabled', TIMER])
    if enabled not in {'disabled', 'static', 'indirect', 'not-found', ''} or rc not in {1, 4}:
        raise InstallRejected('disable_wintips_timer_before_install')


def rendered_units(paths):
    if any(c in str(paths.worker) for c in '\n\r%'):
        raise InstallRejected('unsafe_worker_path')
    result = {}
    for name in (SERVICE, TIMER):
        source = paths.worker / 'deploy' / (name + '.example')
        if source.is_symlink() or not source.is_file():
            raise InstallRejected('regular_committed_template_required')
        content = source.read_text('utf-8')
        content = content.replace('/var/www/wintips/api/tools/wintips-editorial-worker', str(paths.worker))
        if name == SERVICE and ('--dry-run --translate' not in content or '--publish' in next(
                (line for line in content.splitlines() if line.startswith('ExecStart=')), '')):
            raise InstallRejected('installation_must_remain_preview_only')
        if name == TIMER and 'Persistent=false' not in content:
            raise InstallRejected('late_timer_catchup_forbidden')
        result[name] = content
    return result


def atomic_unit(path, content):
    # The containing directory must be root-owned, never an attacker directory.
    unit_target(path)
    if path.exists() and path.read_text('utf-8') == content:
        return False
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        unit_target(path)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def install(paths, *, apply=False, expected_commit=None, execute=command):
    if apply and (sys.platform != 'linux' or os.geteuid() != 0):
        raise InstallRejected('linux_root_installation_required')
    if apply and not (isinstance(expected_commit, str) and re.fullmatch(r'[a-f0-9]{40}', expected_commit)):
        raise InstallRejected('explicit_reviewed_commit_required')
    sha = git_identity(paths, expected_commit, execute)
    require_unarmed(execute)
    units = rendered_units(paths)
    env_exists = regular_private(paths.environment)
    state_exists = regular_private(paths.state, directory=True)
    # Parent paths are fixed by the production CLI. Test paths remain injectable.
    for parent in (paths.environment.parent, paths.state.parent, paths.units):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise InstallRejected('root_owned_nonwritable_parent_required')
    for name in units:
        unit_target(paths.units / name)
    report = {'mode': 'install_unarmed' if apply else 'check_only', 'gitCommit': sha,
              'environmentExists': env_exists, 'environmentPreserved': env_exists,
              'stateExists': state_exists, 'timerArmed': False, 'serviceStarted': False,
              'publicationEnabled': False, 'notificationsSent': False}
    if not apply:
        return report
    # Verify rendered names before any persistent installation. No service runs.
    with tempfile.TemporaryDirectory(prefix='wintips-editorial-units-') as temporary:
        files = []
        for name, content in units.items():
            target = Path(temporary) / name
            target.write_text(content, 'utf-8')
            files.append(str(target))
        rc, _ = execute(['/usr/bin/systemd-analyze', 'verify', *files])
        if rc:
            raise InstallRejected('systemd_unit_validation_failed')
    if not state_exists:
        paths.state.mkdir(mode=0o700)
    if not env_exists:
        # Placeholder only. Token provisioning/synchronization is a separate
        # operator action. O_EXCL prevents replacing a concurrently created file.
        try:
            fd = os.open(paths.environment, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            regular_private(paths.environment)
            report['environmentPreserved'] = True
        else:
            with os.fdopen(fd, 'wb') as handle:
                handle.write((paths.worker / 'deploy/environment.example').read_bytes())
    changed = [name for name, content in units.items() if atomic_unit(paths.units / name, content)]
    if changed:
        rc, _ = execute(['/usr/bin/systemctl', 'daemon-reload'])
        if rc:
            raise InstallRejected('systemd_reload_failed')
    require_unarmed(execute)
    report['changedUnits'] = changed
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Default: metadata/configuration checks only')
    mode.add_argument('--install', action='store_true', help='Install preview-only units; never arm or run')
    parser.add_argument('--expected-commit', help='Reviewed full API Git HEAD; required for --install')
    args = parser.parse_args(argv)
    paths = Paths(Path(__file__).resolve().parents[1])
    try:
        result = install(paths, apply=args.install, expected_commit=args.expected_commit)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (InstallRejected, OSError, subprocess.SubprocessError) as exc:
        # Do not disclose the contents of any existing environment/secret file.
        reason = str(exc) if isinstance(exc, InstallRejected) else type(exc).__name__
        print(json.dumps({'status': 'installation_rejected', 'reason': reason, 'armed': False,
                          'serviceStarted': False, 'notificationsSent': False}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
