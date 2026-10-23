"""Isolated installer tests. No real systemd, Git mutation or credential use."""
from contextlib import ExitStack
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'deploy'
SPEC = importlib.util.spec_from_file_location('wintips_unarmed_installer', SOURCE / 'install.py')
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)
SHA = 'a' * 40


class FakeCommands:
    def __init__(self, api):
        self.api = api
        self.calls = []
        self.dirty_worker = False
        self.active = False
        self.enabled = False
        self.verify_failed = False
        self.untracked_template = False
        self.untracked_source = False

    def __call__(self, argv):
        self.calls.append(argv)
        if argv[0] == 'git':
            if argv[-1] == '--show-toplevel':
                return 0, str(self.api)
            if argv[-1] == 'HEAD':
                return 0, SHA
            if 'status' in argv:
                # Historical dirty API yarn.lock is outside the worker path.
                assert argv[-1] == installer.WORKER_PATH
                assert '--untracked-files=all' in argv
                if self.untracked_source:
                    return 0, '?? tools/wintips-editorial-worker/sitecustomize.py'
                return 0, ' M tools/wintips-editorial-worker/x.py' if self.dirty_worker else ''
            if 'ls-files' in argv:
                return (1, '') if self.untracked_template else (0, argv[-1])
        if 'systemd-analyze' in argv[0]:
            return (1, '') if self.verify_failed else (0, '')
        if argv[1] == 'is-active':
            return (0, 'active') if self.active else (3, 'inactive')
        if argv[1] == 'is-enabled':
            return (0, 'enabled') if self.enabled else (1, 'disabled')
        if argv[1] == 'daemon-reload':
            return 0, ''
        raise AssertionError('Unexpected command: ' + repr(argv))


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        api = self.root / 'api'
        worker = api / 'tools/wintips-editorial-worker'
        (worker / 'deploy').mkdir(parents=True)
        for source in SOURCE.glob('*.example'):
            shutil.copyfile(source, worker / 'deploy' / source.name)
        config = self.root / 'etc'
        units = config / 'systemd/system'
        units.mkdir(parents=True)
        varlib = self.root / 'var/lib'
        varlib.mkdir(parents=True)
        self.paths = installer.Paths(worker, config / 'wintips-editorial-worker.env', varlib / 'wintips-editorial-worker', units)
        self.commands = FakeCommands(api.resolve())
        self.mode_overrides = {}
        original = Path.lstat
        def metadata(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            # Windows cannot represent POSIX owner/mode semantics. Model only
            # lstat metadata; file contents and all installation I/O stay real.
            mode = stat.S_IFDIR | 0o700 if stat.S_ISDIR(info.st_mode) else stat.S_IFREG | (0o600 if path == self.paths.environment else 0o644)
            return SimpleNamespace(st_uid=0, st_mode=self.mode_overrides.get(str(path), mode))
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(Path, 'lstat', metadata))
        self.stack.enter_context(patch.object(installer.sys, 'platform', 'linux'))
        self.stack.enter_context(patch.object(installer.os, 'geteuid', lambda: 0, create=True))

    def install(self, **kwargs):
        return installer.install(self.paths, execute=self.commands, **kwargs)

    def assert_unarmed(self):
        actions = [call[1] for call in self.commands.calls if 'systemctl' in call[0]]
        self.assertTrue(set(actions) <= {'is-active', 'is-enabled', 'daemon-reload'})
        for action in ('start', 'stop', 'enable', 'disable', 'restart'):
            self.assertNotIn(action, actions)

    def test_check_is_default_read_only_and_ignores_unrelated_dirty_lockfile(self):
        report = self.install()
        self.assertEqual(report['mode'], 'check_only')
        self.assertFalse(self.paths.environment.exists())
        self.assertFalse(self.paths.state.exists())
        self.assertEqual(list(self.paths.units.iterdir()), [])
        self.assert_unarmed()

    def test_install_is_preview_only_idempotent_and_never_overwrites_secret(self):
        marker = b'WINTIPS_EDITORIAL_WORKER_TOKEN=unit-test-marker-never-real\n'
        self.paths.environment.write_bytes(marker)
        original_read = Path.read_bytes
        original_text = Path.read_text
        def guarded_read(path, *args, **kwargs):
            if path == self.paths.environment:
                raise AssertionError('Existing secret file must not be read')
            return original_read(path, *args, **kwargs)
        def guarded_text(path, *args, **kwargs):
            if path == self.paths.environment:
                raise AssertionError('Existing secret file must not be read')
            return original_text(path, *args, **kwargs)
        with patch.object(Path, 'read_bytes', guarded_read), patch.object(Path, 'read_text', guarded_text):
            first = self.install(apply=True, expected_commit=SHA)
            second = self.install(apply=True, expected_commit=SHA)
        self.assertEqual(self.paths.environment.read_bytes(), marker)
        self.assertTrue(first['environmentPreserved'])
        self.assertEqual(set(first['changedUnits']), {installer.SERVICE, installer.TIMER})
        self.assertEqual(second['changedUnits'], [])
        self.assertEqual(sum(call[1:] == ['daemon-reload'] for call in self.commands.calls), 1)
        service = (self.paths.units / installer.SERVICE).read_text('utf-8')
        timer = (self.paths.units / installer.TIMER).read_text('utf-8')
        self.assertIn('--dry-run --translate', service)
        self.assertIn('StateDirectoryMode=0700', service)
        self.assertIn('Persistent=false', timer)
        self.assertNotIn('unit-test-marker', json.dumps([first, second]))
        self.assert_unarmed()

    def test_missing_env_created_as_placeholder_never_a_token(self):
        result = self.install(apply=True, expected_commit=SHA)
        content = self.paths.environment.read_text('utf-8')
        self.assertIn('WINTIPS_EDITORIAL_WORKER_TOKEN=\n', content)
        self.assertFalse(result['environmentPreserved'])
        self.assert_unarmed()

    def test_expected_head_and_clean_tracked_worker_required_before_writes(self):
        cases = [('missing', None), ('wrong', 'b' * 40), ('dirty', SHA), ('untracked', SHA)]
        for name, sha in cases:
            with self.subTest(case=name):
                self.commands.dirty_worker = name == 'dirty'
                self.commands.untracked_template = name == 'untracked'
                with self.assertRaises(installer.InstallRejected):
                    self.install(apply=True, expected_commit=sha)
                self.assertFalse(self.paths.environment.exists())
                self.assertFalse(self.paths.state.exists())

    def test_active_service_or_enabled_timer_prevents_any_installation(self):
        for active, enabled in ((True, False), (False, True)):
            with self.subTest(active=active, enabled=enabled):
                self.commands.active, self.commands.enabled = active, enabled
                with self.assertRaises(installer.InstallRejected):
                    self.install(apply=True, expected_commit=SHA)
                self.assertEqual(list(self.paths.units.iterdir()), [])
                self.assertFalse(self.paths.environment.exists())

    def test_untracked_worker_source_is_rejected_even_with_matching_git_head(self):
        self.commands.untracked_source = True
        with self.assertRaises(installer.InstallRejected):
            self.install(apply=True, expected_commit=SHA)
        self.assertEqual(list(self.paths.units.iterdir()), [])
        self.assertFalse(self.paths.environment.exists())

    def test_unsafe_existing_environment_is_not_read_chmodded_or_replaced(self):
        self.paths.environment.write_bytes(b'placeholder-only')
        for mode in (stat.S_IFREG | 0o644, stat.S_IFLNK | 0o600):
            with self.subTest(mode=mode):
                self.mode_overrides[str(self.paths.environment)] = mode
                with self.assertRaises(installer.InstallRejected):
                    self.install(apply=True, expected_commit=SHA)
                self.assertEqual(self.paths.environment.read_bytes(), b'placeholder-only')
                self.assertEqual(list(self.paths.units.iterdir()), [])

    def test_systemd_validation_failure_writes_no_persistent_files(self):
        self.commands.verify_failed = True
        with self.assertRaises(installer.InstallRejected):
            self.install(apply=True, expected_commit=SHA)
        self.assertFalse(self.paths.environment.exists())
        self.assertFalse(self.paths.state.exists())
        self.assertEqual(list(self.paths.units.iterdir()), [])

    def test_preview_policy_and_timer_catchup_cannot_be_silently_changed(self):
        path = self.paths.worker / 'deploy' / (installer.SERVICE + '.example')
        initial = path.read_text('utf-8')
        path.write_text(initial.replace('--dry-run --translate', '--publish'), 'utf-8')
        with self.assertRaises(installer.InstallRejected):
            self.install(apply=True, expected_commit=SHA)
        path.write_text(initial, 'utf-8')
        path = self.paths.worker / 'deploy' / (installer.TIMER + '.example')
        path.write_text(path.read_text('utf-8').replace('Persistent=false', 'Persistent=true'), 'utf-8')
        with self.assertRaises(installer.InstallRejected):
            self.install(apply=True, expected_commit=SHA)
        self.assertFalse(self.paths.environment.exists())


if __name__ == '__main__':
    unittest.main()
