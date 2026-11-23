"""Runs scripts/measure-stack.py so that a hanging fake launcher times out without racing a clock.

The fixture launcher (stack-measurement-provider.ts) hangs on purpose: on every attempt for the
"hang" scenario, and at depth 4 for "hidden-timeout". The script's own limit is 120 seconds, too
long to wait in a test, and a fraction of a second makes the outcome depend on how fast the machine
starts a launcher: under load an attempt that should complete times out too.

Here the script keeps calling the real subprocess.run with its real timeout, so subprocess.run
still does the killing and reaping. Only the wait inside it changes: the child waits until the
launcher has said it is hanging (it appends its pid to hanging.pid after all its other records)
and only then lets the script's timeout expire. An attempt whose launcher exits instead is waited
for normally, up to the script's own limit. A call without a timeout is refused, so removing the
script's limit fails the tests instead of hanging them.
"""
import os
import runpy
import subprocess
import sys
import time
from pathlib import Path

HANGING = Path(os.environ['STACK_TEST_ROOT']) / 'hanging.pid'
EXPIRE_AFTER_SECONDS = 0.05


class FixturePopen(subprocess.Popen):
    waited = False

    def communicate(self, input=None, timeout=None):
        if self.waited:  # subprocess.run's second call, after it killed the child
            return super().communicate(input, timeout)
        self.waited = True
        if timeout is None:
            raise AssertionError('the measurement script must give every launcher attempt a timeout')
        deadline = time.monotonic() + timeout
        while self.poll() is None and not self.hanging() and time.monotonic() < deadline:
            time.sleep(0.01)
        return super().communicate(input, EXPIRE_AFTER_SECONDS if self.hanging() else max(deadline - time.monotonic(), 0))

    def hanging(self):
        return self.poll() is None and HANGING.exists() and str(self.pid) in HANGING.read_text().split()


subprocess.Popen = FixturePopen
sys.argv[0] = str(Path(__file__).resolve().parents[1] / 'measure-stack.py')
runpy.run_path(sys.argv[0], run_name='__main__')
