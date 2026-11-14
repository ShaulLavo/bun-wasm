use super::*;

struct Fixture {
    previous_host: Option<Rc<Host>>,
    previous_result: Vec<u8>,
    state: Rc<State>,
    names: Vec<&'static str>,
}

impl Fixture {
    fn new() -> Self {
        let previous_host = HOST.with(|h| h.borrow_mut().take());
        let previous_result = RESULT.with(|r| std::mem::take(&mut *r.borrow_mut()));
        let state = Rc::new(State::new(
            vec!["bun".into(), "entry.mjs".into()],
            Box::new(crate::PassthroughTranspiler),
        ));
        let table = crate::natives::table(&state);
        let mut names: Vec<_> = table.functions.iter().map(|(name, _)| *name).collect();
        names.extend(table.words.iter().map(|(name, _)| *name));
        names.extend([
            "hostModuleSource",
            "hostUseModuleRecords",
            "hostModuleRecord",
            "hostCjsSource",
            "hostEsmAsCjs",
            "polyfillSource",
            "flushOutput",
        ]);
        init(
            Entry::File("entry.mjs".into()),
            state.clone(),
            "/entry.mjs".into(),
        );
        Self {
            previous_host,
            previous_result,
            state,
            names,
        }
    }

    fn index(&self, name: &str) -> u32 {
        self.names.iter().position(|n| *n == name).unwrap() as u32
    }

    fn owned_response(&self, index: u32, args: &[Val]) -> (i32, Vec<u8>) {
        let f = host().functions[index as usize].1.clone();
        let (status, value) = match f(Args(args)) {
            Ok(value) => (0, value),
            Err(error) => (1, error_val(&error)),
        };
        let mut wire = Vec::new();
        encode(&value, &mut wire);
        (status, wire)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        HOST.with(|h| *h.borrow_mut() = self.previous_host.take());
        RESULT.with(|r| *r.borrow_mut() = std::mem::take(&mut self.previous_result));
    }
}

fn result_bytes() -> Vec<u8> {
    // The exported region is owned by RESULT and is copied before another call.
    unsafe {
        std::slice::from_raw_parts(bunwasm_result_ptr(), bunwasm_result_len() as usize).to_vec()
    }
}

fn call_value(index: u32, value: &Val) -> (i32, Vec<u8>) {
    let mut input = Vec::new();
    encode(value, &mut input);
    let len = input.len() as u32;
    let ptr = bunwasm_alloc(len);
    // SAFETY: the allocation has exactly len writable bytes and is consumed once.
    let status = unsafe {
        std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
        bunwasm_call(index, ptr, len)
    };
    (status, result_bytes())
}

fn call(index: u32, args: &[Val]) -> (i32, Vec<u8>) {
    call_value(index, &Val::Array(args.to_vec()))
}

pub(crate) fn registration_and_dispatch() {
    let fixture = Fixture::new();
    let names: Vec<_> = host().functions.iter().map(|(name, _)| *name).collect();
    assert_eq!(names, fixture.names);
    let index = fixture.index("polyfillSource");
    assert_eq!(host().polyfill_source, index as usize);
    assert_eq!(index as usize, names.len() - 2);
    assert_eq!(bunwasm_describe(), 0);
    let Val::Object(fields) = decode(&result_bytes()) else {
        panic!("expected native description");
    };
    let expected = Val::Array(names.iter().map(|name| Val::from(*name)).collect());
    assert_eq!(
        fields.iter().find(|(key, _)| key == "natives").unwrap().1,
        expected
    );
    for name in ["cwd", "argv", "flushOutput"] {
        let ordinary = fixture.index(name);
        assert_eq!(call(ordinary, &[]), fixture.owned_response(ordinary, &[]));
    }
    let args = [Val::from("net")];
    assert_eq!(call(index, &args), fixture.owned_response(index, &args));
    assert_eq!(call_value(index, &args[0]), call(index, &args));
    assert!(fixture.state.positions.borrow().is_empty());
    let invalid = names.len() as u32;
    let mut error = Vec::new();
    encode(
        &error_val(&NativeError::error(format!(
            "bun-wasm: no native #{invalid}"
        ))),
        &mut error,
    );
    assert_eq!(call(invalid, &args), (1, error));
}

pub(crate) fn source_and_errors() {
    let fixture = Fixture::new();
    let index = fixture.index("polyfillSource");
    for name in ["bootstrap", "net", "", "missing", "net\0", "é😀"] {
        let args = [Val::from(name)];
        assert_eq!(call(index, &args), fixture.owned_response(index, &args));
    }
    for args in [
        vec![],
        vec![Val::Null],
        vec![Val::Num(7.0)],
        vec![Val::Bytes(vec![1])],
    ] {
        assert_eq!(call(index, &args), fixture.owned_response(index, &args));
        assert_eq!(call(index, &args).0, 1);
    }
    assert_eq!(call(index, &[Val::from("missing")]), (0, vec![T_UNDEFINED]));
}

pub(crate) fn string_wire_and_result_ownership() {
    for (text, bytes) in [
        ("", vec![5, 0, 0, 0, 0]),
        (
            "é😀",
            vec![5, 6, 0, 0, 0, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80],
        ),
        ("a\0b", vec![5, 3, 0, 0, 0, b'a', 0, b'b']),
    ] {
        let mut output = Vec::new();
        let mut source = text.to_owned();
        encode_string(&source, &mut output);
        assert_eq!(output, bytes);
        source.clear();
        assert_eq!(decode(&output), Val::from(text));
        output.clear();
        encode(&Val::from(text), &mut output);
        assert_eq!(output, bytes);
    }
    let fixture = Fixture::new();
    let index = fixture.index("polyfillSource");
    let (_, net) = call(index, &[Val::from("net")]);
    let (pointer, capacity) = RESULT.with(|r| (r.borrow().as_ptr(), r.borrow().capacity()));
    assert_ne!(pointer, modules::polyfill_source("net").unwrap().as_ptr());
    for name in ["bootstrap", "net", "missing", "net"] {
        let args = [Val::from(name)];
        assert_eq!(call(index, &args), fixture.owned_response(index, &args));
        assert_eq!(
            RESULT.with(|r| (r.borrow().as_ptr(), r.borrow().capacity())),
            (pointer, capacity)
        );
    }
    assert_eq!(
        decode(&net),
        Val::from(modules::polyfill_source("net").unwrap())
    );
}

pub(crate) fn reentry() {
    let fixture = Fixture::new();
    let index = fixture.index("polyfillSource");
    let callback: DataFn = Rc::new(move |_| {
        assert_eq!(Rc::strong_count(&host()), 2);
        HOST.with(|h| assert!(h.try_borrow_mut().is_ok()));
        RESULT.with(|r| assert!(r.try_borrow_mut().is_ok()));
        let (status, bytes) = call(index, &[Val::from("bootstrap")]);
        assert_eq!(status, 0);
        assert_eq!(
            decode(&bytes),
            Val::from(modules::polyfill_source("bootstrap").unwrap())
        );
        RESULT.with(|r| assert!(r.try_borrow_mut().is_ok()));
        Ok(Val::from("outer\0é"))
    });
    let callback_index = HOST.with(|h| {
        let mut h = h.borrow_mut();
        let h = Rc::get_mut(h.as_mut().unwrap()).unwrap();
        let index = h.functions.len() as u32;
        h.functions.push(("testReentry", callback));
        index
    });
    let (status, bytes) = call(callback_index, &[]);
    assert_eq!(status, 0);
    assert_eq!(decode(&bytes), Val::from("outer\0é"));
    assert_eq!(call(index, &[Val::from("missing")]), (0, vec![T_UNDEFINED]));
    assert_eq!(decode(&bytes), Val::from("outer\0é"));
}
