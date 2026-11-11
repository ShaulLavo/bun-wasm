//! The address space of one shared-group memory (docs/memory-ceiling.md, stage 2).
//! `group-address-space.txt` is its one authority; this file is its only Rust reader, shared by
//! the core's build script and the native host through `#[path]`, beside `max_memory.rs`.
//!
//! It bounds where a group's members and regions may be placed. What a Bun guest may itself
//! hold stays `max-memory.txt`: split links, engine heap sizing and a group's member cap.

use super::max_memory;

/// Bytes: a whole number of pages, at most 2 GiB, so every address and one-past-end stays
/// representable as the non-negative i32 or `0x80000000` the hosts already handle.
pub const GROUP_ADDRESS_SPACE_BYTES: u64 =
    max_memory::parse(include_str!("group-address-space.txt"));

const _: () = assert!(
    GROUP_ADDRESS_SPACE_BYTES >= max_memory::MAX_MEMORY_BYTES,
    "group-address-space.txt must hold at least the guest memory maximum"
);
