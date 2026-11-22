"""Runs scripts/measure-stack.py with a fake launcher that hangs, without racing a clock.

The fixture launcher (stack-measurement-provider.ts) hangs on purpose: on every attempt for the
"hang" scenario, and at depth 4 for "hidden-timeout". The real per-attempt limit in the script is
120 seconds, too long to wait in a test, and shortening it to a fraction of a second makes the
outcome depend on how fast the machine starts a launcher: under load an attempt that should
complete times out too.

Here the timeout is decided by the fixture instead. A hanging attempt is killed, reaped and
reported as subprocess.TimeoutExpired as soon as its launcher has recorded its pid, which it does
right before it hangs. Every other attempt runs unchanged with the script's own limit.
"""
import os
import runpy
import subprocess
import sys
import time
from pathlib import Path

HANG_CAP_SECONDS = 60
HANG_DEPTH = '4' if os.environ.get('STACK_TEST_SCENARIO') == 'hidden-timeout' else None
PID_FILE = Path(os.environ['STACK_TEST_ROOT']) / 'launcher.pid'
original = subprocess.run


def hangs(command):
    return HANG_DEPTH is None or command[-1] == HANG_DEPTH


def started(pid):
    return PID_FILE.exists() and str(pid) in PID_FILE.read_text().split()


def run(command, **kwargs):
    if not hangs(command):
        return original(command, **kwargs)
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=kwargs.get('text')) as child:
        deadline = time.monotonic() + HANG_CAP_SECONDS
        while not started(child.pid) and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if child.poll() is not None:
            raise RuntimeError(f'the fixture launcher exited instead of hanging: {command}')
        child.kill()
        output, errors = child.communicate()
    raise subprocess.TimeoutExpired(command, kwargs.get('timeout'), output, errors)


subprocess.run = run
sys.argv[0] = str(Path(__file__).resolve().parents[1] / 'measure-stack.py')
runpy.run_path(sys.argv[0], run_name='__main__')
