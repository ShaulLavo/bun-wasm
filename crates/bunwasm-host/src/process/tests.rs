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
    )
    .unwrap();
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
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/runtime-proc-spawn-requests.json"
    ))
    .unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "untransferable parent descriptor")
        .unwrap();
    // Preview1 owns this filesystem descriptor, not the transferable process table.
    processes.reserve_file(91);
    assert_eq!(
        processes.spawn(&serde_json::to_vec(&case["request"]).unwrap()),
        BADF
    );
    assert_eq!(processes.runtime.state.lock().unwrap().processes.len(), 1);
}

#[test]
fn spawn_retains_pipe_end_before_return_and_closes_it_before_wait() {
    let mut processes = processes();
    let [read, write] = processes.pipe().unwrap();
    let pid = processes.spawn(&request(
        "/bin/bun",
        serde_json::json!([{"child":1,"parent":write}]),
    ));
    assert!(pid > 0);
    assert_eq!(processes.close(write), 0);
    let job = processes.job_of(pid);
    assert!(job > 0);
    assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
    assert_eq!(processes.read(read, &mut [0]), 0);
    assert_eq!(processes.wait(pid), Err(CHILD));
    assert_eq!(processes.wait_job(job, 1), Ok(FinalOutcome::Exit(0)));
    assert_eq!(processes.wait(pid), Err(CHILD));
    assert_eq!(processes.wait_job(job, 1), Err(CHILD));
    assert_eq!(processes.poll(&subscription(4, job, 1), 0), Err(CHILD));
}

#[test]
fn unregistered_paths_publish_typed_startup_errno_and_are_consumed_once() {
    let mut processes = processes();
    for (path, errno) in [
        ("bun", NOENT),
        ("node", NOENT),
        ("/bun", NOENT),
        ("/node", NOENT),
        ("/usr/local/bin/bun", NOENT),
        ("/missing", NOENT),
        ("/Cargo.toml", ACCES),
        ("/", ACCES),
        ("/bin", ACCES),
        ("/Cargo.toml/child", NOTDIR),
        ("/bin/bun/child", NOTDIR),
        ("/bin/bun/../node", NOTDIR),
        ("/missing/../bin/bun", NOENT),
    ] {
        let pid = processes.spawn(&request(path, serde_json::json!([])));
        assert!(pid > 0, "{path}: {pid}");
        let job = processes.job_of(pid);
        assert_eq!(completed(&processes, pid), FinalOutcome::StartFailed(-errno), "{path}");
        assert_eq!(processes.wait(pid), Err(CHILD));
        assert_eq!(processes.wait_job(job, 1), Ok(FinalOutcome::StartFailed(-errno)));
    }
    assert_eq!(processes.runtime.state.lock().unwrap().processes.len(), 1);
}

#[test]
fn only_supplied_engines_have_spawnable_files() {
    let mut processes = processes();
    let mut paths = executables::DEFAULT_PATHS.to_vec();
    for (engine, engine_paths) in executables::ENGINE_PATHS {
        for path in engine_paths {
            let pid = processes.spawn(&request(path, serde_json::json!([])));
            assert!(pid > 0);
            let job = processes.job_of(pid);
            assert_eq!(completed(&processes, pid), FinalOutcome::StartFailed(-NOENT));
            assert_eq!(processes.wait_job(job, 1), Ok(FinalOutcome::StartFailed(-NOENT)));
        }
        processes
            .runtime
            .register_engine(engine, &processes.runtime.module)
            .unwrap();
        paths.extend(engine_paths);
    }
    for command in paths {
        let pid = processes.spawn(&request(command, serde_json::json!([])));
        assert!(pid > 0, "{command}: {pid}");
        let job = processes.job_of(pid);
        assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
        assert_eq!(processes.wait_job(job, 1), Ok(FinalOutcome::Exit(0)));
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
    let exited = processes.poll(&subscription(2, 1, 11), 0).unwrap();
    assert_eq!(&exited[..8], &11u64.to_le_bytes());
    assert_eq!(processes.poll(&subscription(2, 1, 11), 0).unwrap(), exited);
    assert_eq!(processes.wait(1), Ok(FinalOutcome::Signal(15)));
    assert_eq!(processes.wait(1), Err(CHILD));
    assert_eq!(processes.wait(2), Err(CHILD));
    assert_eq!(processes.wait_job(1, 1), Err(AGAIN));
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
    assert_eq!(processes.wait_job(1, 1), Ok(FinalOutcome::Signal(15)));
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
    assert_eq!(processes.wait_job(1, 1), Ok(FinalOutcome::Exit(0)));
    assert_eq!(processes.wait_job(2, 1), Ok(FinalOutcome::Exit(143)));
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
            serde_json::from_slice(&request("/bin/bun", serde_json::json!([]))).unwrap();
        meta["job"] = job.into();
        let pid = processes.spawn(&serde_json::to_vec(&meta).unwrap());
        assert!(pid > 0);
        assert_eq!(processes.job_of(pid), job);
        assert_eq!(completed(&processes, pid), FinalOutcome::Exit(0));
        assert_eq!(processes.wait(pid), Err(CHILD));
        assert_eq!(processes.wait_job(job, 1), Err(AGAIN));
        assert!(processes.cancel.check().is_ok());
    }
    let pid = processes.spawn(&request("/bin/bun", serde_json::json!([])));
    assert!(pid > 0);
    assert_ne!(processes.job_of(pid), job);
    let detached_job = processes.job_of(pid);
    completed(&processes, pid);
    assert_eq!(processes.wait_job(detached_job, 0), Ok(FinalOutcome::Exit(0)));
    assert_eq!(processes.job_of(0), job);
}

#[test]
fn a_completed_unreaped_job_rejects_new_members() {
    let mut p = processes();
    let pid = p.spawn(&request("/bin/bun", serde_json::json!([])));
    assert!(pid > 0);
    let job = p.job_of(pid);
    completed(&p, pid);
    let mut meta: serde_json::Value =
        serde_json::from_slice(&request("/bin/bun", serde_json::json!([]))).unwrap();
    meta["job"] = job.into();
    assert_eq!(p.spawn(&serde_json::to_vec(&meta).unwrap()), CHILD);
    assert_eq!(p.wait_job(job, 0), Ok(FinalOutcome::Exit(0)));
}

#[test]
fn oversized_json_job_ids_do_not_saturate_into_the_root_job() {
    let mut processes = processes();
    for job in [2147483648u64, 4294967295, 9007199254740992] {
        let bytes = serde_json::to_vec(&serde_json::json!({"executable":"/bin/bun","argv":[],"env":{},"cwd":"/","job":job,"fds":[]})).unwrap();
        assert!(Request::decode(&bytes).is_ok());
        assert_eq!(processes.spawn(&bytes), SRCH);
    }
    assert_eq!(processes.runtime.state.lock().unwrap().processes.len(), 1);
}

fn access_result(processes: &mut Processes, request: i32) -> i32 {
    assert!(request > 0, "access_start: {request}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = processes.access_take(request);
        if result != AGAIN {
            return result;
        }
        assert!(Instant::now() < deadline, "access query did not finish");
        std::thread::yield_now();
    }
}

#[test]
fn executable_access_is_live_consuming_and_process_owned() {
    let mut p = processes();
    for (path, cwd, expected) in [
        ("/bin/bun", "/missing-cwd", 0),
        ("node", "/bin", 0),
        ("../node", "/bin/sub", NOENT),
        ("/bin/../bin/bun", "/", 0),
        ("/missing", "/", NOENT),
        ("/Cargo.toml", "/", ACCES),
        ("/", "/", ACCES),
        ("/Cargo.toml/a", "/", NOTDIR),
        ("/bin/bun/../node", "/", NOTDIR),
        ("/missing/../bin/bun", "/", NOENT),
        ("/bin/bun/.", "/", NOTDIR),
        ("/bin/bun/", "/", NOTDIR),
        ("/opt/bun/jsc/bin/bun", "/", NOENT),
    ] {
        let id = p.access_start(path, cwd, 1);
        assert_eq!(access_result(&mut p, id), expected, "{path} from {cwd}");
        assert_eq!(p.access_take(id), BADF);
        assert_eq!(p.access_cancel(id), BADF);
        assert_eq!(p.poll(&subscription(5, id, 99), 0), Err(BADF));
    }
    let mut outsider = Processes::new(
        p.runtime.clone(),
        Stdio {
            fds: Descriptors::new(),
            pid: 7,
            memory_limit: 512 << 20,
        },
        crate::net::Net::new().notify(),
        Arc::default(),
    );
    let id = p.access_start("/bin/bun", "/", 1);
    assert_eq!(outsider.access_take(id), BADF);
    assert_eq!(outsider.access_cancel(id), BADF);
    assert_eq!(outsider.poll(&subscription(5, id, 0), 0), Err(BADF));
    let events = p.poll(&subscription(5, id, 99), 5000).unwrap();
    assert_eq!(
        events,
        [
            99u64.to_le_bytes().as_slice(),
            &5u32.to_le_bytes(),
            &0u32.to_le_bytes()
        ]
        .concat()
    );
    assert_eq!(p.poll(&subscription(5, id, 99), 0).unwrap(), events);
    assert_eq!(p.access_take(id), 0);

    // A successful query is not a capability: registry and file changes are
    // observed by the next query and by spawn itself.
    p.runtime
        .executables
        .entries
        .lock()
        .unwrap()
        .remove("/bin/bun");
    let id = p.access_start("/bin/bun", "/", 1);
    assert_eq!(access_result(&mut p, id), ACCES);
    let pid = p.spawn(&request("/bin/bun", serde_json::json!([])));
    assert!(pid > 0);
    assert_eq!(completed(&p, pid), FinalOutcome::StartFailed(-ACCES));
    let bin = p
        .runtime
        .dirs
        .iter()
        .find(|(_, guest)| guest == "/bin")
        .unwrap()
        .0
        .clone();
    std::fs::remove_file(bin.join("node")).unwrap();
    let id = p.access_start("/bin/node", "/", 1);
    assert_eq!(access_result(&mut p, id), NOENT);
    let pid = p.spawn(&request("/bin/node", serde_json::json!([])));
    assert!(pid > 0);
    assert_eq!(completed(&p, pid), FinalOutcome::StartFailed(-NOENT));
}

#[test]
fn access_cancellation_bounds_and_pending_readiness() {
    let mut p = processes();
    assert_eq!(p.access_take(999), BADF);
    assert_eq!(p.access_cancel(999), BADF);
    // Hold the registry so query workers cannot publish until cancellation.
    let runtime = p.runtime.clone();
    let held = runtime.executables.entries.lock().unwrap();
    let id = p.access_start("/bin/bun", "/", 1);
    let cancelled = p.access.get(&id).unwrap().clone();
    assert_eq!(p.access_take(id), AGAIN);
    assert!(p.poll(&subscription(5, id, 7), 0).unwrap().is_empty());
    assert_eq!(p.access_cancel(id), 0);
    let ids: Vec<_> = (0..MAX_ACCESS_REQUESTS)
        .map(|_| p.access_start("/bin/bun", "/", 1))
        .collect();
    assert!(ids.iter().all(|id| *id > 0));
    assert_eq!(p.access_start("/bin/bun", "/", 1), AGAIN);
    assert_eq!(p.access_cancel(ids[0]), 0);
    let next = p.access_start("/bin/bun", "/", 1);
    assert!(next > *ids.last().unwrap());
    drop(held);
    assert!(matches!(*cancelled.lock().unwrap(), AccessState::Cancelled));
    assert_eq!(p.access_take(id), BADF);
    assert_eq!(p.access_cancel(id), BADF);
    for id in ids.into_iter().skip(1) {
        assert_eq!(access_result(&mut p, id), 0);
    }
    assert_eq!(access_result(&mut p, next), 0);
    assert!(p.access.is_empty());
}

#[test]
fn process_drop_retires_pending_access_requests_and_teardown_removes_files() {
    let mut p = processes();
    let runtime = p.runtime.clone();
    let mounts = runtime.executables.mounts();
    let held = runtime.executables.entries.lock().unwrap();
    let id = p.access_start("/bin/bun", "/", 1);
    let slot = p.access.get(&id).unwrap().clone();
    // Fixture's shutdown joins workers, so drop only its Processes first.
    let processes = std::mem::replace(
        &mut p.0,
        Processes::new(
            runtime.clone(),
            Stdio {
                fds: Descriptors::new(),
                pid: 7,
                memory_limit: 512 << 20,
            },
            crate::net::Net::new().notify(),
            Arc::default(),
        ),
    );
    drop(processes);
    assert!(matches!(*slot.lock().unwrap(), AccessState::Cancelled));
    drop(held);
    runtime.shutdown();
    assert!(matches!(*slot.lock().unwrap(), AccessState::Cancelled));
    drop(p);
    drop(runtime);
    assert!(mounts.iter().all(|(path, _)| !path.exists()));
}

#[test]
fn process_directory_capacity_includes_root_and_unwaited_children() {
    let mut processes = processes();
    // Root is pid 0; fill the remaining directory slots with completed children.
    // No host threads are needed to prove completed children retain their slots.
    for pid in 1..PROCESS_CAPACITY as i32 {
        fake_child(&processes, pid, 0, ROOT_JOB, Some(FinalOutcome::Exit(23)));
    }
    processes.runtime.state.lock().unwrap().next = PROCESS_CAPACITY as i32;
    assert_eq!(
        processes.runtime.state.lock().unwrap().processes.len(),
        PROCESS_CAPACITY
    );
    let meta = request("/bin/bun", serde_json::json!([]));
    assert_eq!(processes.spawn(&meta), AGAIN);
    assert_eq!(processes.wait(1), Ok(FinalOutcome::Exit(23)));
    let replacement = processes.spawn(&meta);
    assert_eq!(replacement, PROCESS_CAPACITY as i32);
    assert_eq!(completed(&processes, replacement), FinalOutcome::Exit(0));
    // Consuming wait freed the replacement slot; fill it again, then observe full.
    let replacement = processes.spawn(&meta);
    assert!(replacement > 0);
    assert_eq!(processes.spawn(&meta), AGAIN);
    assert_eq!(completed(&processes, replacement), FinalOutcome::Exit(0));
}

#[test]
fn pid_exhaustion_returns_again_without_partial_child_job_or_descriptor_retention() {
    let mut p = processes();
    p.runtime.state.lock().unwrap().next = i32::MAX;
    let [read, write] = p.pipe().unwrap();
    let before = {
        let state = p.runtime.state.lock().unwrap();
        (state.processes.len(), state.jobs.len(), state.parents.len())
    };
    for _ in 0..3 {
        assert_eq!(p.spawn(&request("/bin/bun", serde_json::json!([{"child":1,"parent":write}]))), AGAIN);
        let state = p.runtime.state.lock().unwrap();
        assert_eq!(state.next, i32::MAX);
        assert_eq!((state.processes.len(), state.jobs.len(), state.parents.len()), before);
    }
    assert_eq!(p.close(write), 0);
    assert_eq!(p.read(read, &mut [0]), 0, "failed reservations retained no writer");
}

#[test]
fn portable_startup_io_errnos_have_no_shell_status_inference() {
    use std::io::{Error, ErrorKind};
    for (kind, errno) in [(ErrorKind::NotFound,44), (ErrorKind::PermissionDenied,2),
        (ErrorKind::NotADirectory,54), (ErrorKind::OutOfMemory,48),
        (ErrorKind::WouldBlock,6), (ErrorKind::Other,29)] {
        assert_eq!(startup_io_errno(&Error::from(kind)), errno);
    }
    for code in [126,127] { assert_eq!(FinalOutcome::Exit(code).wire(), (0,code)); }
    for errno in [44,2,54,45,48,6,29] {
        let cancel = Cancellation::default();
        assert_eq!(cancel.select(FinalOutcome::StartFailed(errno)).wire(), (2,errno));
        assert!(!cancel.kill(9));
        assert_eq!(cancel.select(FinalOutcome::Exit(126)), FinalOutcome::StartFailed(errno));
    }
}

#[test]
fn signaled_child_endpoint_teardown_precedes_safe_wait_and_preserves_queued_outputs() {
    let mut parent = processes();
    let [stdin_read, stdin_write] = parent.pipe().unwrap();
    let [stdout_read, stdout_write] = parent.pipe().unwrap();
    let [stderr_read, stderr_write] = parent.pipe().unwrap();
    let [control_read, control_write] = parent.pipe().unwrap();
    let [message_read, message_write] = parent.pipe().unwrap();
    let bindings = [(0,stdin_read),(1,stdout_write),(2,stderr_write),(17,control_read),(31,message_write)];
    let fds: Descriptors = bindings.iter().map(|(child,fd)| (*child,parent.fds[fd].clone())).collect();
    let input_probe = Arc::downgrade(&fds[&0]);
    let control_probe = Arc::downgrade(&fds[&17]);
    fake_child(&parent, 7, parent.pid, ROOT_JOB, None);
    let cancel = parent.runtime.state.lock().unwrap().processes[&7].cancel.clone();
    let child = Processes::new(parent.runtime.clone(), Stdio { fds, pid:7, memory_limit:512 << 20 }, parent.notify.clone(), cancel.clone());
    for (_,fd) in bindings { assert_eq!(parent.close(fd),0); }
    assert_eq!(parent.write(stdin_write,b"pending stdin"),13);
    assert_eq!(parent.write(control_write,b"pending control"),15);
    assert_eq!(child.write(1,b"out"),3); assert_eq!(child.write(2,b"err"),3); assert_eq!(child.write(31,b"message"),7);
    assert_eq!(parent.kill(7,2),0);
    let selected = cancel.select(FinalOutcome::Exit(0));
    assert_eq!(selected,FinalOutcome::Signal(2));
    assert_eq!(parent.wait(7),Err(AGAIN),"selection alone is not safe publication");
    // Processes owns the inherited generic descriptors; dropping it is the production teardown.
    drop(child);
    assert!(input_probe.upgrade().is_none()); assert!(control_probe.upgrade().is_none());
    assert_eq!(parent.write(stdin_write,b"late"),PIPE); assert_eq!(parent.write(control_write,b"late"),PIPE);
    assert_eq!(parent.wait(7),Err(AGAIN),"teardown precedes the publication lock");
    let mut bytes=[0u8;7];
    for (fd,expected) in [(stdout_read,&b"out"[..]),(stderr_read,&b"err"[..]),(message_read,&b"message"[..])] {
        assert_eq!(parent.read(fd,&mut bytes),expected.len() as i32);
        assert_eq!(&bytes[..expected.len()],expected); assert_eq!(parent.read(fd,&mut bytes),0);
    }
    assert_eq!(parent.kill(7,9),0); assert_eq!(cancel.select(FinalOutcome::Signal(9)),selected);
    parent.runtime.state.lock().unwrap().processes.get_mut(&7).unwrap().result=Some(selected);
    assert_eq!(parent.wait(7),Ok(FinalOutcome::Signal(2))); assert_eq!(parent.wait(7),Err(CHILD));
}

#[test]
fn instance_setup_failure_is_not_an_ordinary_126_or_a_runtime_trap() {
    let mut p=processes();
    let invalid=wasmtime::Module::new(&p.runtime.engine,b"\0asm\x01\0\0\0").unwrap();
    p.runtime.register_engine("quickjs",&invalid).unwrap();
    let pid=p.spawn(&request("/opt/bun/quickjs/bin/bun",serde_json::json!([]))); assert!(pid>0);
    let job=p.job_of(pid);
    assert_eq!(completed(&p,pid),FinalOutcome::StartFailed(45));
    assert_eq!(p.wait_job(job,1),Ok(FinalOutcome::StartFailed(45)));
    // Original (module (func (export "_start") unreachable)) enters the guest and traps.
    let trap=wasmtime::Module::new(&p.runtime.engine,b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x05\x01\x03\0\0\x0b").unwrap();
    p.runtime.register_engine("jsc",&trap).unwrap();
    let pid=p.spawn(&request("/opt/bun/jsc/bin/bun",serde_json::json!([]))); assert!(pid>0);
    let job=p.job_of(pid);
    assert_eq!(completed(&p,pid),FinalOutcome::Exit(134));
    assert_eq!(p.wait_job(job,1),Ok(FinalOutcome::Exit(134)));
}

#[test]
fn startup_observation_is_nonconsuming_and_arbitrates_entry_against_terminal_selection() {
    let cancel = Cancellation::default();
    assert_eq!(cancel.start_status(), AGAIN);
    assert!(cancel.mark_started());
    assert_eq!(cancel.start_status(), 0);
    cancel.kill(9);
    assert_eq!(cancel.start_status(), 0);
    let cancel = Cancellation::default();
    cancel.kill(15);
    assert!(!cancel.mark_started());
    assert_eq!(cancel.start_status(), -11);
    assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Signal(15));
    for errno in [44, 2, 54, 45, 48, 6, 29] {
        let cancel = Cancellation::default();
        cancel.select(FinalOutcome::StartFailed(errno));
        assert!(!cancel.mark_started());
        assert_eq!(cancel.start_status(), errno);
        assert_eq!(cancel.start_status(), errno);
    }
    let mut p = processes();
    let pid = p.spawn(&request("/missing", serde_json::json!([])));
    assert!(pid > 0);
    let subscription = subscription(6, pid, 123);
    assert_eq!(p.poll(&subscription, 5000).unwrap().len(), 16);
    assert_eq!(p.start_status(pid), 44);
    assert_eq!(p.start_status(pid), 44);
    assert_eq!(p.poll(&subscription, 0).unwrap().len(), 16);
    assert_eq!(completed(&p, pid), FinalOutcome::StartFailed(44));
    assert_eq!(p.start_status(pid), CHILD);
    assert_eq!(p.poll(&subscription, 0), Err(CHILD));
}

#[test]
fn finished_orphans_release_capacity_after_either_completion_order() {
    let mut p = processes();
    for late_child in [false, true] {
        for round in 0..PROCESS_CAPACITY + 1 {
            let parent = 10_000 + (round * 2) as i32;
            let child = parent + 1;
            fake_child(&p, parent, 0, ROOT_JOB, None);
            fake_child(&p, child, parent, ROOT_JOB, None);
            {
                let mut state = p.runtime.state.lock().unwrap();
                if !late_child { state.complete(child, FinalOutcome::Exit(7)); }
                state.complete(parent, FinalOutcome::Exit(23));
                if late_child { state.complete(child, FinalOutcome::Exit(7)); }
                assert!(!state.processes.contains_key(&child));
            }
            assert_eq!(p.wait(parent), Ok(FinalOutcome::Exit(23)));
            assert_eq!(p.wait(child), Err(CHILD));
            assert_eq!(p.runtime.state.lock().unwrap().processes.len(), 1);
        }
    }
    let pid = p.spawn(&request("/bin/bun", serde_json::json!([])));
    assert!(pid > 0);
    assert_eq!(completed(&p, pid), FinalOutcome::Exit(0));
}

#[test]
fn orphan_completion_keeps_job_outcome_and_live_descendant_signal_authority() {
    let p = processes();
    fake_child(&p, 10, 0, ROOT_JOB, None);
    fake_child(&p, 11, 10, 77, None);
    p.runtime.state.lock().unwrap().jobs.insert(77, Job {
        owner: 10, leader: 11, result: None,
    });
    p.runtime.state.lock().unwrap().complete(10, FinalOutcome::Exit(23));
    assert_eq!(p.wait(10), Ok(FinalOutcome::Exit(23)));
    assert_eq!(p.kill(11, 0), 0);
    assert_eq!(p.wait_job(77, 1), Err(AGAIN));
    p.runtime.state.lock().unwrap().complete(11, FinalOutcome::Exit(7));
    assert!(!p.runtime.state.lock().unwrap().processes.contains_key(&11));
    assert_eq!(p.wait_job(77, 1), Ok(FinalOutcome::Exit(7)));
    assert_eq!(p.wait_job(77, 1), Err(CHILD));
}

#[test]
fn executable_symlinks_resolve_in_guest_namespace_without_erasing_components() {
    use std::os::unix::fs::symlink;
    let mut p = processes();
    // Place fixtures under the runtime's already-owned executable root; its Drop cleans them
    // on success and panic, after all child execution and executable lookup have stopped.
    let bin = p.runtime.dirs.iter().find(|(_, guest)| guest == "/bin").unwrap().0.clone();
    let workspace = bin.parent().unwrap().join("aliases");
    std::fs::create_dir_all(workspace.join("sub")).unwrap();
    symlink("/bin/bun", workspace.join("absolute")).unwrap();
    symlink("../../bin/bun", workspace.join("sub/relative")).unwrap();
    symlink("/bin", workspace.join("directory")).unwrap();
    symlink("absolute", workspace.join("chain")).unwrap();
    symlink("/missing/../bin/bun", workspace.join("missing")).unwrap();
    symlink("/bin/bun/../node", workspace.join("not-directory")).unwrap();
    symlink("loop-b", workspace.join("loop-a")).unwrap();
    symlink("loop-a", workspace.join("loop-b")).unwrap();
    symlink(&bin, workspace.join("host-root")).unwrap();
    Arc::get_mut(&mut p.runtime).unwrap().dirs.push((workspace, "/workspace".into()));
    for path in ["/workspace/absolute", "/workspace/sub/relative", "/workspace/directory/node", "/workspace/chain"] {
        let id = p.access_start(path, "/", 1);
        assert_eq!(access_result(&mut p, id), ACCES, "{path}");
        let pid = p.spawn(&request(path, serde_json::json!([])));
        assert!(pid > 0);
        assert_eq!(completed(&p, pid), FinalOutcome::StartFailed(-ACCES), "{path}");
    }
    for (path, expected) in [
        ("/workspace/absolute/../node", NOTDIR),
        ("/workspace/missing", NOENT),
        ("/workspace/not-directory", NOTDIR),
        ("/workspace/loop-a", -32),
        ("/workspace/host-root/bun", NOENT),
    ] {
        let id = p.access_start(path, "/", 1);
        assert_eq!(access_result(&mut p, id), expected, "{path}");
    }
}
