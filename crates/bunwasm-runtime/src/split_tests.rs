use super::*;
use std::fs;
use std::path::PathBuf;

struct Observation {
    session: u32,
    argv: Vec<String>,
    exec_argv: Vec<String>,
    resolved: Result<resolve::Resolved, String>,
}

thread_local! {
    static OBSERVATION: RefCell<Option<Observation>> = const { RefCell::new(None) };
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("bun-wasm-split-options-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, relative: &str) -> String {
        self.0.join(relative).to_str().unwrap().to_owned()
    }

    fn write(&self, relative: &str, source: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        ENGINE.with(|entry| entry.set(None));
        SESSION.with(|session| session.take());
        SESSION_STATE.with(|state| state.take());
        OBSERVATION.with(|observation| observation.take());
        let _ = fs::remove_dir_all(&self.0);
    }
}

extern "C" fn observe_options(session: u32) -> i32 {
    SESSION_STATE.with(|current| {
        let current = current.borrow();
        let Some(state) = current.as_ref() else {
            return 1;
        };
        let observation = Observation {
            session,
            argv: state.argv.clone(),
            exec_argv: state.exec_argv.clone(),
            resolved: state.resolver.resolve(
                "split-options",
                &state.main.borrow(),
                resolve::Kind::Import,
            ),
        };
        OBSERVATION.with(|current| current.replace(Some(observation)));
        0
    })
}

#[test]
fn retains_conditions_and_exec_argv() {
    assert!(ENGINE.with(Cell::get).is_none());
    let fixture = Fixture::new();
    fixture.write(
        "node_modules/split-options/package.json",
        r#"{"exports":{"split-custom":"./custom.js","default":"./default.js"}}"#,
    );
    fixture.write("node_modules/split-options/custom.js", "export default 42;");
    fixture.write("node_modules/split-options/default.js", "export default 0;");
    let entry = fixture.path("index.ts");
    assert_eq!(
        resolve::Resolver::new().resolve("split-options", &entry, resolve::Kind::Import),
        Ok(resolve::Resolved::File(
            fixture.path("node_modules/split-options/default.js")
        ))
    );
    let exec_argv = vec![
        "--conditions=split-custom".to_owned(),
        "--conditions".to_owned(),
        "second-custom".to_owned(),
    ];
    bun_core_bind_engine(observe_options);
    assert_eq!(
        run(Options {
            entry: Entry::File(entry.clone()),
            args: vec!["user-arg".to_owned()],
            conditions: vec!["split-custom".to_owned(), "second-custom".to_owned()],
            exec_argv: exec_argv.clone(),
            transpiler: Box::new(crate::PassthroughTranspiler),
        }),
        0
    );
    let observed = OBSERVATION.with(|current| current.take()).unwrap();
    assert_eq!(observed.session, 1);
    assert_eq!(observed.exec_argv, exec_argv);
    assert_eq!(&observed.argv[1..], &[entry, "user-arg".to_owned()]);
    assert_eq!(
        observed.resolved,
        Ok(resolve::Resolved::File(
            fixture.path("node_modules/split-options/custom.js")
        ))
    );
    assert!(SESSION.with(|session| session.borrow().is_none()));
    assert!(SESSION_STATE.with(|state| state.borrow().is_none()));
    let root = fixture.0.clone();
    drop(fixture);
    assert!(!root.exists());
    assert!(ENGINE.with(Cell::get).is_none());
}
