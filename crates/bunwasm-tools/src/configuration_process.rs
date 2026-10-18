//! Tool-owned configuration evaluation over the ordinary runtime process ABI.
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[cfg(not(test))]
use crate::host;
#[cfg(test)]
#[path = "configuration_process_test_host.rs"]
mod host;

pub(super) fn run(
    source: &str,
    cwd: &str,
    variables: HashMap<String, String>,
) -> Result<Vec<u8>, Vec<u8>> {
    evaluate(source, cwd, variables, Instant::now())
}

fn evaluate(
    source: &str,
    cwd: &str,
    variables: HashMap<String, String>,
    started: Instant,
) -> Result<Vec<u8>, Vec<u8>> {
    let executable = configuration_executable(variables.get("PATH").map(String::as_str));
    // Configuration programs are ordinary runtime_proc children. The tool owns the three pipe
    // endpoints and closes every parent-side descriptor after spawn; no Bun-only host admission
    // state is involved. `purpose` remains descriptive metadata for process traces only.
    let stdin = host::proc_pipe()
        .map_err(|code| process_error("Cannot create configuration stdin", code))?;
    let stdout = match host::proc_pipe() {
        Ok(pipe) => pipe,
        Err(code) => {
            close_pipe(stdin);
            return Err(process_error("Cannot create configuration stdout", code));
        }
    };
    let stderr = match host::proc_pipe() {
        Ok(pipe) => pipe,
        Err(code) => {
            close_pipe(stdin);
            close_pipe(stdout);
            return Err(process_error("Cannot create configuration stderr", code));
        }
    };
    let job = host::proc_job_of(0);
    if job < 0 {
        close_pipe(stdin);
        close_pipe(stdout);
        close_pipe(stderr);
        return Err(process_error(
            "Could not determine the configuration process job",
            job,
        ));
    }
    let meta = serde_json::json!({
        "purpose": "configuration",
        "executable": executable,
        "argv": [executable, "--no-install", "-e", source],
        "cwd": cwd,
        "env": variables,
        "fds": [
            { "child": 0, "parent": stdin.0 },
            { "child": 1, "parent": stdout.1 },
            { "child": 2, "parent": stderr.1 },
        ],
        "job": job,
    });
    let handle = host::proc_spawn(meta.to_string().as_bytes());
    if handle < 0 {
        close_pipe(stdin);
        close_pipe(stdout);
        close_pipe(stderr);
        return Err(process_error(
            "Could not start a configuration process",
            handle,
        ));
    }
    // The child owns duplicated references. Closing stdin's only writer gives it EOF.
    // Keep only the output readers in the parent.
    close_pipe(stdin);
    let _ = host::proc_close(stdout.1 as i32);
    let _ = host::proc_close(stderr.1 as i32);
    let mut child = Child {
        handle,
        pipes: [stdout.0 as i32, stderr.0 as i32],
        reaped: false,
    };
    let mut output = [Vec::new(), Vec::new()];
    let mut budget = EvaluationBudget { started, bytes: 0 };
    let mut status = None;
    while status.is_none() || child.pipes.iter().any(|pipe| *pipe >= 0) {
        budget.check_time()?;
        for (pipe, bytes) in child.pipes.iter_mut().zip(output.iter_mut()) {
            drain(pipe, bytes, &mut budget)?;
        }
        if status.is_none() {
            match host::proc_wait(handle) {
                Ok(result) => {
                    child.reaped = true;
                    status = Some(result);
                }
                Err(-6) => {}
                Err(code) => return Err(process_error("Configuration process failed", code)),
            }
        }
        if status.is_none() || child.pipes.iter().any(|pipe| *pipe >= 0) {
            let subscriptions = subscriptions(status.is_none().then_some(handle), &child.pipes);
            host::proc_poll(&subscriptions, 25)
                .map_err(|code| process_error("Configuration process wait failed", code))?;
        }
    }
    let [stdout, stderr] = output;
    let (kind, code) = status.expect("configuration child must have exited");
    if kind == 0 && code == 0 {
        Ok(stdout)
    } else {
        Err(stderr)
    }
}

fn configuration_executable(path: Option<&str>) -> &'static str {
    match path.and_then(|value| value.split(':').next()) {
        Some("/opt/bun/quickjs/bin") => "/opt/bun/quickjs/bin/bun",
        Some("/opt/bun/jsc/bin") => "/opt/bun/jsc/bin/bun",
        _ => "/bin/bun",
    }
}

fn close_pipe((read, write): (u32, u32)) {
    let _ = host::proc_close(read as i32);
    let _ = host::proc_close(write as i32);
}

fn subscriptions(pid: Option<i32>, pipes: &[i32; 2]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(48);
    for pipe in pipes.iter().copied().filter(|pipe| *pipe >= 0) {
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&(pipe as u32).to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
    }
    if let Some(pid) = pid {
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(pid as u32).to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
    }
    bytes
}

struct EvaluationBudget {
    started: Instant,
    bytes: usize,
}

impl EvaluationBudget {
    fn check_time(&self) -> Result<(), Vec<u8>> {
        if self.started.elapsed() >= Duration::from_secs(5) {
            return Err(b"Configuration evaluation exceeded 5 seconds".to_vec());
        }
        Ok(())
    }

    fn add_output(&mut self, bytes: usize) -> Result<(), Vec<u8>> {
        self.bytes += bytes;
        if self.bytes > 8 * 1024 * 1024 {
            return Err(
                b"Configuration evaluation exceeded 8 MiB of combined stdout and stderr".to_vec(),
            );
        }
        Ok(())
    }
}

fn process_error(context: &str, code: i32) -> Vec<u8> {
    let (name, message) = match code {
        -44 => ("ENOENT", "executable not found"),
        -6 => ("EAGAIN", "resource temporarily unavailable"),
        -8 => ("EBADF", "bad file descriptor"),
        -2 => ("EACCES", "permission denied"),
        -28 => ("EINVAL", "invalid argument"),
        -64 => ("EPIPE", "broken pipe"),
        -52 => ("ENOSYS", "process ABI is not provided"),
        -12 => ("ECHILD", "no child process"),
        -71 => ("ESRCH", "no such process"),
        _ => ("process error", "runtime process operation failed"),
    };
    format!("{context}: {name}: {message} ({code})").into_bytes()
}

fn drain(
    pipe: &mut i32,
    bytes: &mut Vec<u8>,
    budget: &mut EvaluationBudget,
) -> Result<(), Vec<u8>> {
    if *pipe < 0 {
        return Ok(());
    }
    match host::proc_read(*pipe, 65536) {
        Ok(chunk) if !chunk.is_empty() => {
            budget.add_output(chunk.len())?;
            bytes.extend_from_slice(&chunk);
        }
        Err(-6) => {}
        Ok(_) => {
            let _ = host::proc_close(*pipe);
            *pipe = -1;
        }
        Err(code) => {
            return Err(process_error(
                "Cannot read configuration process output",
                code,
            ));
        }
    }
    Ok(())
}

struct Child {
    handle: i32,
    pipes: [i32; 2],
    reaped: bool,
}

impl Drop for Child {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = host::proc_kill(self.handle, 9);
        }
        for pipe in self.pipes.iter().copied().filter(|pipe| *pipe >= 0) {
            let _ = host::proc_close(pipe);
        }
        if !self.reaped {
            while matches!(host::proc_wait(self.handle), Err(-6)) {
                let _ = host::proc_poll(&[], 10);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn clean() {
        host::with(|state| {
            assert!(
                state.open.is_empty(),
                "leaked pipe descriptors: {:?}",
                state.open
            );
            assert!(!state.live, "configuration child survived evaluation");
        });
    }

    #[test]
    fn approved_engines_preserve_source_cwd_environment_and_owner_job() {
        for (path, executable) in [
            ("/bin:/usr/bin", "/bin/bun"),
            ("/opt/bun/quickjs/bin:/bin", "/opt/bun/quickjs/bin/bun"),
            ("/opt/bun/jsc/bin:/bin", "/opt/bun/jsc/bin/bun"),
        ] {
            host::reset();
            let env = HashMap::from([
                ("PATH".to_owned(), path.to_owned()),
                ("VALUE".to_owned(), "child only".to_owned()),
            ]);
            host::with(|state| {
                state
                    .output
                    .insert(12, VecDeque::from([Ok(b"config".to_vec())]));
            });
            assert_eq!(
                run("export default {}", "/project/sub", env.clone()),
                Ok(b"config".to_vec())
            );
            host::with(|state| {
                assert_eq!(
                    state.requests,
                    vec![serde_json::json!({
                        "purpose": "configuration", "executable": executable,
                        "argv": [executable, "--no-install", "-e", "export default {}"],
                        "cwd": "/project/sub", "env": env, "job": 7,
                        "fds": [{"child":0,"parent":10},{"child":1,"parent":13},{"child":2,"parent":15}],
                    })]
                );
                // Completion can precede output EOF; never poll its consumed PID again.
                assert!(!state.polls.is_empty());
            });
            clean();
        }
    }

    #[test]
    fn partial_pipe_job_and_spawn_failures_close_every_endpoint() {
        for failure in 1..=5 {
            host::reset();
            host::with(|state| match failure {
                1..=3 => state.fail_pipe = Some(failure),
                4 => state.job = -71,
                _ => state.spawn = -6,
            });
            assert!(run("0", "/", HashMap::new()).is_err());
            clean();
        }
    }

    #[test]
    fn deadline_kills_reaps_and_closes_before_returning_the_budget_error() {
        host::reset();
        let result = evaluate(
            "for (;;) {}",
            "/",
            HashMap::new(),
            Instant::now() - Duration::from_secs(5),
        );
        assert_eq!(
            result,
            Err(b"Configuration evaluation exceeded 5 seconds".to_vec())
        );
        host::with(|state| {
            assert_eq!(state.killed, 1);
            assert!(state.reaped);
        });
        clean();
        host::reset();
        assert_eq!(run("0", "/", HashMap::new()), Ok(Vec::new()));
        clean();
    }

    #[test]
    fn combined_stdout_stderr_overflow_is_bounded_and_cleans_up() {
        host::reset();
        host::with(|state| {
            state.waits = VecDeque::from(vec![Err(-6); 100]);
            for fd in [12, 14] {
                state
                    .output
                    .insert(fd, VecDeque::from(vec![Ok(vec![b'x'; 65536]); 65]));
            }
        });
        assert_eq!(
            run("noisy", "/", HashMap::new()),
            Err(b"Configuration evaluation exceeded 8 MiB of combined stdout and stderr".to_vec())
        );
        host::with(|state| {
            assert_eq!(state.killed, 1);
            assert!(state.reaped);
        });
        clean();
        host::reset();
        assert_eq!(run("0", "/", HashMap::new()), Ok(Vec::new()));
        clean();
    }

    #[test]
    fn exact_output_limit_is_allowed_and_deadline_is_checked_separately() {
        let mut budget = EvaluationBudget {
            started: Instant::now(),
            bytes: 0,
        };
        assert!(budget.add_output(8 * 1024 * 1024).is_ok());
        assert!(budget.add_output(1).is_err());
        budget.started = Instant::now() - Duration::from_secs(5);
        assert!(budget.check_time().is_err());
    }

    #[test]
    fn read_wait_and_poll_failures_kill_reap_and_close() {
        for operation in ["read", "wait", "poll"] {
            host::reset();
            host::with(|state| match operation {
                "read" => {
                    state.output.insert(12, VecDeque::from([Err(-8)]));
                }
                "wait" => {
                    state.waits.push_back(Err(-29));
                }
                _ => {
                    state.waits.push_back(Err(-6));
                    state.poll_error = Some(-28);
                }
            });
            assert!(run("0", "/", HashMap::new()).is_err());
            host::with(|state| {
                assert_eq!(state.killed, 1);
                assert!(state.reaped);
            });
            clean();
        }
    }

    #[test]
    fn helper_failure_returns_stderr_and_repeated_successes_leave_no_handles() {
        for outcome in [(0, 2), (1, 9), (2, 44)] {
            host::reset();
            host::with(|state| {
                state
                    .output
                    .insert(14, VecDeque::from([Ok(b"bad config".to_vec())]));
                state.waits.push_back(Ok(outcome));
            });
            assert_eq!(
                run("throw Error()", "/", HashMap::new()),
                Err(b"bad config".to_vec())
            );
            clean();
        }
        for _ in 0..8 {
            host::reset();
            assert_eq!(run("0", "/", HashMap::new()), Ok(Vec::new()));
            clean();
        }
    }

    #[test]
    fn process_diagnostics_use_wasi_errno_numbers_not_network_slot_codes() {
        for (code, name) in [
            (-2, "EACCES"),
            (-44, "ENOENT"),
            (-6, "EAGAIN"),
            (-52, "ENOSYS"),
        ] {
            assert!(String::from_utf8(process_error("configuration", code))
                .unwrap()
                .contains(name));
        }
    }
}
