//! Shared plain-data operation identifiers, not VM methods.
pub(crate) const DESCRIBE: u32 = 1;
pub(crate) const RESOLVE: u32 = 2;
pub(crate) const PREPARE_SOURCE: u32 = 3;
pub(crate) const POLYFILL_SOURCE: u32 = 4;
pub(crate) const WRAPPER_SOURCE: u32 = 7;
pub(crate) const MAIN_PATH: u32 = 8;
#[allow(
    dead_code,
    reason = "Shared wire IDs need not be sent by every engine client."
)]
pub(crate) const LOWER_SCRIPT: u32 = 9;

/// Word operations of the split API itself, numbered from `ops::WORD_API` (after every word
/// native). The engine calls them on every job drain, so they take the word frame, which
/// allocates nothing.
pub(crate) const WORD_TAKE_TICK: u32 = 1 << 31;
pub(crate) const WORD_FLUSH: u32 = WORD_TAKE_TICK + 1;
