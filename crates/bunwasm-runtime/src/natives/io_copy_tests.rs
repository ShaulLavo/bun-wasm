//! Direct Rust allocation coverage, with a companion shared-JS embedding check.

use super::*;
use crate::compression::tests::measure;
use crate::ops::Dispatcher;
use std::cell::Cell;
use std::hint::black_box;
use std::io::{Seek, SeekFrom};
use std::num::NonZeroU32;
use std::path::PathBuf;

const MIB: usize = 1 << 20;
const SIZE: usize = 40 * MIB;
const LIMIT: usize = 8 * MIB;

#[path = "io_embedding_tests.rs"]
mod embedding;

struct Fixture(PathBuf);

impl Fixture {
    fn new(data: &[u8]) -> Self {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let path = std::env::temp_dir().join(format!(
            "bun-wasm-io-copy-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let fixture = Self(path);
        file.write_all(data).unwrap();
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_file(&self.0).unwrap();
    }
}

// Match the shared JS regular-file loop's requests, then run the real native and
// physical transport. This deliberately does not stand in for executing that JS.
fn read_pieces(
    dispatch: &Dispatcher,
    fd: i32,
    target: &mut [u8],
    position: Option<usize>,
) -> usize {
    let mut count = 0;
    while count < target.len() {
        let want = MIB.min(target.len() - count);
        let at = position.map_or(-1.0, |at| (at + count) as f64);
        let value = dispatch
            .call(vec![fd.into(), (want as f64).into(), at.into()])
            .unwrap();
        let Val::Bytes(bytes) = value else {
            panic!("read must return bytes")
        };
        assert!(bytes.len() <= want);
        target[count..count + bytes.len()].copy_from_slice(&bytes);
        count += bytes.len();
        if bytes.len() < want {
            return count;
        }
    }
    count
}

fn allocation_sample(whole_copy_control: bool) -> (usize, usize) {
    // Legitimate caller-owned input/destination allocations precede measurement.
    let data: Vec<u8> = (0..SIZE).map(|i| (i % 251) as u8).collect();
    let fixture = Fixture::new(&data);
    let mut file = File::open(&fixture.0).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut target = vec![0x9d; SIZE + 5];
    let control_path = fixture.0.clone();
    let copy_once = Cell::new(whole_copy_control);
    let function: DataFn = Rc::new(move |args| {
        if copy_once.replace(false) {
            // Same requests and data as the bounded arm; hide a whole-file copy
            // before the first piece. A wire-piece limit alone misses this.
            let copy = fs::read(&control_path).unwrap();
            assert_eq!(copy.len(), SIZE);
            black_box(&copy);
        }
        read_descriptor(args)
    });
    let dispatch = Dispatcher::new(NonZeroU32::MIN, 17, function).unwrap();
    let (_, largest, peak) = measure(|| {
        assert_eq!(
            read_pieces(&dispatch, file.as_raw_fd(), &mut target, Some(0)),
            SIZE
        );
        assert_eq!(&target[..SIZE], data.as_slice());
        assert_eq!(&target[SIZE..], &[0x9d; 5]);
        assert_eq!(file.stream_position().unwrap(), 0);
        assert_eq!(
            read_pieces(&dispatch, file.as_raw_fd(), &mut target[..3 * MIB], None),
            3 * MIB
        );
        assert_eq!(&target[..3 * MIB], &data[..3 * MIB]);
        assert_eq!(
            read_pieces(&dispatch, file.as_raw_fd(), &mut target[..3 * MIB], None),
            3 * MIB
        );
        assert_eq!(&target[..3 * MIB], &data[3 * MIB..6 * MIB]);
        assert_eq!(
            read_pieces(&dispatch, file.as_raw_fd(), &mut target[..SIZE], Some(MIB)),
            SIZE - MIB
        );
        assert_eq!(&target[..SIZE - MIB], &data[MIB..]);
        assert_eq!(file.stream_position().unwrap(), (6 * MIB) as u64);
    });
    println!(
        "whole_copy_control={whole_copy_control}, largest={largest}, peak={peak}, limit={LIMIT}"
    );
    (largest, peak)
}

fn assert_bounded((largest, peak): (usize, usize)) {
    assert!(
        largest < LIMIT && peak < LIMIT,
        "shared read allocated a whole-request-sized temporary: largest={largest}, peak={peak}, limit={LIMIT}"
    );
}

#[test]
fn bounded_read_and_transport_stay_below_whole_request_allocation() {
    assert_bounded(allocation_sample(false));
}

#[test]
#[should_panic(expected = "shared read allocated a whole-request-sized temporary")]
fn hidden_whole_copy_fails_the_same_read_allocation_limit() {
    let sample = allocation_sample(true);
    assert!(
        sample.0 >= SIZE,
        "positive control must observe the 40 MiB copy"
    );
    assert_bounded(sample);
}
