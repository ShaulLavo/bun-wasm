#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
enum Val {
    Str(String),
    Array(Vec<Val>),
    Object(Vec<(String, Val)>),
    Null,
}

impl From<&str> for Val {
    fn from(value: &str) -> Self {
        Self::Str(value.to_owned())
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Error {
        stack: Option<String>,
        throwing: &'static str,
    },
    Data(Val),
}

// Only the existing Engine operations used by the included production functions.
trait Engine {
    type Value: Clone;
    fn is_error(&self, value: &Self::Value) -> bool;
    fn get(&self, value: &Self::Value, key: &str) -> Result<Self::Value, Self::Value>;
    fn to_val(&self, value: &Self::Value) -> Val;
    fn value_from(&self, _: Val) -> Self::Value {
        panic!("entry reached")
    }
    fn error_value(&self, _: &String) -> Self::Value {
        panic!("entry reached")
    }
    fn eval_module(&self, _: &str, _: &str) -> Result<Self::Value, Self::Value> {
        panic!("entry reached")
    }
    fn promise_state(&self, _: &Self::Value) -> Option<()> {
        panic!("entry reached")
    }
}

struct Control;

impl Engine for Control {
    type Value = Value;

    fn is_error(&self, value: &Value) -> bool {
        matches!(value, Value::Error { .. })
    }

    fn get(&self, value: &Value, key: &str) -> Result<Value, Value> {
        let Value::Error { stack, throwing } = value else {
            panic!("primitive property probe")
        };
        if key == *throwing {
            return Err(Value::Data(Val::from("secondary getter failure")));
        }
        let text = match key {
            "name" => "TypeError",
            "message" => "original bootstrap failure",
            "stack" => stack.as_deref().unwrap_or(""),
            _ => panic!("unexpected property"),
        };
        Ok(Value::Data(Val::from(text)))
    }

    fn to_val(&self, value: &Value) -> Val {
        match value {
            Value::Data(value) => value.clone(),
            Value::Error { .. } => panic!("error converted through enumerable data"),
        }
    }
}

enum Entry {
    File(String),
    Eval(String),
    Test(Vec<String>),
}

struct Core<E: Engine> {
    internal: RefCell<Option<E::Value>>,
    original: E::Value,
    bootstraps: Cell<u32>,
}

impl<E: Engine> Core<E> {
    fn bootstrap(&self, _: &E) -> Result<E::Value, E::Value> {
        self.bootstraps.set(self.bootstraps.get() + 1);
        Err(self.original.clone())
    }
    fn eval_source(&self, _: &str) -> Result<(String, String), String> {
        panic!("entry reached")
    }
    fn call_internal(&self, _: &E, _: &str, _: &[E::Value]) -> Result<E::Value, E::Value> {
        panic!("entry reached")
    }
    fn uncaught(&self, _: &E, _: E::Value) {
        panic!("uncaught handler reached")
    }
    fn call_internal_num(&self, _: &E, _: &str) -> Result<f64, E::Value> {
        panic!("entry reached")
    }
}

fn run_event_loop<E: Engine>(_: &E, _: &Core<E>, _: Option<E::Value>, _: bool) {
    panic!("event loop reached")
}

// PRODUCTION_BOOTSTRAP_REPORTER

fn main() {
    let scenario = std::env::args().nth(1).unwrap();
    let original = match scenario.as_str() {
        "string" => Value::Data(Val::from("original string failure")),
        "object" => Value::Data(Val::Object(Vec::new())),
        "null" => Value::Data(Val::Null),
        _ => error(&scenario),
    };
    let core = Rc::new(Core {
        internal: RefCell::new(None),
        original: original.clone(),
        bootstraps: Cell::new(0),
    });
    let code = run_in_engine(
        &Control,
        &core,
        &Entry::File("must-not-run.ts".into()),
        "/must-not-run.ts",
    );
    assert_eq!(code, 70);
    assert_eq!(core.bootstraps.get(), 1);
    assert_eq!(core.original, original);
    assert!(core.internal.borrow().is_none());
    println!("original exception retained; entry not reached");
    std::process::exit(code);
}

fn error(scenario: &str) -> Value {
    let stack = match scenario {
        "quickjs" => Some(
            "TypeError: original bootstrap failure\n    at bootstrap (bun-wasm:bootstrap:42:7)",
        ),
        "no-stack" => None,
        _ => Some("bootstrap@bun-wasm:bootstrap:42:7"),
    };
    let throwing = match scenario {
        "throwing-stack" => "stack",
        "throwing-message" => "message",
        _ => "",
    };
    Value::Error {
        stack: stack.map(String::from),
        throwing,
    }
}
