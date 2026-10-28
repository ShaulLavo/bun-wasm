use super::*;
use crate::{Loader, data::NativeError};
use sha2::{Digest, Sha256};

struct JsonParser;

impl Transpiler for JsonParser {
    fn transpile(&self, _: &str, _: &str, _: Loader) -> std::result::Result<String, String> {
        unreachable!("installer data parsing does not transpile JavaScript")
    }

    fn parse_data(&self, source: &[u8], format: &str) -> std::result::Result<String, NativeError> {
        assert!(matches!(format, "JSON" | "JSONC"));
        let value = parse_json(source).map_err(|error| NativeError::error(error.to_string()))?;
        Ok(json!({"root": [0, value], "nodes": []}).to_string())
    }
}

// These fixtures need JSON and the trailing commas emitted by write_lock, not JS execution.
fn parse_json(source: &[u8]) -> serde_json::Result<Value> {
    let mut bytes = source.to_vec();
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in source.iter().copied().enumerate() {
        if quoted {
            quoted = byte != b'"' || escaped;
            escaped = byte == b'\\' && !escaped;
            continue;
        }
        if byte == b'"' {
            quoted = true;
            continue;
        }
        if byte == b','
            && source[index + 1..]
                .iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| matches!(byte, b'}' | b']'))
        {
            bytes[index] = b' ';
        }
    }
    serde_json::from_slice(&bytes)
}

struct TestDirectory(std::path::PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn isolated(name: &str, run: fn()) {
    if std::env::var("BUN_WASM_LOCKFILE_TEST").as_deref() == Ok(name) {
        run();
        return;
    }
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("bun-wasm-lockfile-{}-{name}", std::process::id())),
    );
    fs::create_dir(&directory.0).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::lockfile_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(&directory.0)
        .env("BUN_WASM_LOCKFILE_TEST", name)
        .env("BUN_INSTALL_CACHE_DIR", directory.0.join("cache"))
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

const MANIFEST: &str = r#"{"dependencies":{"tool":"1.0.0"}}"#;
const LOCK: &str = r#"{
 "packages": {"tool": ["tool@1.0.0", "http://registry.invalid/tool.tgz", {"peerDependencies":{"peer":"*"},"optionalPeers":["peer"],"bin":{"tool":"cli.js"}}, ""]},
 "workspaces": {"": {"dependencies": {"tool":"1.0.0"}}},
 "configVersion": 1, "lockfileVersion": 2
}
"#;

fn fixture() {
    fs::write("package.json", MANIFEST).unwrap();
    fs::write("bun.lock", LOCK).unwrap();
    let meta = json!({"name":"tool", "version":"1.0.0"});
    let compressor = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(compressor);
    let bytes = serde_json::to_vec(&meta).unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "package/package.json", bytes.as_slice())
        .unwrap();
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    fs::create_dir_all(io::cache_dir()).unwrap();
    let key = format!("{:x}", Sha256::digest(b"http://registry.invalid/tool.tgz"));
    fs::write(io::cache_dir().join(key), bytes).unwrap();
}

fn install(command: &str, flags: &[&str]) -> Result<()> {
    execute(
        command,
        flags.iter().map(|flag| (*flag).into()).collect(),
        &JsonParser,
        Some(io::Registry::new("http://registry.invalid").unwrap()),
    )
}

fn assert_preserved() {
    let after = fs::read("bun.lock").unwrap();
    println!(
        "lock before={:x}, after={:x}, rawEqual={}",
        Sha256::digest(LOCK.as_bytes()),
        Sha256::digest(&after),
        after == LOCK.as_bytes()
    );
    assert_eq!(
        parse_json(LOCK.as_bytes()).unwrap(),
        parse_json(&after).unwrap()
    );
    assert!(
        after == LOCK.as_bytes(),
        "frozen install rewrote semantically unchanged lock bytes"
    );
}

#[test]
fn frozen_preserves_existing_lock_bytes() {
    isolated("frozen_preserves_existing_lock_bytes", || {
        fixture();
        install("install", &["--frozen-lockfile"]).unwrap();
        assert!(Path::new("node_modules/tool/package.json").exists());
        assert_preserved();
    });
}

#[test]
fn ci_preserves_existing_lock_bytes() {
    isolated("ci_preserves_existing_lock_bytes", || {
        fixture();
        install("ci", &[]).unwrap();
        assert_preserved();
    });
}

#[test]
fn frozen_lockfile_only_preserves_existing_bytes() {
    isolated("frozen_lockfile_only_preserves_existing_bytes", || {
        fixture();
        install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
        assert!(!Path::new("node_modules").exists());
        assert_preserved();
    });
}

fn reject_changed_lock() {
    fixture();
    for manifest in [
        r#"{"name":"changed","dependencies":{"tool":"1.0.0"}}"#,
        "{}",
    ] {
        fs::write("package.json", manifest).unwrap();
        let error = install("install", &["--frozen-lockfile"]).unwrap_err();
        assert_eq!(error, "lockfile had changes, but lockfile is frozen");
        assert_preserved();
        assert_eq!(fs::read_to_string("package.json").unwrap(), manifest);
        assert!(!Path::new("node_modules").exists());
    }
}

#[test]
fn frozen_rejects_manifest_and_graph_changes_without_writes() {
    isolated(
        "frozen_rejects_manifest_and_graph_changes_without_writes",
        reject_changed_lock,
    );
}

fn unlocked_updates() {
    fixture();
    install("install", &["--lockfile-only"]).unwrap();
    let canonical = fs::read("bun.lock").unwrap();
    assert_ne!(canonical, LOCK.as_bytes());
    assert_eq!(
        parse_json(&canonical).unwrap(),
        parse_json(LOCK.as_bytes()).unwrap()
    );
    fs::write("package.json", "{}").unwrap();
    install("install", &["--lockfile-only"]).unwrap();
    let updated = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
    assert_eq!(updated["packages"], json!({}));
    fs::remove_file("bun.lock").unwrap();
    fs::write("package.json", MANIFEST).unwrap();
    let npm = json!({"lockfileVersion":3,"packages":{
        "":{"dependencies":{"tool":"1.0.0"}},
        "node_modules/tool":{"version":"1.0.0","resolved":"http://registry.invalid/tool.tgz"}
    }})
    .to_string();
    fs::write("package-lock.json", &npm).unwrap();
    install("install", &["--lockfile-only"]).unwrap();
    let migrated = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
    assert_eq!(migrated["packages"]["tool"][0], "tool@1.0.0");
    assert_eq!(fs::read_to_string("package-lock.json").unwrap(), npm);
}

#[test]
fn unlocked_updates_and_migration_still_write_locks() {
    isolated(
        "unlocked_updates_and_migration_still_write_locks",
        unlocked_updates,
    );
}

#[test]
fn production_preserves_existing_lock_bytes() {
    isolated("production_preserves_existing_lock_bytes", || {
        fixture();
        install("install", &["--production"]).unwrap();
        assert_preserved();
        install("install", &["--production", "--frozen-lockfile"]).unwrap();
        assert_preserved();
    });
}

#[test]
fn override_metadata_survives_empty_locks_and_production_comparison() {
    let registry = io::Registry::new("http://registry.invalid").unwrap();
    let locked = json!({
        "lockfileVersion": 2, "configVersion": 1,
        "workspaces": {"": {}}, "packages": {},
        "overrides": {"tool@^1": {".": "0.5.0"}}
    });
    let text = write_lock(&locked, &registry).unwrap();
    assert_eq!(parse_json(text.as_bytes()).unwrap(), locked);
    assert!(same_lock(&locked, &text, &JsonParser, true).unwrap());
    let mut changed = locked.clone();
    changed["overrides"]["tool@^1"]["."] = "0.6.0".into();
    let text = write_lock(&changed, &registry).unwrap();
    assert!(!same_lock(&locked, &text, &JsonParser, false).unwrap());
    assert!(!same_lock(&locked, &text, &JsonParser, true).unwrap());
}
