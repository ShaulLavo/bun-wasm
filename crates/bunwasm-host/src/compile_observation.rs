//! Host-only compile observation intake.
//!
//! The primary compiler calls are owned by `linked::Programs::load`, not the
//! launcher entrypoint. Until those exact calls can be instrumented, publish
//! `null`. Timing the loader would include disk reads, admission and linking.

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

const PATH_ENV: &str = "BUN_WASM_COMPILE_PHASE_PATH";
const REQUEST_ENV: &str = "BUN_WASM_COMPILE_PHASE_REQUEST";

pub fn host_only(name: &str) -> bool {
    matches!(name, PATH_ENV | REQUEST_ENV)
}

pub struct Request {
    path: PathBuf,
}

pub fn from_env() -> Result<Option<Request>> {
    let Some(path) = env::var_os(PATH_ENV) else {
        return Ok(None);
    };
    ensure!(!path.is_empty(), "{PATH_ENV} must not be empty");
    let request = env::var(REQUEST_ENV).context("reading compile observation request")?;
    validate_request(
        &serde_json::from_str(&request).context("parsing compile observation request")?,
    )?;
    Ok(Some(Request { path: path.into() }))
}

fn validate_request(value: &Value) -> Result<()> {
    ensure!(
        value["schemaVersion"] == 1,
        "compile observation schemaVersion must be 1"
    );
    ensure!(
        value["source"] == "launcher",
        "compile observation source must be launcher"
    );
    ensure!(
        value["phase"] == "module-compilation",
        "compile observation phase must be module-compilation"
    );
    ensure!(
        value["clock"] == "monotonic",
        "compile observation clock must be monotonic"
    );
    ensure!(
        value["runId"].as_str().is_some_and(|id| !id.is_empty()),
        "compile observation runId is required"
    );
    ensure!(
        matches!(
            value["program"]["kind"].as_str(),
            Some("single" | "quickjs" | "jsc" | "spidermonkey")
        ),
        "compile observation program kind is invalid"
    );
    Ok(())
}

/// Missing direct spans must remain unavailable, including cache-only loads.
pub fn unavailable(request: Option<Request>) -> Result<()> {
    let Some(request) = request else {
        return Ok(());
    };
    fs::write(&request.path, b"null\n").with_context(|| {
        format!(
            "publishing unavailable compile observation {}",
            request.path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn observer_environment_is_host_only() {
        assert!(host_only(PATH_ENV));
        assert!(host_only(REQUEST_ENV));
        assert!(!host_only("BUN_WASM_SPIDERMONKEY_TIER"));
    }

    #[test]
    fn request_requires_direct_launcher_contract() {
        let mut request = json!({ "schemaVersion": 1, "source": "launcher", "phase": "module-compilation", "clock": "monotonic", "runId": "tiny/1", "program": { "kind": "spidermonkey" } });
        validate_request(&request).unwrap();
        request["phase"] = json!("download");
        assert!(validate_request(&request).is_err());
    }
}
