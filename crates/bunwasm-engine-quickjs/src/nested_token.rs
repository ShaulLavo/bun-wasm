//! Invocation identities need uniqueness only while an entry is active.
pub(super) fn next_token(previous: u32, active: impl Fn(u32) -> bool) -> u32 {
    let mut token = previous.wrapping_add(1).max(1);
    while active(token) {
        token = token.wrapping_add(1).max(1);
    }
    token
}

#[cfg(test)]
mod tests {
    use super::next_token;
    #[test]
    fn invocation_tokens_wrap_without_aliasing_active_entries() {
        assert_eq!(next_token(u32::MAX - 1, |_| false), u32::MAX);
        assert_eq!(next_token(u32::MAX, |_| false), 1);
        assert_eq!(next_token(u32::MAX, |token| [1, 2].contains(&token)), 3);
        assert_eq!(
            next_token(u32::MAX - 1, |token| [u32::MAX, 1].contains(&token)),
            2
        );
    }
}
