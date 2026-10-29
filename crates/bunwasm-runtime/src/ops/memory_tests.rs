//! Peak allocation of the data transport, measured with the core crate's tracking allocator.

use super::tests::{allocated_frame, dispatcher, release_frame};
use super::*;
use crate::compression::tests::measure;

const PAYLOAD: usize = 4 << 20;
const SLACK: usize = 64 << 10;

fn write_file_args() -> Vec<Val> {
    vec![
        Val::from("/out/0.pack.gz"),
        Val::Bytes(vec![1; PAYLOAD]),
        Val::Num(577.0),
        Val::Num(438.0),
    ]
}

#[test]
fn encoding_a_leading_payload_is_one_exact_allocation() {
    let value = Val::Array(write_file_args());
    let (encoded, largest, peak) = measure(|| codec::encode(&value).unwrap());
    assert_eq!(encoded.capacity(), encoded.len());
    assert_eq!(largest, encoded.len());
    assert!(
        peak < encoded.len() + SLACK,
        "peak {peak} for {}",
        encoded.len()
    );
}

#[test]
fn request_costs_one_payload_beyond_its_arguments() {
    let dispatch = dispatcher(|args| Ok(Val::from(args.bytes(1)?.len() as f64)));
    let (result, largest, peak) = measure(|| dispatch.call(write_file_args()));
    assert_eq!(result.unwrap(), Val::from(PAYLOAD as f64));
    assert!(largest < PAYLOAD + SLACK, "largest {largest}");
    assert!(peak < 2 * PAYLOAD + SLACK, "peak {peak}");
}

#[test]
fn reply_is_encoded_straight_into_its_transport_allocation() {
    let transport = abi::Transport::default();
    let dispatch = dispatcher(|_| {
        Ok(Val::Array(vec![
            Val::Bytes(vec![2; PAYLOAD]),
            Val::from("map"),
        ]))
    });
    let frame = allocated_frame(&transport, dispatch.op(), vec![]);
    let (status, largest, peak) = measure(|| transport.dispatch(&dispatch, frame.0));
    assert_eq!(status, Status::Ok);
    let reply = release_frame(&transport, frame.0, frame.1, frame.2);
    assert_eq!(largest, reply.len());
    assert!(peak < 2 * PAYLOAD + SLACK, "peak {peak}");
    assert_eq!(
        codec::decode(&reply).unwrap(),
        Val::Array(vec![Val::Bytes(vec![2; PAYLOAD]), Val::from("map")])
    );
    assert_eq!(transport.live_allocations(), 0);
}

#[test]
fn transport_encoding_is_the_only_copy_and_frees_cleanly() {
    let transport = abi::Transport::default();
    let value = Val::Array(write_file_args());
    let ((pointer, len), largest, peak) = measure(|| transport.encode(&value).unwrap());
    assert_eq!(len as usize, codec::encoded_len(&value).unwrap());
    assert_eq!(largest, len as usize);
    assert!(peak < len as usize + SLACK, "peak {peak}");
    assert_eq!(transport.live_allocations(), 1);
    assert_eq!(
        transport.read(pointer, len).unwrap(),
        codec::encode(&value).unwrap()
    );
    transport.free(pointer, len, Frame::ALIGN).unwrap();
    assert_eq!(transport.live_allocations(), 0);
}
