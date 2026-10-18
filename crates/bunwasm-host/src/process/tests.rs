use super::*;

struct Fixture(Processes);
impl std::ops::Deref for Fixture {
    type Target = Processes;
    fn deref(&self) -> &Processes {
        &self.0
    }
}
impl std::ops::DerefMut for Fixture {
    fn deref_mut(&mut self) -> &mut Processes {
        &mut self.0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.shutdown();
    }
}

fn processes() -> Fixture {
    let mut config = wasmtime::Config::new();
    config.epoch_interruption(true);
    let engine = wasmtime::Engine::new(&config).unwrap();
    // Original no-op guest: (module (func (export "_start"))).
    let module = wasmtime::Module::new(&engine, b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x04\x01\x02\0\x0b").unwrap();
    let runtime = Runtime::new(
        engine,
        module,
        vec![(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            "/".into(),
        )],
    );
    Fixture(Processes::new(
        runtime,
        Stdio::inherited(),
        crate::net::Net::new().notify(),
        Arc::default(),
    ))
}

fn request(executable: &str, fds: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"executable":executable,"argv":[executable,"child.js"],"cwd":"/","env":{},"job":0,"fds":fds})).unwrap()
}

fn completed(processes: &Processes, pid: i32) -> FinalOutcome {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match processes.wait(pid) {
            Ok(outcome) => return outcome,
            Err(AGAIN) if Instant::now() < deadline => std::thread::yield_now(),
            result => panic!("child did not finish: {result:?}"),
        }
    }
}

fn subscription(kind: u32, id: i32, userdata: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&kind.to_le_bytes());
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes.extend_from_slice(&userdata.to_le_bytes());
    bytes
}

fn fake_child(
    processes: &Processes,
    pid: i32,
    parent: i32,
    job: i32,
    outcome: Option<FinalOutcome>,
) {
    let mut state = processes.runtime.state.lock().unwrap();
    state.parents.insert(pid, parent);
    state.processes.insert(
        pid,
        Child {
            parent,
            job,
            cancel: Arc::default(),
            result: outcome,
            thread: None,
        },
    );
}

#[test]
fn spawn_request_shared_json_conformance() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/runtime-proc-spawn-requests.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let bytes = case["raw"]
            .as_str()
            .map(|raw| raw.as_bytes().to_vec())
            .unwrap_or_else(|| serde_json::to_vec(&case["request"]).unwrap());
        let decoded = Request::decode(&bytes);
        assert_eq!(
            decoded.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {decoded:?}",
            case["name"]
        );
        if let Ok(decoded) = decoded {
            let expected: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.executable, expected["executable"].as_str().unwrap());
            assert_eq!(
                serde_json::to_value(decoded.argv).unwrap(),
                expected["argv"]
            );
            assert_eq!(serde_json::to_value(decoded.env).unwrap(), expected["env"]);
            assert_eq!(decoded.cwd, expected["cwd"].as_str().unwrap());
            assert_eq!(decoded.job, expected["job"].as_f64().unwrap());
            let fds: Vec<serde_json::Value> = decoded
                .fds
                .into_iter()
                .map(|fd| serde_json::json!({"child":fd.child,"parent":fd.parent}))
                .collect();
            let expected_fds: Vec<serde_json::Value> = expected["fds"].as_array().unwrap().iter().map(|fd| serde_json::json!({"child": fd["child"].as_f64().unwrap() as i32, "parent": fd["parent"].as_f64().unwrap() as i32})).collect();
            assert_eq!(fds, expected_fds);
        }
    }
}

#[test]
fn pipe_dup_close_and_wrong_direction_use_wasi_errno() {
    let mut processes = processes();
    let [read, write] = processes.pipe().unwrap();
    let duplicate = processes.dup(write);
    assert!(duplicate > write);
    assert_eq!(processes.write(read, b"no"), NOTCAPABLE);
    assert_eq!(processes.read(write, &mut [0]), NOTCAPABLE);
    assert_eq!(processes.read(read, &mut [0]), AGAIN);
    assert_eq!(processes.write(write, b"ab"), 2);
    assert_eq!(processes.close(write), 0);
    let mut bytes = [0; 2];
    assert_eq!(processes.read(read, &mut bytes), 2);
    assert_eq!(&bytes, b"ab");
    assert_eq!(processes.read(read, &mut bytes), AGAIN);
    assert_eq!(processes.close(duplicate), 0);
    assert_eq!(processes.read(read, &mut bytes), 0);
    assert_eq!(processes.close(read), 0);
    assert_eq!(processes.close(read), BADF);
    assert_eq!(processes.dup(read), BADF);
}

#[test]
fn writer_after_last_reader_close_is_epipe() {
    let mut processes = processes();
    let [read, write] = processes.pipe().unwrap();
    let duplicate = processes.dup(read);
    processes.close(read);
    assert_eq!(processes.write(write, b"still open"), 10);
    processes.close(duplicate);
    assert_eq!(processes.write(write, b"closed"), PIPE);
    let events = processes.poll(&subscription(1, write, 55), 0).unwrap();
    assert_eq!(events.len(), 16);
    assert_eq!(u32::from_le_bytes(events[12..16].try_into().unwrap()), 1);
}

#[test]
fn arbitrary_bindings_are_retained_and_not_implicitly_inherited() {
    let mut parent = processes();
    let [read, write] = parent.pipe().unwrap();
    // Build the same descriptor snapshot spawn gives a child, without a guest
    // racing its first I/O. Arbitrary numbers have no worker-specific meaning.
    let fds = [
        (9, parent.fds[&read].clone()),
        (12, parent.fds[&write].clone()),
    ]
    .into_iter()
    .collect();
    let mut child = Processes::new(
        parent.runtime.clone(),
        Stdio {
            fds,
            pid: 7,
            memory_limit: 512 << 20,
        },
        crate::net::Net::new().notify(),
        Arc::default(),
    );
    parent.close(read);
    parent.close(write);
    assert_eq!(child.write(12, b"ok"), 2);
    let mut bytes = [0; 2];
    assert_eq!(child.read(9, &mut bytes), 2);
    assert_eq!(&bytes, b"ok");
    let grandchild = Processes::new(
        parent.runtime.clone(),
        Stdio {
            fds: Descriptors::new(),
            pid: 8,
            memory_limit: 512 << 20,
        },
        crate::net::Net::new().notify(),
        Arc::default(),
    );
    assert_eq!(grandchild.read(9, &mut bytes), BADF);
    assert_eq!(grandchild.write(12, b"no"), BADF);
    assert_eq!(child.close(12), 0);
    assert_eq!(child.read(9, &mut bytes), 0);
}

#[test]
fn spawn_rejects_unhandable_filesystem_fd_without_partial_child() {
    let mut processes = processes();
    assert_eq!(
        processes.spawn(&request(
            "bun",
            serde_json::json!([{"child":1,"parent":27}])
        )),
        BADF
    );
    assert_eq!(processes.runtime.active.load(Ordering::SeqCst), 0);
    assert_eq!(processes.runtime.state.lock().unwrap().processes.len(), 1);
}

#[test]
fn spawn_retains_pipe_end_before_return_and_closes_it_before_wait() {
    let mut processes = processes();
    let [read, write] = processes.pipe().unwrap();
    let pid = processes.spawn(&request(
        "bun",
        serde_json::json!([{"child":1,"parent":write}]),
    ));
    assert!(pid > 0);
    assert_eq!(processes.close(write), 0);
    assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
    assert_eq!(processes.read(read, &mut [0]), 0);
    let job = processes.job_of(pid);
    assert!(job > 0);
    assert_eq!(processes.wait(pid), Ok(FinalOutcome::Exit(0)));
    assert_eq!(processes.wait_job(job, 1), Ok(0));
    assert_eq!(processes.wait(pid), Err(CHILD));
    assert_eq!(processes.wait_job(job, 1), Err(CHILD));
    assert_eq!(processes.poll(&subscription(4, job, 1), 0), Err(CHILD));
}

#[test]
fn unsupported_executable_is_an_observable_start_failure() {
    let mut processes = processes();
    let pid = processes.spawn(&request("not-installed", serde_json::json!([])));
    assert!(pid > 0);
    assert_eq!(completed(&processes, pid), FinalOutcome::Exit(127));
    assert_eq!(processes.wait_job(processes.job_of(pid), 1), Ok(127));
}

#[test]
fn registered_aliases_keep_ordinary_exit_outcomes() {
    let mut processes = processes();
    for command in BUN_EXECUTABLE_ALIASES {
        let pid = processes.spawn(&request(command, serde_json::json!([])));
        assert!(pid > 0, "{command}: {pid}");
        assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
        assert_eq!(processes.wait_job(processes.job_of(pid), 1), Ok(0));
    }
}

#[test]
fn job_completion_waits_for_descendants_and_preserves_leader_signal_kind() {
    let processes = processes();
    fake_child(&processes, 1, 0, 1, Some(FinalOutcome::Signal(15)));
    fake_child(&processes, 2, 1, 1, None);
    processes.runtime.state.lock().unwrap().jobs.insert(
        1,
        Job {
            owner: 0,
            leader: 1,
            result: Some(FinalOutcome::Signal(15)),
        },
    );
    assert_eq!(processes.wait(1), Ok(FinalOutcome::Signal(15)));
    assert_eq!(processes.wait(2), Err(CHILD));
    assert_eq!(processes.wait_job(1, 1), Err(AGAIN));
    let exited = processes.poll(&subscription(2, 1, 11), 0).unwrap();
    assert_eq!(&exited[..8], &11u64.to_le_bytes());
    assert!(
        processes
            .poll(&subscription(4, 1, 12), 0)
            .unwrap()
            .is_empty()
    );
    processes
        .runtime
        .state
        .lock()
        .unwrap()
        .processes
        .get_mut(&2)
        .unwrap()
        .result = Some(FinalOutcome::Exit(0));
    let ready = processes.poll(&subscription(4, 1, 12), 0).unwrap();
    assert_eq!(&ready[..8], &12u64.to_le_bytes());
    assert_eq!(processes.poll(&subscription(4, 1, 12), 0).unwrap(), ready);
    assert_eq!(processes.wait_job(1, 1), Ok(143));
    assert_eq!(processes.runtime.state.lock().unwrap().processes.len(), 1);
}

#[test]
fn owner_chain_authority_survives_reaping_intermediate_jobs() {
    let processes = processes();
    fake_child(&processes, 1, 0, 1, Some(FinalOutcome::Exit(0)));
    fake_child(&processes, 2, 1, 2, Some(FinalOutcome::Exit(143)));
    {
        let mut state = processes.runtime.state.lock().unwrap();
        state.jobs.insert(
            1,
            Job {
                owner: 0,
                leader: 1,
                result: Some(FinalOutcome::Exit(0)),
            },
        );
        state.jobs.insert(
            2,
            Job {
                owner: 1,
                leader: 2,
                result: Some(FinalOutcome::Exit(143)),
            },
        );
    }
    let outsider = Processes::new(
        processes.runtime.clone(),
        Stdio {
            fds: Descriptors::new(),
            pid: 9,
            memory_limit: 512 << 20,
        },
        crate::net::Net::new().notify(),
        Arc::default(),
    );
    assert_eq!(outsider.wait_job(2, 1), Err(PERM));
    assert_eq!(processes.wait_job(1, 1), Ok(0));
    assert_eq!(processes.wait_job(2, 1), Ok(143));
    assert_eq!(processes.wait_job(999, 1), Err(SRCH));
}

#[test]
fn blocking_job_wait_and_poll_leave_handled_signals_pending() {
    let processes = processes();
    fake_child(&processes, 1, 0, 1, None);
    processes.runtime.state.lock().unwrap().jobs.insert(
        1,
        Job {
            owner: 0,
            leader: 1,
            result: None,
        },
    );
    assert_eq!(processes.cancel.signal(15, 2), 0);
    assert!(processes.cancel.kill(15));
    assert_eq!(processes.wait_job(1, 0), Err(INTR));
    assert!(
        processes
            .poll(&subscription(4, 1, 0), -1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(processes.cancel.signal(0, 0), 15);
    assert_eq!(processes.wait_job(1, 1), Err(AGAIN));
    assert_eq!(processes.wait_job(1, 2), Err(INVAL));
}

#[test]
fn descriptor_allocator_does_not_overwrite_inherited_or_negative_fds() {
    let mut processes = processes();
    processes.next = i32::MAX as u32;
    assert_eq!(processes.pipe(), Err(AGAIN));
    let duplicate = processes.dup(1);
    assert_eq!(duplicate, i32::MAX);
    assert_eq!(processes.dup(1), AGAIN);
    assert_eq!(processes.next, i32::MAX as u32 + 1);
    assert_eq!(processes.close(duplicate), 0);
    assert_eq!(processes.pipe(), Err(AGAIN));
}

#[test]
fn ordinary_children_join_the_current_job_without_reaping_it() {
    let mut processes = processes();
    let job = processes.job_of(0);
    assert_eq!(job, ROOT_JOB);
    for _ in 0..8 {
        let mut meta: serde_json::Value =
            serde_json::from_slice(&request("bun", serde_json::json!([]))).unwrap();
        meta["job"] = job.into();
        let pid = processes.spawn(&serde_json::to_vec(&meta).unwrap());
        assert!(pid > 0);
        assert_eq!(processes.job_of(pid), job);
        assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
        assert_eq!(processes.wait(pid), Ok(FinalOutcome::Exit(0)));
        assert_eq!(processes.wait_job(job, 1), Err(AGAIN));
        assert!(processes.cancel.check().is_ok());
    }
    let pid = processes.spawn(&request("bun", serde_json::json!([])));
    assert!(pid > 0);
    assert_ne!(processes.job_of(pid), job);
    completed(&processes, pid);
    assert_eq!(processes.wait_job(processes.job_of(pid), 0), Ok(0));
    assert_eq!(processes.job_of(0), job);
}

#[test]
fn a_completed_unreaped_job_rejects_new_members() {
    let mut p = processes();
    let pid = p.spawn(&request("bun", serde_json::json!([])));
    assert!(pid > 0);
    let job = p.job_of(pid);
    completed(&p, pid);
    let mut meta: serde_json::Value =
        serde_json::from_slice(&request("bun", serde_json::json!([]))).unwrap();
    meta["job"] = job.into();
    assert_eq!(p.spawn(&serde_json::to_vec(&meta).unwrap()), CHILD);
    assert_eq!(p.wait_job(job, 0), Ok(0));
}
