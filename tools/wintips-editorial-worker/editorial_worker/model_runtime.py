"""Optional, bounded lease of the already installed shared Ollama service.

No unit/configuration/model is installed. Fixed systemd names and both existing
worker locks prevent the WinTips preview from competing with the other journal.
Cached translations need neither this module nor a daemon. A new lease is
admitted only when its complete bounded budget fits before BigWin's UTC timer.
"""
from contextlib import contextmanager, ExitStack
from datetime import datetime, timedelta, timezone
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
SHARED_TIMER_MINUTE = 7
# Covers the existing timer's 15s jitter and a pending service activation.
SHARED_TIMER_START_GUARD_SECONDS = 60
# systemctl calls, health/startup, unloading, finally cleanup and scheduling.
MODEL_LIFECYCLE_RESERVE_SECONDS = 300


class RuntimeUnavailable(RuntimeError):
    code = 'shared_local_model_unavailable'


class RuntimeDeferred(RuntimeUnavailable):
    code = 'shared_worker_window_reserved'

    def __init__(self, window):
        super().__init__(self.code)
        self.window = window


def admission_window(now, translation_seconds=1200):
    """Pure UTC schedule check. Never sleeps, locks, queries or starts a unit."""
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise RuntimeUnavailable('admission_requires_aware_clock')
    if isinstance(translation_seconds, bool) or not isinstance(translation_seconds, (int, float)) or not 30 <= translation_seconds <= 1800:
        raise RuntimeUnavailable('admission_requires_bounded_translation_budget')
    instant = now.astimezone(timezone.utc)
    mark = instant.replace(minute=SHARED_TIMER_MINUTE, second=0, microsecond=0)
    # A run just after :07 must not race the randomized BigWin start.
    pending_start = mark <= instant < mark + timedelta(seconds=SHARED_TIMER_START_GUARD_SECONDS)
    next_start = mark if pending_start or instant <= mark else mark + timedelta(hours=1)
    available = max(0, (next_start - instant).total_seconds())
    required = translation_seconds + MODEL_LIFECYCLE_RESERVE_SECONDS
    admitted = not pending_start and available >= required
    retry = (mark if pending_start else next_start) + timedelta(seconds=SHARED_TIMER_START_GUARD_SECONDS)
    return {'admitted': admitted, 'checkedAtUtc': instant.isoformat(),
            'nextBigWinAtUtc': next_start.isoformat(),
            'availableSeconds': available, 'requiredSeconds': required,
            'retryNotBeforeUtc': None if admitted else retry.isoformat()}


def require_admission(now, translation_seconds=1200):
    window = admission_window(now, translation_seconds)
    if not window['admitted']:
        raise RuntimeDeferred(window)
    return window


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
def managed_model(*, control=systemctl, healthy=ready, locks=LOCKS, acquire=shared_locks, monotonic=time.monotonic, pause=time.sleep,
                  clock=lambda: datetime.now(timezone.utc), translation_seconds=1200):
    require_admission(clock(), translation_seconds)
    with acquire(locks):
        # Recheck after acquisition: never turn a near-boundary lease into a run.
        require_admission(clock(), translation_seconds)
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
