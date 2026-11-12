//! Checked data-only invocation lifetimes, independent of engine-owned JS roots.
use super::nested_frame as frame;
use crate::data::NativeError;
use std::cell::RefCell;
thread_local! {
    static INVOCATIONS: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}
pub(super) fn active() -> Option<u32> {
    INVOCATIONS.with(|stack| stack.borrow().last().copied())
}
pub(super) struct Invocation(u32);
impl Invocation {
    pub(super) fn enter(token: u32) -> Result<Self, NativeError> {
        INVOCATIONS.with(|stack| {
            let mut stack = stack.borrow_mut();
            if token == 0 || stack.len() >= frame::MAX_DEPTH || stack.contains(&token) {
                return Err(NativeError::range_error(
                    "Invalid or excessive nested invocation",
                ));
            }
            stack.push(token);
            Ok(Self(token))
        })
    }
}
impl Drop for Invocation {
    fn drop(&mut self) {
        INVOCATIONS.with(|stack| assert_eq!(stack.borrow_mut().pop(), Some(self.0)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_guards_reject_duplicates_and_restore_outer_tokens() {
        INVOCATIONS.with(|stack| assert!(stack.borrow().is_empty()));
        let outer = Invocation::enter(1).unwrap();
        assert!(Invocation::enter(1).is_err());
        assert!(Invocation::enter(0).is_err());
        let inner = Invocation::enter(2).unwrap();
        drop(inner);
        assert_eq!(active(), Some(1));
        drop(outer);
        INVOCATIONS.with(|stack| assert!(stack.borrow().is_empty()));
    }

    #[test]
    fn invocation_depth_limit_leaves_the_session_usable() {
        let guards = (1..=frame::MAX_DEPTH as u32)
            .map(|token| Invocation::enter(token).unwrap())
            .collect::<Vec<_>>();
        assert!(Invocation::enter(frame::MAX_DEPTH as u32 + 1).is_err());
        for guard in guards.into_iter().rev() {
            drop(guard);
        }
        assert!(Invocation::enter(1000).is_ok());
    }
}
