//! Deterministic runtime_proc boundary for the tool's resource and budget tests.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

pub(super) struct State {
    pub open: HashSet<i32>,
    pub pipe_calls: usize,
    pub fail_pipe: Option<usize>,
    pub job: i32,
    pub spawn: i32,
    pub requests: Vec<serde_json::Value>,
    pub output: HashMap<i32, VecDeque<Result<Vec<u8>, i32>>>,
    pub waits: VecDeque<Result<(u32, i32), i32>>,
    pub poll_error: Option<i32>,
    pub polls: Vec<Vec<u8>>,
    pub killed: usize,
    pub live: bool,
    pub reaped: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            open: HashSet::new(),
            pipe_calls: 0,
            fail_pipe: None,
            job: 7,
            spawn: 99,
            requests: Vec::new(),
            output: HashMap::new(),
            waits: VecDeque::new(),
            poll_error: None,
            polls: Vec::new(),
            killed: 0,
            live: false,
            reaped: false,
        }
    }
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
pub(super) fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|state| f(&mut state.borrow_mut()))
}
pub(super) fn reset() {
    with(|state| *state = State::default());
}
pub(super) fn proc_pipe() -> Result<(u32, u32), i32> {
    with(|state| {
        state.pipe_calls += 1;
        if state.fail_pipe == Some(state.pipe_calls) {
            return Err(-41);
        }
        let read = 8 + state.pipe_calls as i32 * 2;
        assert!(state.open.insert(read));
        assert!(state.open.insert(read + 1));
        Ok((read as u32, (read + 1) as u32))
    })
}
pub(super) fn proc_job_of(pid: i32) -> i32 {
    assert_eq!(pid, 0);
    with(|state| state.job)
}
pub(super) fn proc_spawn(bytes: &[u8]) -> i32 {
    with(|state| {
        let request: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        for binding in request["fds"].as_array().unwrap() {
            assert!(
                state
                    .open
                    .contains(&(binding["parent"].as_i64().unwrap() as i32))
            );
        }
        state.requests.push(request);
        state.live = state.spawn > 0;
        state.spawn
    })
}
pub(super) fn proc_close(fd: i32) -> i32 {
    with(|state| {
        assert!(state.open.remove(&fd), "descriptor {fd} closed twice");
        0
    })
}
pub(super) fn proc_read(fd: i32, cap: usize) -> Result<Vec<u8>, i32> {
    with(|state| {
        assert!(state.open.contains(&fd));
        let value = state
            .output
            .entry(fd)
            .or_default()
            .pop_front()
            .unwrap_or(Ok(Vec::new()));
        if let Ok(bytes) = &value {
            assert!(bytes.len() <= cap);
        }
        value
    })
}
pub(super) fn proc_wait(pid: i32) -> Result<(u32, i32), i32> {
    with(|state| {
        assert_eq!(pid, state.spawn);
        assert!(!state.reaped, "waited for an already-consumed child");
        let value = state.waits.pop_front().unwrap_or(Ok((0, 0)));
        if value.is_ok() {
            state.live = false;
            state.reaped = true;
        }
        value
    })
}
pub(super) fn proc_poll(subscriptions: &[u8], _timeout: i32) -> Result<Vec<u8>, i32> {
    with(|state| {
        for sub in subscriptions.as_chunks::<16>().0 {
            let kind = u32::from_le_bytes(sub[..4].try_into().unwrap());
            let id = i32::from_le_bytes(sub[4..8].try_into().unwrap());
            if kind == 0 {
                assert!(state.open.contains(&id));
            } else {
                assert_eq!(kind, 2);
                assert_eq!(id, state.spawn);
                assert!(!state.reaped, "polled an already-consumed child");
            }
        }
        state.polls.push(subscriptions.to_vec());
        state.poll_error.map_or(Ok(Vec::new()), Err)
    })
}
pub(super) fn proc_kill(pid: i32, signal: i32) -> i32 {
    with(|state| {
        assert_eq!(pid, state.spawn);
        assert_eq!(signal, 9);
        assert!(!state.reaped, "killed an already-consumed child");
        state.killed += 1;
        state.waits = VecDeque::from([Ok((1, 9))]);
        0
    })
}
