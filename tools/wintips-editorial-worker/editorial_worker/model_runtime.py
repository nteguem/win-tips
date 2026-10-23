"""Optional, bounded lease of the already installed shared Ollama service.

No unit/configuration/model is installed. Fixed systemd names and both existing
worker locks prevent the WinTips preview from competing with the other journal.
The normal Marian translation path needs neither this module nor a daemon.
"""
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

MODEL = 'journal-parieur-worker-model.service'
SHARED_JOB = 'journal-parieur-worker.service'
LOCKS = ('/var/lib/journal-parieur-worker/daily-run/worker.lock',
         '/var/lib/journal-parieur-worker/worker.lock')


class RuntimeUnavailable(RuntimeError):
    code = 'shared_local_model_unavailable'


def systemctl(action, unit):
    if action not in ('is-active', 'start', 'stop') or unit not in (MODEL, SHARED_JOB):
        raise RuntimeUnavailable('fixed_runtime_unit_required')
    result = subprocess.run(['/usr/bin/systemctl', action, '--quiet', unit],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=35, check=False)
    if action != 'is-active' and result.returncode:
        raise RuntimeUnavailable('local_model_control_failed')
    return result.returncode == 0


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeUnavailable('model_redirect_forbidden')


def ready():
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(Request('http://127.0.0.1:11439/api/tags'), timeout=2) as response:
            data = response.read(500001)
        return len(data) <= 500000 and isinstance(json.loads(data).get('models'), list)
    except (OSError, ValueError):
        return False


@contextmanager
def shared_locks(locks):
    if os.name != 'posix':
        raise RuntimeUnavailable('managed_runtime_requires_linux')
    import fcntl
    with ExitStack() as stack:
        for lock in locks:
            # Existing lock files only. The service never creates a competing
            # lock under a different path or changes the shared permissions.
            handle = stack.enter_context(Path(lock).open('r+b'))
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeUnavailable('shared_worker_busy') from exc
        yield


@contextmanager
def managed_model(*, control=systemctl, healthy=ready, locks=LOCKS, acquire=shared_locks, monotonic=time.monotonic, pause=time.sleep):
    with acquire(locks):
        if control('is-active', SHARED_JOB):
            raise RuntimeUnavailable('shared_worker_busy')
        owned = not control('is-active', MODEL)
        try:
            if owned:
                control('start', MODEL)
            deadline = monotonic() + 35
            while not healthy():
                if monotonic() >= deadline:
                    raise RuntimeUnavailable('local_model_start_timeout')
                pause(.5)
            yield
        finally:
            # Stopping the service releases its model RAM. Never stop a daemon
            # that was already active or a runtime now needed by a shared job.
            if owned and not control('is-active', SHARED_JOB):
                control('stop', MODEL)
