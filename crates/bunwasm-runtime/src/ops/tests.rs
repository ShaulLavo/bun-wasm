use std::cell::{Cell, RefCell};
use std::rc::Rc;

use super::*;

fn request(values: Vec<Val>) -> Vec<u8> {
    codec::encode(&Val::Array(values)).unwrap()
}

fn dispatcher(function: impl Fn(Args<'_>) -> NativeResult + 'static) -> Dispatcher {
    Dispatcher::new(NonZeroU32::MIN, 17, Rc::new(function)).unwrap()
}

#[test]
fn codec_roundtrips_all_tags_and_record_order() {
    let value = Val::Array(vec![
        Val::Undefined,
        Val::Null,
        Val::Bool(false),
        Val::Bool(true),
        Val::Num(-0.0),
        Val::Num(f64::INFINITY),
        Val::Num(f64::NEG_INFINITY),
        Val::BigInt(i64::MIN),
        Val::BigInt(i64::MAX),
        Val::BigUint(u64::MAX),
        Val::Str("héllo\0世界".into()),
        Val::Bytes(vec![0, 255, 128]),
        Val::Object(vec![
            ("z".into(), Val::Undefined),
            ("a".into(), Val::Array(vec![])),
        ]),
    ]);
    let encoded = codec::encode(&value).unwrap();
    let decoded = codec::decode(&encoded).unwrap();
    assert_eq!(decoded, value);
    assert_eq!(codec::encode(&decoded).unwrap(), encoded);
    let Val::Array(values) = decoded else {
        unreachable!()
    };
    let Val::Num(zero) = values[4] else {
        unreachable!()
    };
    assert_eq!(zero.to_bits(), (-0.0f64).to_bits());
    let nan = Val::Num(f64::from_bits(0x7ff8_0000_0000_0042));
    assert_eq!(
        codec::encode(&codec::decode(&codec::encode(&nan).unwrap()).unwrap()).unwrap(),
        codec::encode(&nan).unwrap()
    );
}

#[test]
fn codec_matches_legacy_tag_bytes_without_permissive_decoding() {
    let value = Val::Object(vec![(
        "x".into(),
        Val::Array(vec![Val::Bool(true), Val::Bytes(vec![1, 2])]),
    )]);
    assert_eq!(
        codec::encode(&value).unwrap(),
        vec![
            8, 1, 0, 0, 0, 1, 0, 0, 0, b'x', 7, 2, 0, 0, 0, 3, 6, 2, 0, 0, 0, 1, 2
        ]
    );
}

#[test]
fn codec_rejects_truncation_tags_utf8_counts_and_trailing_bytes() {
    let valid = codec::encode(&Val::Object(vec![(
        "key".into(),
        Val::Bytes(vec![1, 2, 3]),
    )]))
    .unwrap();
    for end in 0..valid.len() {
        assert!(
            codec::decode(&valid[..end]).is_err(),
            "accepted prefix {end}"
        );
    }
    let malformed = [
        vec![11],
        vec![255],
        vec![0, 0],
        vec![5, 1, 0, 0, 0, 255],
        vec![6, 255, 255, 255, 255],
        vec![7, 255, 255, 255, 255],
        vec![8, 1, 0, 0, 0, 0],
        vec![8, 1, 0, 0, 0, 1, 0, 0, 0, 255, 0],
    ];
    for bytes in malformed {
        assert!(codec::decode(&bytes).is_err(), "accepted {bytes:?}");
    }
}

#[test]
fn codec_nesting_is_structural_not_a_draft_policy_cap() {
    let mut encoded = Vec::new();
    for _ in 0..512 {
        encoded.extend_from_slice(&[7, 1, 0, 0, 0]);
    }
    encoded.push(0);
    let value = codec::decode(&encoded).unwrap();
    assert_eq!(codec::encode(&value).unwrap(), encoded);
}

#[test]
fn invalid_calls_cannot_invoke_the_native() {
    let calls = Rc::new(Cell::new(0));
    let observed = calls.clone();
    let dispatch = dispatcher(move |_| {
        observed.set(observed.get() + 1);
        Ok(Val::Undefined)
    });
    assert_eq!(
        dispatch.dispatch(0, 1, request(vec![])).status,
        Status::BadCall
    );
    assert_eq!(
        dispatch.dispatch(dispatch.op(), 0, request(vec![])).status,
        Status::BadCall
    );
    assert_eq!(
        dispatch.dispatch(dispatch.op(), 2, request(vec![])).status,
        Status::BadCall
    );
    assert_eq!(
        dispatch.dispatch(dispatch.op(), 1, vec![0]).status,
        Status::BadCall
    );
    assert_eq!(
        dispatch
            .dispatch(dispatch.op(), 1, vec![7, 1, 0, 0, 0])
            .status,
        Status::BadCall
    );
    assert_eq!(calls.get(), 0);
    assert_eq!(dispatch.call(vec![]).unwrap(), Val::Undefined);
    assert_eq!(calls.get(), 1);
}

#[test]
fn replies_keep_independent_owned_storage_across_later_calls() {
    let dispatch = dispatcher(|args| Ok(args.get(0).clone()));
    let first = dispatch.dispatch(dispatch.op(), 1, request(vec![Val::Bytes(vec![3; 4096])]));
    let expected = first.bytes.clone();
    let second = dispatch.dispatch(dispatch.op(), 1, request(vec![Val::Str("second".into())]));
    assert_eq!(first.bytes, expected);
    assert_eq!(first.into_result().unwrap(), Val::Bytes(vec![3; 4096]));
    assert_eq!(second.into_result().unwrap(), Val::Str("second".into()));
}

#[test]
fn native_errors_remain_data_with_ordered_duplicate_properties() {
    let dispatch = dispatcher(|_| {
        Err(NativeError::type_error("bad\0argument")
            .named("CustomError")
            .prop("code", "EIO")
            .prop("errno", -5)
            .prop("code", "again"))
    });
    let reply = dispatch.dispatch(dispatch.op(), 1, request(vec![]));
    assert_eq!(reply.status, Status::NativeError);
    let error = reply.into_result().unwrap_err();
    assert_eq!(error.kind, ErrorKind::TypeError);
    assert_eq!(error.name.as_deref(), Some("CustomError"));
    assert_eq!(error.message, "bad\0argument");
    assert_eq!(
        error.props,
        vec![
            ("code".into(), Val::from("EIO")),
            ("errno".into(), Val::from(-5)),
            ("code".into(), Val::from("again"))
        ]
    );
}

#[test]
fn nested_calls_keep_outer_arguments_owned() {
    let slot: Rc<RefCell<Option<Rc<Dispatcher>>>> = Rc::new(RefCell::new(None));
    let nested_slot = slot.clone();
    let dispatch = Rc::new(dispatcher(move |args| {
        if args.bool(1) {
            return Err(NativeError::range_error("nested failure"));
        }
        let nested = nested_slot.borrow().as_ref().unwrap().clone();
        let error = nested
            .call(vec![Val::Undefined, Val::Bool(true)])
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::RangeError);
        let growing = vec![42; 128 * 1024];
        std::hint::black_box(&growing);
        assert_eq!(args.bytes(0)?, &[1, 0, 255]);
        Ok(Val::Bytes(args.bytes(0)?.to_vec()))
    }));
    *slot.borrow_mut() = Some(dispatch.clone());
    assert_eq!(
        dispatch.call(vec![Val::Bytes(vec![1, 0, 255])]).unwrap(),
        Val::Bytes(vec![1, 0, 255])
    );
    slot.borrow_mut().take();
    assert_eq!(Rc::strong_count(&dispatch), 1);
}

#[test]
fn call_buffers_and_native_closures_are_released() {
    let marker = Rc::new(());
    let retained = marker.clone();
    let dispatch = dispatcher(move |_| {
        let _ = &retained;
        Ok(Val::Undefined)
    });
    for _ in 0..32 {
        assert_eq!(
            dispatch.call(vec![Val::Bytes(vec![7; 8192])]).unwrap(),
            Val::Undefined
        );
    }
    assert_eq!(Rc::strong_count(&marker), 2);
    drop(dispatch);
    assert_eq!(Rc::strong_count(&marker), 1);
}

#[test]
fn frame_span_checks_alignment_bounds_overlap_and_initial_reply() {
    let frame = Frame {
        op: DATA_NATIVE,
        session: 1,
        request_ptr: 32,
        request_len: 5,
        reply_ptr: 0,
        reply_len: 0,
    };
    assert_eq!(frame.request(8, 64).unwrap(), 32..37);
    assert_eq!(frame.request(8, 36), Err(Status::BadCall));
    assert_eq!(frame.request(9, 64), Err(Status::BadCall));
    assert_eq!(
        Frame {
            request_ptr: 24,
            ..frame
        }
        .request(8, 64),
        Err(Status::BadCall)
    );
    assert_eq!(
        Frame {
            request_ptr: 0,
            ..frame
        }
        .request(8, 64),
        Err(Status::BadCall)
    );
    assert_eq!(
        Frame {
            request_ptr: u32::MAX - 7,
            request_len: 16,
            ..frame
        }
        .request(8, 64),
        Err(Status::BadCall)
    );
    assert_eq!(
        Frame {
            reply_ptr: 64,
            ..frame
        }
        .request(8, 128),
        Err(Status::BadCall)
    );
    assert_eq!(
        Frame {
            reply_len: 1,
            ..frame
        }
        .request(8, 128),
        Err(Status::BadCall)
    );
    let words: [u32; 6] = [DATA_NATIVE, 1, 32, 5, 0, 0];
    let mut memory = vec![0; 64];
    for (offset, word) in words.into_iter().enumerate() {
        memory[8 + offset * 4..12 + offset * 4].copy_from_slice(&word.to_le_bytes());
    }
    assert_eq!(Frame::read(&memory, 8).unwrap(), frame);
    assert_eq!(Frame::read(&memory[..31], 8), Err(Status::BadCall));
    assert_eq!(Frame::read(&memory, 1), Err(Status::BadCall));
}

fn allocated_frame(transport: &abi::Transport, op: u32, values: Vec<Val>) -> (u32, u32, u32) {
    let request = request(values);
    let len = request.len() as u32;
    let pointer = transport.alloc(len, Frame::ALIGN);
    let frame = transport.alloc(Frame::SIZE as u32, Frame::ALIGN);
    transport.write(pointer, &request).unwrap();
    transport
        .write(frame, &abi::frame_bytes(op, 1, pointer, len))
        .unwrap();
    (frame, pointer, len)
}

fn release_frame(transport: &abi::Transport, frame: u32, pointer: u32, len: u32) -> Vec<u8> {
    let result = Frame::decode(&transport.read(frame, Frame::SIZE as u32).unwrap()).unwrap();
    let bytes = transport.read(result.reply_ptr, result.reply_len).unwrap();
    transport
        .free(result.reply_ptr, result.reply_len, Frame::ALIGN)
        .unwrap();
    transport.free(pointer, len, Frame::ALIGN).unwrap();
    transport
        .free(frame, Frame::SIZE as u32, Frame::ALIGN)
        .unwrap();
    bytes
}

#[test]
fn physical_frames_keep_replies_alive_and_reject_unowned_memory() {
    let transport = abi::Transport::default();
    let dispatch = dispatcher(|args| Ok(args.get(0).clone()));
    let first = allocated_frame(&transport, dispatch.op(), vec![Val::from("first")]);
    assert_eq!(transport.dispatch(&dispatch, first.0), Status::Ok);
    let saved_frame = transport.read(first.0, Frame::SIZE as u32).unwrap();
    let second = allocated_frame(
        &transport,
        dispatch.op(),
        vec![Val::Bytes(vec![0, 128, 255])],
    );
    assert_eq!(transport.dispatch(&dispatch, second.0), Status::Ok);
    assert_eq!(
        transport.read(first.0, Frame::SIZE as u32).unwrap(),
        saved_frame
    );
    assert_eq!(
        codec::decode(&release_frame(&transport, first.0, first.1, first.2)).unwrap(),
        Val::from("first")
    );
    assert_eq!(
        codec::decode(&release_frame(&transport, second.0, second.1, second.2)).unwrap(),
        Val::Bytes(vec![0, 128, 255])
    );
    assert_eq!(transport.live_allocations(), 0);
    assert_eq!(transport.dispatch(&dispatch, first.0), Status::BadCall);
    assert_eq!(transport.read(4000, 24), Err(Status::BadCall));
    assert_eq!(transport.alloc(1, 3), 0);
    assert_eq!(transport.alloc(0, 8), 0);
}

#[test]
fn physical_nested_calls_can_grow_allocations_without_borrowing_outer_memory() {
    let transport = Rc::new(abi::Transport::default());
    let nested_transport = transport.clone();
    let outer_pointer = Rc::new(Cell::new(0));
    let active_frame = outer_pointer.clone();
    let inner = dispatcher(|args| Ok(args.get(0).clone()));
    let dispatch = dispatcher(move |args| {
        assert_eq!(
            nested_transport.free(active_frame.get(), Frame::SIZE as u32, Frame::ALIGN),
            Err(Status::BadCall)
        );
        assert_eq!(
            nested_transport.dispatch(&inner, active_frame.get()),
            Status::BadCall
        );
        let nested = allocated_frame(
            &nested_transport,
            inner.op(),
            vec![Val::Bytes(vec![9; 128 * 1024])],
        );
        assert_eq!(nested_transport.dispatch(&inner, nested.0), Status::Ok);
        let bytes = release_frame(&nested_transport, nested.0, nested.1, nested.2);
        assert_eq!(
            codec::decode(&bytes).unwrap(),
            Val::Bytes(vec![9; 128 * 1024])
        );
        Ok(args.get(0).clone())
    });
    let frame = allocated_frame(&transport, dispatch.op(), vec![Val::from("outer")]);
    outer_pointer.set(frame.0);
    assert_eq!(transport.dispatch(&dispatch, frame.0), Status::Ok);
    assert_eq!(
        codec::decode(&release_frame(&transport, frame.0, frame.1, frame.2)).unwrap(),
        Val::from("outer")
    );
    assert_eq!(transport.live_allocations(), 0);
}

#[test]
fn physical_native_error_and_wrong_free_sizes_release_every_allocation() {
    let transport = abi::Transport::default();
    let dispatch = dispatcher(|_| Err(NativeError::range_error("failure")));
    let frame = allocated_frame(&transport, dispatch.op(), vec![]);
    assert_eq!(
        transport.free(frame.1, frame.2 + 1, Frame::ALIGN),
        Err(Status::BadCall)
    );
    assert_eq!(transport.dispatch(&dispatch, frame.0), Status::NativeError);
    let bytes = release_frame(&transport, frame.0, frame.1, frame.2);
    assert_eq!(decode_error(&bytes).unwrap().kind, ErrorKind::RangeError);
    assert_eq!(transport.live_allocations(), 0);
    assert_eq!(
        transport.free(frame.1, frame.2, Frame::ALIGN),
        Err(Status::BadCall)
    );
}
