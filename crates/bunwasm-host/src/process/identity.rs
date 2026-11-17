use super::{AGAIN, Cancellation, Child, INVAL, PERM, PROCESS_CAPACITY, ROOT_JOB, Runtime, SRCH};
use std::num::NonZeroI32;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecutionId(i32);

impl ExecutionId {
    pub fn get(self) -> i32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LogicalPid(NonZeroI32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pid: LogicalPid,
    parent: Option<LogicalPid>,
}

impl ProcessIdentity {
    pub fn pair(self) -> (i32, i32) {
        (self.pid.0.get(), self.parent.map_or(0, |pid| pid.0.get()))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    #[default]
    Process,
    Thread,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Membership {
    Process(ProcessIdentity),
    Thread(ProcessIdentity),
}

impl Membership {
    pub(super) fn identity(self) -> ProcessIdentity {
        match self {
            Self::Process(identity) | Self::Thread(identity) => identity,
        }
    }
}

/// Consumed by exactly one instance. Only this runtime's locked admission creates it.
pub struct AdmittedProcess {
    pub(super) runtime: Arc<Runtime>,
    pub(super) execution: ExecutionId,
    pub(super) membership: Membership,
    pub(super) cancel: Arc<Cancellation>,
}

impl AdmittedProcess {
    pub fn execution_id(&self) -> ExecutionId {
        self.execution
    }

    pub fn runtime(&self) -> Arc<Runtime> {
        self.runtime.clone()
    }

    pub fn cancellation(&self) -> Arc<Cancellation> {
        self.cancel.clone()
    }
}

impl super::Supervisor {
    fn allocate(&mut self) -> Result<LogicalPid, i32> {
        if self.next == 0 || self.next > i32::MAX as u32 {
            return Err(AGAIN);
        }
        let pid = LogicalPid(NonZeroI32::new(self.next as i32).ok_or(INVAL)?);
        self.next += 1;
        Ok(pid)
    }

    pub(super) fn admit(
        &mut self,
        caller: i32,
        kind: ProcessKind,
    ) -> Result<(ExecutionId, Membership), i32> {
        if self.stopping {
            return Err(PERM);
        }
        if self.processes.len() >= PROCESS_CAPACITY {
            return Err(AGAIN);
        }
        let parent = self.processes.get(&caller).ok_or(SRCH)?;
        if parent.result.is_some() || parent.cancel.is_finished() {
            return Err(SRCH);
        }
        let inherited = parent.membership.identity();
        let pid = self.allocate()?;
        let membership = match kind {
            ProcessKind::Process => Membership::Process(ProcessIdentity {
                pid,
                parent: Some(inherited.pid),
            }),
            ProcessKind::Thread => Membership::Thread(inherited),
        };
        Ok((ExecutionId(pid.0.get()), membership))
    }
}

impl Runtime {
    pub fn admit_root(self: &Arc<Self>, cancel: Arc<Cancellation>) -> Result<AdmittedProcess, i32> {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return Err(PERM);
        }
        if state.root_admitted || !state.processes.is_empty() {
            return Err(INVAL);
        }
        let identity = ProcessIdentity {
            pid: state.allocate()?,
            parent: None,
        };
        let membership = Membership::Process(identity);
        state.root_admitted = true;
        state.processes.insert(
            0,
            Child {
                parent: 0,
                job: ROOT_JOB,
                membership,
                cancel: cancel.clone(),
                result: None,
                thread: None,
            },
        );
        Ok(AdmittedProcess {
            runtime: self.clone(),
            execution: ExecutionId(0),
            membership,
            cancel,
        })
    }

    pub(super) fn admission(
        self: &Arc<Self>,
        execution: ExecutionId,
        membership: Membership,
        cancel: Arc<Cancellation>,
    ) -> AdmittedProcess {
        AdmittedProcess {
            runtime: self.clone(),
            execution,
            membership,
            cancel,
        }
    }

    #[cfg(test)]
    pub(crate) fn admit_fixture(
        self: &Arc<Self>,
        caller: i32,
        kind: ProcessKind,
        cancel: Arc<Cancellation>,
    ) -> Result<AdmittedProcess, i32> {
        let mut state = self.state.lock().unwrap();
        let (execution, membership) = state.admit(caller, kind)?;
        let job = state.processes[&caller].job;
        state.parents.insert(execution.get(), caller);
        state.processes.insert(
            execution.get(),
            Child {
                parent: caller,
                job,
                membership,
                cancel: cancel.clone(),
                result: None,
                thread: None,
            },
        );
        Ok(self.admission(execution, membership, cancel))
    }
}

impl super::Processes {
    pub fn process_identity(&self) -> ProcessIdentity {
        self.membership.identity()
    }
}
