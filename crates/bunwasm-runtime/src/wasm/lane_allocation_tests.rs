//! The staged commit of a post asks the allocator for nothing: it runs after the transfer
//! native's first detach, where a failed allocation could no longer be reported as "nothing
//! moved". This counts on the host build of the lane code, with this crate's test allocator.
//! It is not a guest measurement.

use crate::compression::tests::measure;

#[test]
fn the_staged_commit_of_a_post_that_carries_ports_allocates_nothing() {
    crate::wasm::lane::tests::staged_commit_under(|commit| {
        let ((), largest, _) = measure(commit);
        assert_eq!(largest, 0, "bytes asked for during the commit");
    });
    // The same counter sees an allocation when there is one.
    let (_, largest, _) = measure(|| std::hint::black_box(vec![0u8; 64]));
    assert!(largest >= 64);
}
