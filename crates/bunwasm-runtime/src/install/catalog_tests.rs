use super::*;
use crate::{Loader, data::NativeError};
use lockfile_tests::parse_json;
use sha2::{Digest, Sha256};

/// Minimal JSON/JSONC/YAML parser for installer unit tests.
struct TestParser;

impl Transpiler for TestParser {
    fn transpile(&self, _: &str, _: &str, _: Loader) -> std::result::Result<String, String> {
        unreachable!("installer data parsing does not transpile JavaScript")
    }

    fn parse_data(&self, source: &[u8], format: &str) -> std::result::Result<String, NativeError> {
        let value = match format {
            "JSON" | "JSONC" => {
                parse_json(source).map_err(|error| NativeError::error(error.to_string()))?
            }
            "YAML" => parse_simple_yaml(std::str::from_utf8(source).unwrap())
                .map_err(NativeError::error)?,
            other => return Err(NativeError::error(format!("Unexpected format {other}"))),
        };
        Ok(json!({"root": [0, value], "nodes": []}).to_string())
    }
}

fn parse_simple_yaml(source: &str) -> std::result::Result<Value, String> {
    let lines: Vec<(usize, &str)> = source
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let indent = line.len() - line.trim_start_matches(' ').len();
            Some((indent, trimmed))
        })
        .collect();
    let (value, _) = parse_yaml_block(&lines, 0, 0)?;
    Ok(value)
}

fn parse_yaml_block(
    lines: &[(usize, &str)],
    start: usize,
    indent: usize,
) -> std::result::Result<(Value, usize), String> {
    if start >= lines.len() {
        return Ok((Value::Null, start));
    }
    if lines[start].1.starts_with("- ") {
        return parse_yaml_list(lines, start, indent);
    }
    parse_yaml_map(lines, start, indent)
}

fn parse_yaml_list(
    lines: &[(usize, &str)],
    mut index: usize,
    indent: usize,
) -> std::result::Result<(Value, usize), String> {
    let mut items = Vec::new();
    while index < lines.len() && lines[index].0 == indent && lines[index].1.starts_with("- ") {
        let item = lines[index].1.strip_prefix("- ").unwrap().trim();
        items.push(parse_yaml_scalar(item));
        index += 1;
    }
    Ok((Value::Array(items), index))
}

fn parse_yaml_map(
    lines: &[(usize, &str)],
    mut index: usize,
    indent: usize,
) -> std::result::Result<(Value, usize), String> {
    let mut map = serde_json::Map::new();
    while index < lines.len() && lines[index].0 == indent {
        let line = lines[index].1;
        let (raw_key, raw_value) = split_yaml_entry(line)?;
        let key = unquote_yaml(raw_key);
        index += 1;
        if !raw_value.is_empty() {
            map.insert(key, parse_yaml_scalar(raw_value));
            continue;
        }
        if index < lines.len() && lines[index].0 > indent {
            let child_indent = lines[index].0;
            let (child, next) = parse_yaml_block(lines, index, child_indent)?;
            map.insert(key, child);
            index = next;
        } else {
            map.insert(key, json!({}));
        }
    }
    Ok((Value::Object(map), index))
}

fn split_yaml_entry(line: &str) -> std::result::Result<(&str, &str), String> {
    let mut quote = None;
    for (index, ch) in line.char_indices() {
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_some() {
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch == ':' && line[index + 1..].is_empty() || line[index..].starts_with(": ") {
            return Ok((line[..index].trim(), line[index + 1..].trim()));
        }
    }
    Err(format!("Invalid YAML line: {line}"))
}

fn unquote_yaml(raw: &str) -> String {
    if (raw.starts_with('\'') && raw.ends_with('\''))
        || (raw.starts_with('"') && raw.ends_with('"'))
    {
        return raw[1..raw.len() - 1].to_owned();
    }
    raw.to_owned()
}

fn parse_yaml_scalar(raw: &str) -> Value {
    if raw == "{}" {
        return json!({});
    }
    if raw == "true" {
        return Value::Bool(true);
    }
    if raw == "false" {
        return Value::Bool(false);
    }
    if raw.starts_with('\'') || raw.starts_with('"') {
        return Value::String(unquote_yaml(raw));
    }
    if let Ok(number) = raw.parse::<i64>() {
        return Value::Number(number.into());
    }
    Value::String(raw.to_owned())
}

struct TestDirectory(std::path::PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn isolated(name: &str, run: fn()) {
    if std::env::var("BUN_WASM_CATALOG_TEST").as_deref() == Ok(name) {
        run();
        return;
    }
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("bun-wasm-catalog-{}-{name}", std::process::id())),
    );
    let _ = fs::remove_dir_all(&directory.0);
    fs::create_dir_all(&directory.0).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::catalog_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(&directory.0)
        .env("BUN_WASM_CATALOG_TEST", name)
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

fn install(command: &str, flags: &[&str]) -> Result<()> {
    execute(
        command,
        flags.iter().map(|flag| (*flag).into()).collect(),
        &TestParser,
        Some(io::Registry::new("http://registry.invalid").unwrap()),
    )
}

fn write_workspace(root_manifest: Value, member_dir: &str, member_manifest: Value) {
    fs::create_dir_all(member_dir).unwrap();
    fs::write("package.json", root_manifest.to_string()).unwrap();
    fs::write(
        Path::new(member_dir).join("package.json"),
        member_manifest.to_string(),
    )
    .unwrap();
}

fn write_pnpm_catalog_workspace() {
    seed_registry_package("evlog", &["2.29.0"]);
    seed_registry_package("is-odd", &["3.0.1"]);
    write_workspace(
        json!({"name": "root"}),
        "packages/a",
        json!({
            "name": "@fixture/a",
            "version": "1.0.0",
            "dependencies": {
                "evlog": "catalog:",
                "is-odd": "catalog:extra"
            }
        }),
    );
    fs::write(
        "pnpm-workspace.yaml",
        "packages:\n  - packages/*\ncatalog:\n  evlog: \"2.29.0\"\ncatalogs:\n  extra:\n    is-odd: \"3.0.1\"\n",
    )
    .unwrap();
}

fn seed_registry_package(name: &str, versions: &[&str]) {
    let mut version_map = serde_json::Map::new();
    for version in versions {
        let tarball = format!(
            "http://registry.invalid/{name}/-/{}-{version}.tgz",
            name.rsplit('/').next().unwrap()
        );
        let meta = json!({"name": name, "version": version});
        let bytes = resolve::test_support::archive(&meta);
        resolve::test_support::cache_archive(&tarball, &bytes);
        let integrity = format!(
            "sha512-{}",
            crate::encoding::base64_encode(&sha2::Sha512::digest(&bytes), false)
        );
        version_map.insert(
            (*version).into(),
            json!({
                "name": name,
                "version": version,
                "dist": { "tarball": tarball, "integrity": integrity }
            }),
        );
    }
    let latest = *versions.last().unwrap();
    let packument = json!({
        "name": name,
        "dist-tags": { "latest": latest, "next": versions[0] },
        "versions": version_map
    });
    let metadata_url = format!("http://registry.invalid/{}", name.replace('/', "%2f"));
    fs::create_dir_all(io::cache_dir()).unwrap();
    fs::write(
        io::cache_dir().join(format!("{:x}", Sha256::digest(metadata_url.as_bytes()))),
        packument.to_string(),
    )
    .unwrap();
}

#[test]
fn default_and_named_catalogs_in_workspaces_object_roundtrip() {
    isolated(
        "default_and_named_catalogs_in_workspaces_object_roundtrip",
        || {
            seed_registry_package("evlog", &["2.29.0"]);
            seed_registry_package("is-odd", &["3.0.1"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "evlog": "2.29.0" },
                        "catalogs": { "extra": { "is-odd": "3.0.1" } }
                    }
                }),
                "packages/app",
                json!({
                    "name": "@fixture/app",
                    "version": "1.0.0",
                    "dependencies": { "evlog": "catalog:", "is-odd": "catalog:extra" }
                }),
            );

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(
                lock["workspaces"]["packages/app"]["dependencies"]["evlog"],
                "catalog:"
            );
            assert_eq!(
                lock["workspaces"]["packages/app"]["dependencies"]["is-odd"],
                "catalog:extra"
            );
            assert_eq!(lock["catalog"]["evlog"], "2.29.0");
            assert_eq!(lock["catalogs"]["extra"]["is-odd"], "3.0.1");
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");
            assert!(Path::new("node_modules/evlog/package.json").is_file());
            assert!(Path::new("node_modules/is-odd/package.json").is_file());

            fs::remove_dir_all("node_modules").unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
            assert!(Path::new("node_modules/evlog/package.json").is_file());
        },
    );
}

#[test]
fn top_level_catalog_and_catalogs_work_for_root_and_members() {
    isolated(
        "top_level_catalog_and_catalogs_work_for_root_and_members",
        || {
            seed_registry_package("evlog", &["2.29.0"]);
            seed_registry_package("is-odd", &["3.0.1"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "catalog": { "evlog": "2.29.0" },
                    "catalogs": { "tools": { "is-odd": "3.0.1" } },
                    "devDependencies": { "evlog": "catalog:default" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "is-odd": "catalog:tools" }
                }),
            );

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["evlog"], "2.29.0");
            assert_eq!(lock["catalogs"]["tools"]["is-odd"], "3.0.1");
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");

            install("install", &["--production", "--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);

            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "catalog": { "evlog": "^2.29.0" },
                    "catalogs": { "tools": { "is-odd": "3.0.1" } },
                    "devDependencies": { "evlog": "catalog:default" }
                })
                .to_string(),
            )
            .unwrap();
            assert_eq!(
                install("install", &["--frozen-lockfile"]).unwrap_err(),
                "lockfile had changes, but lockfile is frozen"
            );
            assert_eq!(
                install("install", &["--production", "--frozen-lockfile"]).unwrap_err(),
                "lockfile had changes, but lockfile is frozen"
            );
        },
    );
}

#[test]
fn workspaces_catalog_takes_precedence_over_top_level_catalog() {
    isolated(
        "workspaces_catalog_takes_precedence_over_top_level_catalog",
        || {
            seed_registry_package("evlog", &["2.28.0", "2.29.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "catalog": { "evlog": "2.28.0", "only-top": "1.0.0" },
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "evlog": "2.29.0" }
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "evlog": "catalog:" }
                }),
            );

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");
            assert!(lock["catalog"].get("only-top").is_none());
        },
    );
}

#[test]
fn catalog_supports_npm_aliases_tarball_urls_and_overrides() {
    isolated(
        "catalog_supports_npm_aliases_tarball_urls_and_overrides",
        || {
            let tarball = "https://packages.invalid/releases/hotkeys-0.1.0.tgz";
            let tarball_bytes = resolve::test_support::archive(
                &json!({"name": "@fixture/hotkeys", "version": "0.1.0"}),
            );
            resolve::test_support::cache_archive(tarball, &tarball_bytes);
            seed_registry_package("typescript", &["6.0.3"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": {
                            "typescript-api": "npm:typescript@6.0.3",
                            "@fixture/hotkeys": tarball
                        }
                    },
                    "overrides": {
                        "@fixture/hotkeys": "catalog:"
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": {
                        "typescript-api": "catalog:",
                        "@fixture/hotkeys": "^0.0.1"
                    }
                }),
            );

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["packages"]["typescript-api"][0], "typescript@6.0.3");
            assert_eq!(
                lock["packages"]["@fixture/hotkeys"][0],
                "@fixture/hotkeys@0.1.0"
            );
            assert_eq!(lock["packages"]["@fixture/hotkeys"][1], tarball);
            assert_eq!(lock["overrides"]["@fixture/hotkeys"], "catalog:");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn pnpm_workspace_yaml_catalogs_work_from_root_and_member() {
    isolated(
        "pnpm_workspace_yaml_catalogs_work_from_root_and_member",
        || {
            write_pnpm_catalog_workspace();
            let root = std::env::current_dir().unwrap();
            std::env::set_current_dir(root.join("packages/a")).unwrap();
            install("install", &[]).unwrap();
            assert_eq!(std::env::current_dir().unwrap(), root);
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["evlog"], "2.29.0");
            assert_eq!(lock["catalogs"]["extra"]["is-odd"], "3.0.1");
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn pnpm_lockfile_migration_preserves_catalogs() {
    isolated("pnpm_lockfile_migration_preserves_catalogs", || {
        write_pnpm_catalog_workspace();
        fs::write(
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n  packages/a:\n    dependencies:\n      evlog:\n        specifier: 'catalog:'\n        version: 2.29.0\n      is-odd:\n        specifier: 'catalog:extra'\n        version: 3.0.1\npackages:\n  evlog@2.29.0:\n    resolution:\n      integrity: ''\n  is-odd@3.0.1:\n    resolution:\n      integrity: ''\n",
        )
        .unwrap();

        install("install", &["--lockfile-only"]).unwrap();
        let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
        assert_eq!(lock["catalog"]["evlog"], "2.29.0");
        assert_eq!(lock["catalogs"]["extra"]["is-odd"], "3.0.1");
        assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");
        assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");
    });
}

#[test]
fn catalog_dist_tag_reuses_lock_and_invalidates_on_tag_change() {
    isolated(
        "catalog_dist_tag_reuses_lock_and_invalidates_on_tag_change",
        || {
            seed_registry_package("evlog", &["2.28.0", "2.29.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "evlog": "latest" }
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "evlog": "catalog:" }
                }),
            );

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");

            // Remove cached metadata so reuse MUST come from bun.lock.
            let metadata_url = "http://registry.invalid/evlog";
            fs::remove_file(
                io::cache_dir().join(format!("{:x}", Sha256::digest(metadata_url.as_bytes()))),
            )
            .unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();

            // Changing the catalog dist-tag must NOT reuse the old "latest" lock entry.
            seed_registry_package("evlog", &["2.28.0", "2.29.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "evlog": "next" }
                    }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            let updated = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(updated["packages"]["evlog"][0], "evlog@2.28.0");
        },
    );
}

#[test]
fn workspace_catalog_dist_tag_keeps_nested_version_when_root_pins_another() {
    isolated(
        "workspace_catalog_dist_tag_keeps_nested_version_when_root_pins_another",
        || {
            seed_registry_package("versioned", &["1.0.0", "2.0.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "1.0.0" },
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "versioned": "latest" }
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "catalog:" }
                }),
            );

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(
                lock["packages"]["@fixture/a/versioned"][0],
                "versioned@2.0.0"
            );

            // Reinstall and frozen install must both preserve the workspace's nested 2.0.0 pin.
            let metadata_url = "http://registry.invalid/versioned";
            fs::remove_file(
                io::cache_dir().join(format!("{:x}", Sha256::digest(metadata_url.as_bytes()))),
            )
            .unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);

            install("install", &[]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
            let nested = parse_json(
                &fs::read("node_modules/@fixture/a/node_modules/versioned/package.json").unwrap(),
            )
            .unwrap();
            assert_eq!(nested["version"], "2.0.0");
        },
    );
}

#[test]
fn missing_and_invalid_catalog_entries_return_clear_errors() {
    let manifest = json!({
        "workspaces": {
            "packages": ["packages/*"],
            "catalog": { "evlog": "2.29.0" },
            "catalogs": { "extra": { "is-odd": "3.0.1" } }
        }
    });
    let catalogs = catalog::Catalogs::from_manifest(&manifest, &Value::Null).unwrap();
    assert_eq!(
        catalogs.resolve("evlog", "catalog:").unwrap(),
        Some("2.29.0")
    );
    assert_eq!(
        catalogs.resolve("evlog", "catalog: ").unwrap(),
        Some("2.29.0")
    );
    assert_eq!(
        catalogs.resolve("is-odd", "catalog:extra").unwrap(),
        Some("3.0.1")
    );
    assert_eq!(
        catalogs.resolve("is-odd", "catalog: extra ").unwrap(),
        Some("3.0.1")
    );
    assert_eq!(catalogs.resolve("evlog", "^2.0.0").unwrap(), None);

    let missing_default = catalogs.resolve("missing-pkg", "catalog:").unwrap_err();
    assert_eq!(missing_default, "missing-pkg@catalog: not in catalog");

    let missing_named = catalogs.resolve("evlog", "catalog:nope").unwrap_err();
    assert!(
        missing_named.contains("evlog@catalog:nope") && missing_named.contains("\"nope\""),
        "{missing_named}"
    );

    let missing_entry = catalogs.resolve("evlog", "catalog:extra").unwrap_err();
    assert_eq!(
        missing_entry,
        "evlog@catalog:extra not in catalog \"extra\""
    );

    let conflict = catalog::Catalogs::from_manifest(
        &json!({
            "catalog": { "evlog": "2.29.0" },
            "catalogs": { "default": { "evlog": "2.28.0" } }
        }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(conflict.contains("defined in both"), "{conflict}");

    let recursive = catalog::Catalogs::from_manifest(
        &json!({ "catalog": { "evlog": "catalog:other" } }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(
        recursive.contains("cannot reference another catalog"),
        "{recursive}"
    );

    let empty_entry =
        catalog::Catalogs::from_manifest(&json!({ "catalog": { "evlog": "" } }), &Value::Null)
            .unwrap_err();
    assert!(empty_entry.contains("non-empty string"), "{empty_entry}");

    let bad_shape =
        catalog::Catalogs::from_manifest(&json!({ "catalogs": ["not-an-object"] }), &Value::Null)
            .unwrap_err();
    assert!(bad_shape.contains("must be an object"), "{bad_shape}");
}

#[test]
fn fetch_errors_include_package_specifier_and_redacted_url() {
    let registry = io::Registry::configured(&json!({
        "url": "https://registry.invalid",
        "token": "top-secret-token"
    }))
    .unwrap();
    let tarball = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz";
    let formatted = io::format_fetch_error(tarball, "Failed to fetch", &registry);
    assert_eq!(formatted, format!("GET {tarball} - Failed to fetch"));

    let wrapped = io::package_fetch_error("waffle-base", formatted);
    assert_eq!(
        wrapped,
        format!("failed to fetch \"waffle-base\": GET {tarball} - Failed to fetch")
    );

    // Errors that already carry the URL must not duplicate it.
    let status_error = format!("GET {tarball} - 404");
    assert_eq!(
        io::format_fetch_error(tarball, &status_error, &registry),
        status_error
    );

    // Credentials and query strings are always redacted.
    let leaky = io::format_fetch_error(
        "https://user:pass@registry.invalid/pkg.tgz?token=abc",
        "top-secret-token failed",
        &registry,
    );
    assert!(
        !leaky.contains("pass")
            && !leaky.contains("token=abc")
            && !leaky.contains("top-secret-token")
    );
    assert!(
        leaky.contains("https://registry.invalid/pkg.tgz"),
        "{leaky}"
    );

    // Host without networking preserves the exact host-capability diagnostic.
    assert_eq!(
        io::package_fetch_error("waffle-base", io::NO_NETWORK.into()),
        io::NO_NETWORK
    );
}

#[test]
fn overrides_apply_before_catalog_expansion() {
    isolated("overrides_apply_before_catalog_expansion", || {
        seed_registry_package("alpha", &["1.0.0", "2.0.0"]);
        seed_registry_package("beta", &["1.0.0", "2.0.0"]);
        seed_registry_package("other", &["1.0.0"]);
        write_workspace(
            json!({
                "name": "root",
                "workspaces": {
                    "packages": ["packages/*"],
                    "catalog": {
                        "beta": "npm:other@1.0.0"
                    }
                },
                "overrides": {
                    "alpha": "2.0.0",
                    "beta": "2.0.0"
                }
            }),
            "packages/a",
            json!({
                "name": "@fixture/a",
                "version": "1.0.0",
                "dependencies": {
                    "alpha": "catalog:missing",
                    "beta": "catalog:"
                }
            }),
        );

        install("install", &[]).unwrap();
        let lock_text = fs::read_to_string("bun.lock").unwrap();
        let lock = parse_json(lock_text.as_bytes()).unwrap();
        assert_eq!(lock["packages"]["alpha"][0], "alpha@2.0.0");
        assert_eq!(lock["packages"]["beta"][0], "beta@2.0.0");
        assert!(lock["packages"].get("other").is_none());

        install("install", &["--frozen-lockfile"]).unwrap();
        assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
    });
}

#[test]
fn workspaces_catalog_without_packages_installs_root_dependencies() {
    isolated(
        "workspaces_catalog_without_packages_installs_root_dependencies",
        || {
            seed_registry_package("evlog", &["2.29.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": {
                        "catalog": { "evlog": "2.29.0" }
                    },
                    "dependencies": {
                        "evlog": "catalog:"
                    }
                })
                .to_string(),
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["evlog"], "2.29.0");
            assert_eq!(lock["packages"]["evlog"][0], "evlog@2.29.0");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);

            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": "not-an-array",
                        "catalog": { "evlog": "2.29.0" }
                    }
                })
                .to_string(),
            )
            .unwrap();
            assert!(
                install("install", &[])
                    .unwrap_err()
                    .contains("workspaces must be an array or an object with packages")
            );
        },
    );
}

#[test]
fn workspace_wildcard_dependency_shares_updated_root_version_without_nesting() {
    isolated(
        "workspace_wildcard_dependency_shares_updated_root_version_without_nesting",
        || {
            seed_registry_package("versioned", &["1.0.0", "2.0.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": { "versioned": "1.0.0" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "*" }
                }),
            );
            fs::create_dir_all("packages/b").unwrap();
            fs::write(
                "packages/b/package.json",
                json!({
                    "name": "@fixture/b",
                    "version": "1.0.0",
                    "peerDependencies": { "versioned": "*" }
                })
                .to_string(),
            )
            .unwrap();

            install("install", &[]).unwrap();
            let first = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(first["packages"]["versioned"][0], "versioned@1.0.0");

            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": { "versioned": "2.0.0" }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            let updated = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(updated["packages"]["versioned"][0], "versioned@2.0.0");
            assert!(updated["packages"].get("@fixture/a/versioned").is_none());
            assert!(!Path::new("node_modules/@fixture/a/node_modules/versioned").exists());
        },
    );
}

#[test]
fn yarn_berry_migration_reads_catalogs_from_yarnrc_and_keeps_them_on_reinstall() {
    isolated(
        "yarn_berry_migration_reads_catalogs_from_yarnrc_and_keeps_them_on_reinstall",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            seed_registry_package("is-odd", &["3.0.1"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": { "versioned": "catalog:" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "is-odd": "catalog:tools" }
                }),
            );
            fs::write(
                ".yarnrc.yml",
                "catalog:\n  versioned: \"^1.0.0\"\ncatalogs:\n  tools:\n    is-odd: \"3.0.1\"\n",
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"catalog:\"\n\n\"@fixture/a@workspace:packages/a\":\n  version: 0.0.0-use.local\n  resolution: \"@fixture/a@workspace:packages/a\"\n  dependencies:\n    is-odd: \"catalog:tools\"\n\n\"versioned@npm:^1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n\n\"is-odd@npm:3.0.1\":\n  version: 3.0.1\n  resolution: \"is-odd@npm:3.0.1\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["versioned"], "^1.0.0");
            assert_eq!(lock["catalogs"]["tools"]["is-odd"], "3.0.1");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn yarn_npm_catalog_ranges_normalize_while_preserving_aliases() {
    isolated(
        "yarn_npm_catalog_ranges_normalize_while_preserving_aliases",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            seed_registry_package("other", &["1.0.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": {
                        "versioned": " catalog:",
                        "aliased": "catalog:tools"
                    }
                }),
                "packages/a",
                json!({ "name": "@fixture/a", "version": "1.0.0" }),
            );
            fs::write(
                ".yarnrc.yml",
                "catalog:\n  versioned: \"npm:^1.0.0\"\ncatalogs:\n  tools:\n    aliased: \"npm:other@^1.0.0\"\n",
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"catalog:\"\n    aliased: \"catalog:tools\"\n\n\"@fixture/a@workspace:packages/a\":\n  version: 0.0.0-use.local\n  resolution: \"@fixture/a@workspace:packages/a\"\n\n\"versioned@npm:^1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n\n\"aliased@npm:other@^1.0.0\":\n  version: 1.0.0\n  resolution: \"other@npm:1.0.0\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["versioned"], "^1.0.0");
            assert_eq!(lock["catalogs"]["tools"]["aliased"], "npm:other@^1.0.0");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(lock["packages"]["aliased"][0], "other@1.0.0");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn pnpm_migration_loads_catalogs_from_pnpm_lock_without_workspace_yaml() {
    isolated(
        "pnpm_migration_loads_catalogs_from_pnpm_lock_without_workspace_yaml",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            seed_registry_package("is-odd", &["3.0.1"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": {
                        "versioned": "catalog:",
                        "is-odd": "catalog:tools"
                    }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    versioned:\n      specifier: ^1.0.0\n      version: 1.0.0\n  tools:\n    is-odd:\n      specifier: 3.0.1\n      version: 3.0.1\nimporters:\n  .:\n    dependencies:\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\n      is-odd:\n        specifier: 'catalog:tools'\n        version: 3.0.1\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n  is-odd@3.0.1:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();

            install("install", &["--lockfile-only"]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["versioned"], "^1.0.0");
            assert_eq!(lock["catalogs"]["tools"]["is-odd"], "3.0.1");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");

            install("install", &[]).unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn pnpm_migration_supports_catalogs_default_and_updated_workspace_catalog_range() {
    isolated(
        "pnpm_migration_supports_catalogs_default_and_updated_workspace_catalog_range",
        || {
            seed_registry_package("versioned", &["1.0.0", "1.1.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "catalogs": { "default": { "versioned": "^1.1.0" } },
                    "dependencies": { "versioned": "catalog:" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    versioned:\n      specifier: ^1.0.0\n      version: 1.0.0\nimporters:\n  .:\n    dependencies:\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalogs"]["default"]["versioned"], "^1.1.0");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.1.0");

            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
        },
    );
}

#[test]
fn yarn_migration_skips_missing_optional_catalog_dependency() {
    isolated(
        "yarn_migration_skips_missing_optional_catalog_dependency",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "^1.0.0" },
                    "optionalDependencies": { "missing-opt": "catalog:" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"^1.0.0\"\n\n\"versioned@npm:^1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert!(lock["packages"].get("missing-opt").is_none());
        },
    );
}

#[test]
fn deleting_catalog_from_pnpm_workspace_yaml_is_not_masked_by_stale_pnpm_lock() {
    isolated(
        "deleting_catalog_from_pnpm_workspace_yaml_is_not_masked_by_stale_pnpm_lock",
        || {
            write_pnpm_catalog_workspace();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    evlog:\n      specifier: 2.29.0\n      version: 2.29.0\n  extra:\n    is-odd:\n      specifier: 3.0.1\n      version: 3.0.1\nimporters:\n  .:\n    dependencies: {}\n  packages/a:\n    dependencies:\n      evlog:\n        specifier: 'catalog:'\n        version: 2.29.0\n      is-odd:\n        specifier: 'catalog:extra'\n        version: 3.0.1\npackages:\n  evlog@2.29.0:\n    resolution:\n      integrity: ''\n  is-odd@3.0.1:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();
            install("install", &["--lockfile-only"]).unwrap();

            // Delete catalog definitions from pnpm-workspace.yaml while leaving stale pnpm-lock.yaml.
            fs::write("pnpm-workspace.yaml", "packages:\n  - packages/*\n").unwrap();
            assert!(
                install("install", &["--frozen-lockfile"])
                    .unwrap_err()
                    .contains("not in catalog")
            );
            assert!(
                install("install", &[])
                    .unwrap_err()
                    .contains("not in catalog")
            );
        },
    );
}

#[test]
fn yarn_migration_keeps_missing_optional_catalog_shadowing_regular_dependency() {
    isolated(
        "yarn_migration_keeps_missing_optional_catalog_shadowing_regular_dependency",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": {
                        "versioned": "^1.0.0",
                        "shadowed": "^1.0.0"
                    },
                    "optionalDependencies": {
                        "shadowed": "catalog:"
                    }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"^1.0.0\"\n\n\"versioned@npm:^1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert!(lock["packages"].get("shadowed").is_none());
        },
    );
}

#[test]
fn pnpm_frozen_install_keeps_unused_workspace_catalog_entries_and_rejects_out_of_range_selection() {
    isolated(
        "pnpm_frozen_install_keeps_unused_workspace_catalog_entries_and_rejects_out_of_range_selection",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            write_workspace(
                json!({ "name": "root", "workspaces": ["packages/*"] }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "catalog:" }
                }),
            );
            fs::write(
                "pnpm-workspace.yaml",
                "packages:\n  - packages/*\ncatalog:\n  versioned: ^1.0.0\n  unused: ^2.0.0\n",
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    versioned:\n      specifier: ^1.0.0\n      version: 1.0.0\nimporters:\n  .:\n    dependencies: {}\n  packages/a:\n    dependencies:\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();

            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
            let _ = fs::remove_file("bun.lock");

            // Omitted pnpm-lock catalog entry must validate against the expanded workspace range.
            fs::write(
                "pnpm-workspace.yaml",
                "packages:\n  - packages/*\ncatalog:\n  versioned: ^2.0.0\n",
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n  packages/a:\n    dependencies:\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();
            assert!(
                install("install", &["--lockfile-only"])
                    .unwrap_err()
                    .contains("does not satisfy")
            );
        },
    );
}

#[test]
fn yarn_migration_ignores_catalog_ref_shadowed_by_optional_and_malformed_yarnrc_does_not_block_bun()
{
    isolated(
        "yarn_migration_ignores_catalog_ref_shadowed_by_optional_and_malformed_yarnrc_does_not_block_bun",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "catalog:unused" },
                    "optionalDependencies": { "versioned": "1.0.0" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  optionalDependencies:\n    versioned: \"1.0.0\"\n\n\"versioned@npm:1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");

            // Unrelated malformed .yarnrc.yml must not break a frozen Bun install.
            fs::remove_file("yarn.lock").unwrap();
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "1.0.0" }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            fs::write(".yarnrc.yml", "not: [valid: yaml\n").unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();
        },
    );
}

#[test]
fn pnpm_frozen_migration_preserves_disjoint_catalog_and_catalogs_default_groups() {
    isolated(
        "pnpm_frozen_migration_preserves_disjoint_catalog_and_catalogs_default_groups",
        || {
            seed_registry_package("is-number", &["7.0.0"]);
            seed_registry_package("versioned", &["1.0.0"]);
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "catalog": { "is-number": "7.0.0" },
                    "catalogs": { "default": { "versioned": "^1.0.0" } },
                    "dependencies": {
                        "is-number": "catalog:",
                        "versioned": "catalog:"
                    }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    is-number:\n      specifier: 7.0.0\n      version: 7.0.0\n    versioned:\n      specifier: ^1.0.0\n      version: 1.0.0\nimporters:\n  .:\n    dependencies:\n      is-number:\n        specifier: 'catalog:'\n        version: 7.0.0\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  is-number@7.0.0:\n    resolution:\n      integrity: ''\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();

            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
        },
    );
}

#[test]
fn pnpm_and_yarn_migrations_drop_skipped_optional_catalogs_and_ignore_malformed_pnpm_yaml() {
    isolated(
        "pnpm_and_yarn_migrations_drop_skipped_optional_catalogs_and_ignore_malformed_pnpm_yaml",
        || {
            seed_registry_package("versioned", &["1.0.0"]);
            // 1. pnpm migration with an optional dependency whose named catalog was removed.
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "^1.0.0" },
                    "optionalDependencies": { "gone": "catalog:removed" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      versioned:\n        specifier: ^1.0.0\n        version: 1.0.0\n    optionalDependencies:\n      gone:\n        specifier: 'catalog:removed'\n        version: 1.0.0\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n  gone@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();
            install("install", &["--lockfile-only"]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert!(lock["packages"].get("gone").is_none());

            // 2. Yarn migration with an optional peer referencing a missing catalog.
            fs::remove_file("bun.lock").unwrap();
            fs::remove_file("pnpm-lock.yaml").unwrap();
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "^1.0.0" },
                    "peerDependencies": { "opt-peer": "catalog:missing" },
                    "peerDependenciesMeta": { "opt-peer": { "optional": true } }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"^1.0.0\"\n\n\"versioned@npm:^1.0.0\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n",
            )
            .unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert!(lock["packages"].get("opt-peer").is_none());

            // 3. Unrelated malformed pnpm-workspace.yaml does not break an explicit workspaces: [] install.
            fs::remove_file("bun.lock").unwrap();
            fs::remove_file("yarn.lock").unwrap();
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "workspaces": [],
                    "dependencies": { "versioned": "^1.0.0" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write("pnpm-workspace.yaml", "packages: [invalid: yaml\n").unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");

            // 4. Standalone child project ignores a malformed pnpm-workspace.yaml in an ancestor.
            fs::write("package.json", json!({ "name": "parent" }).to_string()).unwrap();
            fs::create_dir_all("child").unwrap();
            fs::write("child/package.json", json!({ "name": "child" }).to_string()).unwrap();
            let parent = std::env::current_dir().unwrap();
            std::env::set_current_dir(parent.join("child")).unwrap();
            install("install", &[]).unwrap();
            assert_eq!(std::env::current_dir().unwrap(), parent.join("child"));
        },
    );
}

#[test]
fn missing_optional_catalog_and_empty_yarn_rc_do_not_break_install() {
    assert_eq!(catalog::yarn_rc_filename_from(None), ".yarnrc.yml");
    assert_eq!(catalog::yarn_rc_filename_from(Some("")), ".yarnrc.yml");
    assert_eq!(
        catalog::yarn_rc_filename_from(Some(".custom.yml")),
        ".custom.yml"
    );

    isolated(
        "missing_optional_catalog_and_empty_yarn_rc_do_not_break_install",
        || {
            fs::create_dir(".yarnrc.yml").unwrap();
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "optionalDependencies": { "missing-root": "catalog:" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "optionalDependencies": { "missing-ws": "catalog:absent" }
                }),
            );

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert!(lock["packages"].get("missing-root").is_none());
            assert!(lock["packages"].get("missing-ws").is_none());
        },
    );
}

#[test]
fn pnpm_migration_preserves_workspace_member_nested_catalog_version() {
    isolated(
        "pnpm_migration_preserves_workspace_member_nested_catalog_version",
        || {
            seed_registry_package("versioned", &["1.0.0", "1.1.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": { "versioned": "1.1.0" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "catalog:" }
                }),
            );
            fs::write(
                "pnpm-workspace.yaml",
                "packages:\n  - packages/*\ncatalog:\n  versioned: ^1.0.0\n",
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    versioned:\n      specifier: ^1.0.0\n      version: 1.0.0\nimporters:\n  .:\n    dependencies:\n      versioned:\n        specifier: 1.1.0\n        version: 1.1.0\n  packages/a:\n    dependencies:\n      versioned:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  versioned@1.0.0:\n    resolution:\n      integrity: ''\n  versioned@1.1.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();

            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
            assert!(!Path::new("bun.lock").exists());

            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.1.0");
            assert_eq!(
                lock["packages"]["@fixture/a/versioned"][0],
                "versioned@1.0.0"
            );
            assert_eq!(
                parse_json(&fs::read("node_modules/versioned/package.json").unwrap()).unwrap()["version"],
                "1.1.0"
            );
            assert_eq!(
                parse_json(
                    &fs::read("node_modules/@fixture/a/node_modules/versioned/package.json")
                        .unwrap()
                )
                .unwrap()["version"],
                "1.0.0"
            );
        },
    );
}
