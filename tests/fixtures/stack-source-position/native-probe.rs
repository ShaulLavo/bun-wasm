// Supplemental std-only execution of exact extracted State/native functions.
// The full native test also lives in natives.rs and runs in the existing Cargo gate.
#![allow(dead_code)]
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[path = "__STACK_PATH__"]
mod stack_position;
#[path = "__MAP_PATH__"]
mod sourcemap;
mod modules {
    use std::rc::Rc;
    #[derive(Clone, Copy)]
    pub enum Format { Cjs }
    __POSITION_MAP__
}
struct State {
    sources: RefCell<HashMap<String, (Rc<str>, modules::Format)>>,
    positions: RefCell<HashMap<String, modules::PositionMap>>,
}
struct PassthroughTranspiler;
impl State {
    fn new(_: Vec<String>, _: Box<PassthroughTranspiler>) -> Self {
        Self { sources: RefCell::new(HashMap::new()), positions: RefCell::new(HashMap::new()) }
    }
    __SOURCE_METHODS__
}
__PLAIN_VALUES__
__WIRE_ENCODER__
type NativeResult = Result<Val, &'static str>;
struct Args<'a>(&'a [Val]);
impl Args<'_> {
    fn str(&self, index: usize) -> Result<&str, &'static str> {
        match self.0.get(index) { Some(Val::Str(value)) => Ok(value), _ => Err("string") }
    }
    fn num(&self, index: usize) -> Result<f64, &'static str> {
        match self.0.get(index) { Some(Val::Num(value)) => Ok(*value), _ => Err("number") }
    }
    fn u32(&self, index: usize) -> Result<u32, &'static str> { self.num(index).map(|n| n as u32) }
}
type DataFn = Rc<dyn Fn(Args<'_>) -> NativeResult>;
#[derive(Default)]
struct Table { functions: Vec<(&'static str, DataFn)> }
impl Table {
    fn add(&mut self, name: &'static str, f: impl Fn(Args<'_>) -> NativeResult + 'static) {
        self.functions.push((name, Rc::new(f)));
    }
}
fn table(state: &Rc<State>) -> Table {
    let mut t = Table::default();
    __NATIVE_BODY__
    t
}
fn call(table: &Table, name: &str, args: &[Val]) -> NativeResult {
    table.functions.iter().find(|(key, _)| *key == name).unwrap().1(Args(args))
}
__NATIVE_TEST__

#[test]
fn numeric_stack_result_has_a_constant_real_wire_size() {
    let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
    let natives = table(&state);
    let source = format!("new Error();/*{}*/", "x".repeat(4 * 1024 * 1024));
    state.sources.borrow_mut().insert("/huge.cjs".into(), (Rc::from(source.as_str()), modules::Format::Cjs));
    let args = [Val::from("/huge.cjs"), Val::Num(1.0), Val::Num(1.0)];
    let mut offset = Vec::new();
    encode(&call(&natives, "sourceNewOffset", &args).unwrap(), &mut offset);
    let mut line = Vec::new();
    encode(&call(&natives, "getSourceLine", &args[..2]).unwrap(), &mut line);
    assert_eq!(offset.len(), 9);
    assert_eq!(offset[0], T_NUM);
    assert_eq!(line.len(), source.len() + 5);
    println!("wire bytes: numeric={}, full-line={}, frames64_numeric={}", offset.len(), line.len(), offset.len() * 64);
}

#[cfg(not(test))]
fn main() {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let state = Rc::new(State::new(Vec::new(), Box::new(PassthroughTranspiler)));
    let natives = table(&state);
    for case in input.lines() {
        let mut fields = case.split(' ');
        let column: f64 = fields.next().unwrap().parse().unwrap();
        let line: f64 = fields.next().unwrap().parse().unwrap();
        let hex = fields.next().unwrap();
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let text = String::from_utf8(bytes).unwrap();
        state.sources.borrow_mut().insert("/query".into(), (Rc::from(text), modules::Format::Cjs));
        let result = call(&natives, "sourceNewOffset", &[Val::from("/query"), Val::Num(line), Val::Num(column)]).unwrap();
        let Val::Num(offset) = result else { panic!("numeric offset required") };
        println!("{offset}");
    }
}
