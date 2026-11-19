//! Original test: the launcher's private executables folder never outlives it.
//! A launcher removes its own folder when it exits, and the next launcher removes
//! folders left by one that was killed, but never a running process's folder.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const PREFIX: &str = "bun-wasm-executables-";

fn section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
    assert!(payload.len() < 128);
    module.extend_from_slice(&[id, payload.len() as u8]);
    module.extend_from_slice(payload);
}

/// A guest exporting `_start` (with the given body) and `memory`, encoded directly.
fn guest(body: &[u8]) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[1, 0x60, 0, 0]);
    section(&mut module, 3, &[1, 0]);
    section(&mut module, 5, &[1, 0, 1]);
    let mut exports = vec![2, 6];
    exports.extend_from_slice(b"_start");
    exports.extend_from_slice(&[0, 0, 6]);
    exports.extend_from_slice(b"memory");
    exports.extend_from_slice(&[2, 0]);
    section(&mut module, 7, &exports);
    let mut code = vec![1, body.len() as u8];
    code.extend_from_slice(body);
    section(&mut module, 10, &code);
    module
}

fn folders(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with(PREFIX))
        .collect();
    names.sort_unstable();
    names
}

fn launcher(scratch: &Path, wasm: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bun-wasm"));
    command
        .arg("--wasm")
        .arg(wasm)
        .current_dir(scratch)
        .env("TMPDIR", scratch)
        .stdin(Stdio::null());
    command
}

/// Removes the scratch tree and stops the looping launcher on every test outcome.
struct Owned {
    scratch: PathBuf,
    child: Option<Child>,
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.scratch);
    }
}

#[test]
fn launchers_remove_their_own_and_killed_launchers_executables_folders() {
    let mut owned = Owned {
        scratch: std::env::temp_dir().join(format!(
            "bunwasm-host-executables-cleanup-{}",
            std::process::id()
        )),
        child: None,
    };
    let scratch = owned.scratch.clone();
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).unwrap();
    let looping = scratch.join("loop.wasm");
    let exiting = scratch.join("exit.wasm");
    // No locals; loop { br 0 }, and no locals; return.
    fs::write(&looping, guest(&[0, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b])).unwrap();
    fs::write(&exiting, guest(&[0, 0x0b])).unwrap();
    // This test process is alive, so a folder named after it must survive every sweep.
    let live = format!("{PREFIX}{}-999", std::process::id());
    fs::create_dir(scratch.join(&live)).unwrap();

    let killed = owned
        .child
        .insert(launcher(&scratch, &looping).spawn().unwrap());
    let killed_root = scratch.join(format!("{PREFIX}{}-0", killed.id()));
    // A hang cap, not a speed check.
    let deadline = Instant::now() + Duration::from_secs(120);
    while !killed_root.join("bin/bun").exists() {
        assert!(killed.try_wait().unwrap().is_none(), "looping guest exited");
        assert!(
            Instant::now() < deadline,
            "launcher never created {}",
            killed_root.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    killed.kill().unwrap();
    killed.wait().unwrap();
    owned.child = None;
    assert!(killed_root.exists(), "SIGKILL runs no destructor");

    let status = launcher(&scratch, &exiting).status().unwrap();
    assert!(status.success(), "{status}");
    assert_eq!(folders(&scratch), [live]);
}
