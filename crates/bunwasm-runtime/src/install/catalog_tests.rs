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
        match format {
            "JSON" | "JSONC" => {
                let value =
                    parse_json(source).map_err(|error| NativeError::error(error.to_string()))?;
                Ok(json!({"root": [0, value], "nodes": []}).to_string())
            }
            "YAML" => {
                let mut nodes = Vec::new();
                let root = parse_simple_yaml(std::str::from_utf8(source).unwrap(), &mut nodes)
                    .map_err(NativeError::error)?;
                Ok(json!({"root": root, "nodes": nodes}).to_string())
            }
            other => Err(NativeError::error(format!("Unexpected format {other}"))),
        }
    }
}

fn parse_simple_yaml(source: &str, nodes: &mut Vec<Value>) -> std::result::Result<Value, String> {
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
    let (value, _) = parse_yaml_block(&lines, 0, 0, nodes)?;
    Ok(value)
}

fn parse_yaml_block(
    lines: &[(usize, &str)],
    start: usize,
    indent: usize,
    nodes: &mut Vec<Value>,
) -> std::result::Result<(Value, usize), String> {
    if start >= lines.len() {
        return Ok((json!([0, Value::Null]), start));
    }
    if lines[start].1.starts_with("- ") {
        return parse_yaml_list(lines, start, indent, nodes);
    }
    parse_yaml_map(lines, start, indent, nodes)
}

fn parse_yaml_list(
    lines: &[(usize, &str)],
    mut index: usize,
    indent: usize,
    nodes: &mut Vec<Value>,
) -> std::result::Result<(Value, usize), String> {
    let mut items = Vec::new();
    while index < lines.len() && lines[index].0 == indent && lines[index].1.starts_with("- ") {
        let item = lines[index].1.strip_prefix("- ").unwrap().trim();
        items.push(parse_yaml_scalar(item, nodes));
        index += 1;
    }
    let id = nodes.len();
    nodes.push(json!(["array", items]));
    Ok((json!([1, id]), index))
}

fn parse_yaml_map(
    lines: &[(usize, &str)],
    mut index: usize,
    indent: usize,
    nodes: &mut Vec<Value>,
) -> std::result::Result<(Value, usize), String> {
    let mut entries = Vec::new();
    while index < lines.len() && lines[index].0 == indent {
        let line = lines[index].1;
        let (raw_key, raw_value) = split_yaml_entry(line)?;
        let key = unquote_yaml(raw_key);
        index += 1;
        if !raw_value.is_empty() {
            entries.push(json!([[0, key], parse_yaml_scalar(raw_value, nodes)]));
            continue;
        }
        if index < lines.len() && lines[index].0 > indent {
            let child_indent = lines[index].0;
            let (child, next) = parse_yaml_block(lines, index, child_indent, nodes)?;
            entries.push(json!([[0, key], child]));
            index = next;
        } else {
            let empty_id = nodes.len();
            nodes.push(json!(["object", []]));
            entries.push(json!([[0, key], [1, empty_id]]));
        }
    }
    let id = nodes.len();
    nodes.push(json!(["object", entries]));
    Ok((json!([1, id]), index))
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
        if ch == ':' && (line[index + 1..].is_empty() || line[index..].starts_with(": ")) {
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

fn parse_yaml_scalar(raw: &str, nodes: &mut Vec<Value>) -> Value {
    if raw == "{}" {
        let id = nodes.len();
        nodes.push(json!(["object", []]));
        return json!([1, id]);
    }
    if raw == "true" {
        return json!([0, true]);
    }
    if raw == "false" {
        return json!([0, false]);
    }
    if raw.starts_with('\'') || raw.starts_with('"') {
        return json!([0, unquote_yaml(raw)]);
    }
    if let Ok(number) = raw.parse::<i64>() {
        return json!([4, number.to_string(), raw]);
    }
    if let Ok(float) = raw.parse::<f64>()
        && serde_json::Number::from_f64(float).is_some()
    {
        return json!([4, float.to_string(), raw]);
    }
    json!([0, raw])
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
            "workspaces": ["packages/*"],
            "catalog": { "evlog": "2.29.0" },
            "catalogs": { "default": { "evlog": "2.28.0" } }
        }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(conflict.contains("defined in both"), "{conflict}");

    let recursive = catalog::Catalogs::from_manifest(
        &json!({ "workspaces": ["packages/*"], "catalog": { "evlog": "catalog:other" } }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(
        recursive.contains("cannot reference another catalog"),
        "{recursive}"
    );

    let empty_entry = catalog::Catalogs::from_manifest(
        &json!({ "workspaces": ["packages/*"], "catalog": { "evlog": "" } }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(empty_entry.contains("non-empty string"), "{empty_entry}");

    let bad_shape = catalog::Catalogs::from_manifest(
        &json!({ "workspaces": ["packages/*"], "catalogs": ["not-an-object"] }),
        &Value::Null,
    )
    .unwrap_err();
    assert!(bad_shape.contains("must be an object"), "{bad_shape}");

    // Standalone manifests without `workspaces` ignore arbitrary top-level `catalog` fields.
    let standalone = catalog::Catalogs::from_manifest(
        &json!({ "name": "standalone", "catalog": "documentation" }),
        &Value::Null,
    )
    .unwrap();
    assert!(standalone.is_empty());

    // When `workspaces` defines any catalog field, top-level fallback is not mixed in.
    let workspace_unit = catalog::Catalogs::from_manifest(
        &json!({
            "workspaces": {
                "packages": ["packages/*"],
                "catalog": { "evlog": "2.29.0" }
            },
            "catalogs": { "default": { "evlog": "2.28.0" } }
        }),
        &Value::Null,
    )
    .unwrap();
    assert_eq!(
        workspace_unit.resolve("evlog", "catalog:").unwrap(),
        Some("2.29.0")
    );
}

#[test]
fn standalone_catalog_field_and_workspace_unit_selection_install_like_native_bun() {
    isolated(
        "standalone_catalog_field_and_workspace_unit_selection_install_like_native_bun",
        || {
            seed_registry_package("versioned", &["1.0.0", "1.1.0"]);
            // Standalone project with an unrelated string `"catalog"` field must install cleanly.
            fs::write(
                "package.json",
                json!({
                    "name": "standalone-doc",
                    "catalog": "documentation",
                    "dependencies": { "versioned": "1.0.0" }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");

            // Workspace with `workspaces.catalog` ignores conflicting top-level `catalogs.default`.
            fs::remove_file("bun.lock").unwrap();
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "versioned": "1.0.0" }
                    },
                    "catalogs": { "default": { "versioned": "1.1.0" } }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "catalog:" }
                }),
            );
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert!(lock.get("catalogs").is_none());

            // Bun catalog supports `npm:<semver-range>` (preserving literals for frozen lockfiles)
            // while preserving valid `npm:` aliases including digit/v-prefixed package names.
            seed_registry_package("is-number", &["7.0.0"]);
            seed_registry_package("7zip-bin", &["5.2.0"]);
            seed_registry_package("v8-to-istanbul", &["9.3.0"]);
            fs::remove_file("bun.lock").unwrap();
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": {
                            "versioned": "npm:^1.0.0",
                            "exact-num": "npm:1.0.0",
                            "num-alias": "npm:is-number@7.0.0",
                            "seven-alias": "npm:7zip-bin",
                            "v8-alias": "npm:v8-to-istanbul"
                        }
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": {
                        "versioned": "catalog:",
                        "num-alias": "catalog:",
                        "seven-alias": "catalog:",
                        "v8-alias": "catalog:"
                    }
                }),
            );
            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["versioned"], "npm:^1.0.0");
            assert_eq!(lock["catalog"]["exact-num"], "npm:1.0.0");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.1.0");
            assert_eq!(lock["packages"]["num-alias"][0], "is-number@7.0.0");
            assert_eq!(lock["packages"]["seven-alias"][0], "7zip-bin@5.2.0");
            assert_eq!(lock["packages"]["v8-alias"][0], "v8-to-istanbul@9.3.0");
            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);

            // External `file:` dependency with a `catalog:` peer installs cleanly without a provider.
            fs::remove_file("bun.lock").unwrap();
            fs::create_dir_all("vendor/ext-peer").unwrap();
            fs::write(
                "vendor/ext-peer/package.json",
                json!({
                    "name": "ext-peer",
                    "version": "1.0.0",
                    "peerDependencies": { "is-number": "catalog:" }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "ext-peer": "file:./vendor/ext-peer" }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(
                lock["packages"]["ext-peer"][0],
                "ext-peer@link:./vendor/ext-peer"
            );
            assert!(lock["packages"].get("is-number").is_none());

            // Unused catalog tarballs, overridden catalog tarballs, and separate catalog aliases
            // sharing a registry dependency's archive URL must not invalidate its registry lock row.
            let _ = fs::remove_dir_all("packages");
            let tarball_url = "https://other-registry.invalid/is-number/-/is-number-7.0.0.tgz";
            let alias_tarball = format!("npm:is-number@{tarball_url}");
            let archive_bytes =
                resolve::test_support::archive(&json!({"name": "is-number", "version": "7.0.0"}));
            let cases = [
                (
                    json!({
                        "name": "root",
                        "workspaces": {
                            "packages": ["packages/*"],
                            "catalog": { "unused-tarball": tarball_url }
                        },
                        "dependencies": { "is-number": "^7.0.0" }
                    }),
                    false,
                ),
                (
                    json!({
                        "name": "root",
                        "workspaces": {
                            "packages": ["packages/*"],
                            "catalog": { "is-number": tarball_url }
                        },
                        "dependencies": { "is-number": "catalog:" },
                        "overrides": { "is-number": "^7.0.0" }
                    }),
                    false,
                ),
                (
                    json!({
                        "name": "root",
                        "workspaces": {
                            "packages": ["packages/*"],
                            "catalog": { "other-alias": alias_tarball }
                        },
                        "dependencies": {
                            "is-number": "^7.0.0",
                            "other-alias": "catalog:"
                        }
                    }),
                    true,
                ),
            ];
            for (manifest, needs_tarball) in cases {
                assert_frozen_offline_registry_replay(
                    &manifest,
                    tarball_url,
                    needs_tarball.then_some(archive_bytes.as_slice()),
                );
            }

            // Member explicit catalog tarball sharing root's registry archive URL must not poison root's row.
            seed_registry_package("is-number", &["7.0.0"]);
            resolve::test_support::cache_archive(tarball_url, &archive_bytes);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "is-number": tarball_url }
                    },
                    "dependencies": { "is-number": "^7.0.0" }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "is-number": "catalog:" }
                }),
            );
            let _ = fs::remove_file("bun.lock");
            install("install", &["--lockfile-only"]).unwrap();
            let mut lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            lock["packages"]["is-number"][1] = json!(tarball_url);
            fs::write("bun.lock", serde_json::to_string_pretty(&lock).unwrap()).unwrap();
            let _ = fs::remove_dir_all(io::cache_dir());
            resolve::test_support::cache_archive(tarball_url, &archive_bytes);
            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();

            // Scoped tarball pins and version-qualified override transitive tarball pins survive `locked_sources`.
            let scoped_url = "https://packages.invalid/scoped.tgz";
            let locked = json!({
                "workspaces": {
                    "": {
                        "name": "root",
                        "dependencies": {
                            "@fixture/scoped": scoped_url,
                            "wrapper": "1.0.0"
                        }
                    }
                },
                "overrides": {
                    "versioned@^1": { ".": tarball_url }
                },
                "packages": {
                    "@fixture/scoped": ["@fixture/scoped@1.0.0", scoped_url, {}, "sha512-x=="],
                    "wrapper": ["wrapper@1.0.0", "", { "dependencies": { "versioned": "^1.0.0" } }, ""],
                    "versioned": ["versioned@1.0.0", tarball_url, {}, "sha512-y=="]
                }
            });
            let retained = resolve::tarball::locked_sources(&locked, &json!({}));
            assert!(retained.contains("@fixture/scoped"));
            assert!(retained.contains("versioned"));

            // A YAML numeric node without exact raw scalar text must fail explicitly, never silently round.
            struct UnrecoveredNumberParser;
            impl Transpiler for UnrecoveredNumberParser {
                fn transpile(
                    &self,
                    _: &str,
                    _: &str,
                    _: Loader,
                ) -> std::result::Result<String, String> {
                    unreachable!()
                }
                fn parse_data(
                    &self,
                    _: &[u8],
                    _: &str,
                ) -> std::result::Result<String, NativeError> {
                    Ok(json!({
                        "root": [1, 0],
                        "nodes": [
                            ["object", [[[0, "catalog"], [1, 1]]]],
                            ["object", [[[0, "versioned"], [4, "1.1"]]]]
                        ]
                    })
                    .to_string())
                }
            }
            let decoded =
                io::parsed_yaml_preserving_numbers(b"", &UnrecoveredNumberParser).unwrap();
            assert!(decoded["catalog"]["versioned"].is_number());
            let err = catalog::Catalogs::from_manifest(
                &json!({ "workspaces": ["packages/*"], "catalog": decoded["catalog"] }),
                &Value::Null,
            )
            .unwrap_err();
            assert!(err.contains("non-empty string"), "{err}");
        },
    );
}

fn assert_frozen_offline_registry_replay(
    manifest: &Value,
    tarball_url: &str,
    archive_bytes: Option<&[u8]>,
) {
    seed_registry_package("is-number", &["7.0.0"]);
    if let Some(bytes) = archive_bytes {
        resolve::test_support::cache_archive(tarball_url, bytes);
    }
    fs::write("package.json", manifest.to_string()).unwrap();
    let _ = fs::remove_file("bun.lock");
    install("install", &["--lockfile-only"]).unwrap();
    let mut lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
    lock["packages"]["is-number"][1] = json!(tarball_url);
    fs::write("bun.lock", serde_json::to_string_pretty(&lock).unwrap()).unwrap();
    let _ = fs::remove_dir_all(io::cache_dir());
    if let Some(bytes) = archive_bytes {
        resolve::test_support::cache_archive(tarball_url, bytes);
    }
    install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
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
            seed_registry_package("versioned", &["1.0.0", "2.10.0"]);
            seed_registry_package("other", &["1.0.0"]);
            seed_registry_package("is-number", &["7.0.0"]);
            seed_registry_package("is-odd", &["3.0.1"]);
            write_workspace(
                json!({
                    "name": "root",
                    "workspaces": ["packages/*"],
                    "dependencies": {
                        "versioned": " catalog:",
                        "is-number": "catalog:",
                        "is-odd": "catalog:",
                        "minor-pkg": "catalog:nums",
                        "aliased": "catalog:tools"
                    }
                }),
                "packages/a",
                json!({ "name": "@fixture/a", "version": "1.0.0" }),
            );
            seed_registry_package("minor-pkg", &["2.10.0", "2.1.0"]);
            fs::write(
                ".yarnrc.yml",
                "catalog:\n  versioned: \"npm:1\"\n  is-number: 7\n  is-odd: \"npm:latest\"\ncatalogs:\n  nums:\n    minor-pkg: 2.10\n  tools:\n    aliased: \"npm:other@^1.0.0\"\n",
            )
            .unwrap();
            fs::write(
                "yarn.lock",
                "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n  dependencies:\n    versioned: \"catalog:\"\n    is-number: \"catalog:\"\n    is-odd: \"catalog:\"\n    minor-pkg: \"catalog:nums\"\n    aliased: \"catalog:tools\"\n\n\"@fixture/a@workspace:packages/a\":\n  version: 0.0.0-use.local\n  resolution: \"@fixture/a@workspace:packages/a\"\n\n\"versioned@npm:1\":\n  version: 1.0.0\n  resolution: \"versioned@npm:1.0.0\"\n\n\"is-number@npm:7\":\n  version: 7.0.0\n  resolution: \"is-number@npm:7.0.0\"\n\n\"is-odd@npm:latest\":\n  version: 3.0.1\n  resolution: \"is-odd@npm:3.0.1\"\n\n\"minor-pkg@npm:2.10\":\n  version: 2.10.0\n  resolution: \"minor-pkg@npm:2.10.0\"\n\n\"aliased@npm:other@^1.0.0\":\n  version: 1.0.0\n  resolution: \"other@npm:1.0.0\"\n",
            )
            .unwrap();

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["catalog"]["versioned"], "npm:1");
            assert_eq!(lock["catalog"]["is-number"], "7");
            assert_eq!(lock["catalog"]["is-odd"], "npm:latest");
            assert_eq!(lock["catalogs"]["nums"]["minor-pkg"], "2.10");
            assert_eq!(lock["catalogs"]["tools"]["aliased"], "npm:other@^1.0.0");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(lock["packages"]["is-number"][0], "is-number@7.0.0");
            assert_eq!(lock["packages"]["is-odd"][0], "is-odd@3.0.1");
            assert_eq!(lock["packages"]["minor-pkg"][0], "minor-pkg@2.10.0");
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
                    "workspaces": ["packages/*"],
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
                    "workspaces": ["packages/*"],
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

#[test]
fn workspace_explicit_tarball_is_not_reused_for_root_registry_exact_version() {
    isolated(
        "workspace_explicit_tarball_is_not_reused_for_root_registry_exact_version",
        || {
            seed_registry_package("versioned", &["1.0.0", "2.0.0"]);
            let tarball_url = "https://packages.invalid/custom-versioned-1.0.0.tgz";
            let custom_archive = resolve::test_support::archive(&json!({
                "name": "versioned",
                "version": "1.0.0",
                "description": "from-explicit-tarball"
            }));
            resolve::test_support::cache_archive(tarball_url, &custom_archive);

            write_workspace(
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "2.0.0" },
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "versioned": tarball_url }
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
            let initial_lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(
                initial_lock["packages"]["@fixture/a/versioned"][1],
                tarball_url
            );

            // Switch root from registry 2.0.0 to exact registry 1.0.0: root must resolve from the
            // registry, never reuse @fixture/a's explicit 1.0.0 tarball lock row.
            fs::write(
                "package.json",
                json!({
                    "name": "root",
                    "dependencies": { "versioned": "1.0.0" },
                    "workspaces": {
                        "packages": ["packages/*"],
                        "catalog": { "versioned": tarball_url }
                    }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();

            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@1.0.0");
            assert_eq!(
                lock["packages"]["versioned"][1],
                "http://registry.invalid/versioned/-/versioned-1.0.0.tgz"
            );
            assert_eq!(lock["packages"]["@fixture/a/versioned"][1], tarball_url);

            let root_pkg =
                parse_json(&fs::read("node_modules/versioned/package.json").unwrap()).unwrap();
            assert!(
                root_pkg.get("description").is_none(),
                "root installed explicit tarball instead of registry package: {root_pkg}"
            );
            let member_pkg = parse_json(
                &fs::read("node_modules/@fixture/a/node_modules/versioned/package.json").unwrap(),
            )
            .unwrap();
            assert_eq!(member_pkg["description"], "from-explicit-tarball");
        },
    );
}

fn setup_catalog_tarball_two_member_workspace(
    versions: &[&str],
    tarball_version: &str,
    tarball_url: &str,
    b_manifest: Value,
) {
    seed_registry_package("versioned", versions);
    let custom_archive = resolve::test_support::archive(&json!({
        "name": "versioned",
        "version": tarball_version,
        "description": "from-catalog-tarball"
    }));
    resolve::test_support::cache_archive(tarball_url, &custom_archive);
    write_workspace(
        json!({
            "name": "root",
            "workspaces": {
                "packages": ["packages/*"],
                "catalog": { "versioned": tarball_url }
            }
        }),
        "packages/a",
        json!({
            "name": "@fixture/a",
            "version": "1.0.0",
            "dependencies": { "versioned": "catalog:" }
        }),
    );
    fs::create_dir_all("packages/b").unwrap();
    fs::write("packages/b/package.json", b_manifest.to_string()).unwrap();
}

#[test]
fn sibling_workspace_registry_dependency_does_not_reuse_hoisted_catalog_tarball() {
    isolated(
        "sibling_workspace_registry_dependency_does_not_reuse_hoisted_catalog_tarball",
        || {
            let tarball_url = "https://packages.invalid/catalog-versioned-1.0.1.tgz";
            setup_catalog_tarball_two_member_workspace(
                &["1.0.1"],
                "1.0.1",
                tarball_url,
                json!({
                    "name": "@fixture/b",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "1.0.1" }
                }),
            );

            install("install", &[]).unwrap();
            let lock_text = fs::read_to_string("bun.lock").unwrap();
            let lock = parse_json(lock_text.as_bytes()).unwrap();
            assert_eq!(lock["packages"]["versioned"][1], tarball_url);
            assert_eq!(
                lock["packages"]["@fixture/b/versioned"][1],
                "http://registry.invalid/versioned/-/versioned-1.0.1.tgz"
            );

            let assert_installed = || {
                let hoisted =
                    parse_json(&fs::read("node_modules/versioned/package.json").unwrap()).unwrap();
                assert_eq!(hoisted["description"], "from-catalog-tarball");
                let nested = parse_json(
                    &fs::read("node_modules/@fixture/b/node_modules/versioned/package.json")
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(nested["version"], "1.0.1");
                assert!(
                    nested.get("description").is_none(),
                    "workspace B reused workspace A's catalog tarball: {nested}"
                );
            };
            assert_installed();

            // Offline lockfile replay (both frozen and regular) must keep both archives distinct.
            let metadata_url = "http://registry.invalid/versioned";
            fs::remove_file(
                io::cache_dir().join(format!("{:x}", Sha256::digest(metadata_url.as_bytes()))),
            )
            .unwrap();
            fs::remove_dir_all("node_modules").unwrap();
            install("install", &["--frozen-lockfile"]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
            assert_installed();

            fs::remove_dir_all("node_modules").unwrap();
            install("install", &[]).unwrap();
            assert_eq!(fs::read_to_string("bun.lock").unwrap(), lock_text);
            assert_installed();
        },
    );
}

#[test]
fn pnpm_migration_expands_catalog_peer_dependencies_and_explicit_tarball_does_not_pin_tag() {
    isolated(
        "pnpm_migration_expands_catalog_peer_dependencies_and_explicit_tarball_does_not_pin_tag",
        || {
            // 1. pnpm-lock.yaml with autoInstallPeers=false omits peer from workspace importer when
            // root already provides it; migration must expand semver, dist-tag, and npm-alias
            // catalog peer ranges while ignoring peers shadowed by direct dependencies.
            seed_registry_package("is-number", &["7.0.0"]);
            seed_registry_package("versioned", &["1.0.0", "2.0.0"]);
            write_workspace(
                json!({
                    "name": "root",
                    "dependencies": {
                        "is-number": "catalog:",
                        "versioned": "catalog:",
                        "num-alias": "catalog:"
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "dependencies": { "shadowed": "1.0.0" },
                    "peerDependencies": {
                        "is-number": "catalog:",
                        "versioned": "catalog:",
                        "num-alias": "catalog:",
                        "shadowed": "catalog:missing"
                    }
                }),
            );
            seed_registry_package("shadowed", &["1.0.0"]);
            fs::write(
                "pnpm-workspace.yaml",
                "packages:\n  - packages/*\ncatalog:\n  is-number: ^7.0.0\n  versioned: latest\n  num-alias: npm:is-number@^7.0.0\n",
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\ncatalogs:\n  default:\n    is-number:\n      specifier: ^7.0.0\n      version: 7.0.0\n    versioned:\n      specifier: latest\n      version: 2.0.0\n    num-alias:\n      specifier: npm:is-number@^7.0.0\n      version: is-number@7.0.0\nimporters:\n  .:\n    dependencies:\n      is-number:\n        specifier: 'catalog:'\n        version: 7.0.0\n      versioned:\n        specifier: 'catalog:'\n        version: 2.0.0\n      num-alias:\n        specifier: 'catalog:'\n        version: is-number@7.0.0\n  packages/a:\n    dependencies:\n      shadowed:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  is-number@7.0.0:\n    resolution:\n      integrity: ''\n  versioned@2.0.0:\n    resolution:\n      integrity: ''\n  shadowed@1.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();
            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["is-number"][0], "is-number@7.0.0");
            assert_eq!(lock["packages"]["versioned"][0], "versioned@2.0.0");
            assert_eq!(lock["packages"]["num-alias"][0], "is-number@7.0.0");
            assert_eq!(lock["packages"]["shadowed"][0], "shadowed@1.0.0");
            assert_eq!(
                lock["workspaces"]["packages/a"]["peerDependencies"]["is-number"],
                "catalog:"
            );

            // 1b. Plain semver peers accept an aliased root provider, and catalog dist-tag peers
            // accept a visible root provider when pnpm-lock.yaml omits the peer's catalog entry.
            fs::remove_file("bun.lock").unwrap();
            let _ = fs::remove_dir_all("node_modules");
            write_workspace(
                json!({
                    "name": "root",
                    "dependencies": {
                        "versioned": "2.0.0",
                        "plain-alias": "npm:is-number@7.0.0",
                        "tag-alias": "npm:is-number@7.0.0"
                    }
                }),
                "packages/a",
                json!({
                    "name": "@fixture/a",
                    "version": "1.0.0",
                    "peerDependencies": {
                        "versioned": "catalog:",
                        "plain-alias": "^7.0.0",
                        "tag-alias": "catalog:"
                    }
                }),
            );
            fs::write(
                "pnpm-workspace.yaml",
                "packages:\n  - packages/*\ncatalog:\n  versioned: latest\n  tag-alias: npm:is-number@latest\n",
            )
            .unwrap();
            fs::write(
                "pnpm-lock.yaml",
                "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      versioned:\n        specifier: 2.0.0\n        version: 2.0.0\n      plain-alias:\n        specifier: npm:is-number@7.0.0\n        version: is-number@7.0.0\n      tag-alias:\n        specifier: npm:is-number@7.0.0\n        version: is-number@7.0.0\n  packages/a: {}\npackages:\n  is-number@7.0.0:\n    resolution:\n      integrity: ''\n  versioned@2.0.0:\n    resolution:\n      integrity: ''\n",
            )
            .unwrap();
            install("install", &["--frozen-lockfile", "--lockfile-only"]).unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][0], "versioned@2.0.0");
            assert_eq!(lock["packages"]["plain-alias"][0], "is-number@7.0.0");
            assert_eq!(lock["packages"]["tag-alias"][0], "is-number@7.0.0");

            // 2. Moving `versioned: "latest"` from peerDependencies to dependencies must not pin
            // to a sibling's hoisted explicit catalog tarball version (`1.0.0` vs registry `2.0.0`).
            fs::remove_file("bun.lock").unwrap();
            fs::remove_file("pnpm-lock.yaml").unwrap();
            fs::remove_file("pnpm-workspace.yaml").unwrap();
            let _ = fs::remove_dir_all("node_modules");
            let tarball_url = "https://packages.invalid/catalog-versioned-1.0.0.tgz";
            setup_catalog_tarball_two_member_workspace(
                &["1.0.0", "2.0.0"],
                "1.0.0",
                tarball_url,
                json!({
                    "name": "@fixture/b",
                    "version": "1.0.0",
                    "peerDependencies": { "versioned": "latest" }
                }),
            );
            install("install", &[]).unwrap();

            fs::write(
                "packages/b/package.json",
                json!({
                    "name": "@fixture/b",
                    "version": "1.0.0",
                    "dependencies": { "versioned": "latest" }
                })
                .to_string(),
            )
            .unwrap();
            install("install", &[]).unwrap();
            let lock = parse_json(&fs::read("bun.lock").unwrap()).unwrap();
            assert_eq!(lock["packages"]["versioned"][1], tarball_url);
            assert_eq!(
                lock["packages"]["@fixture/b/versioned"][0],
                "versioned@2.0.0"
            );
            let nested = parse_json(
                &fs::read("node_modules/@fixture/b/node_modules/versioned/package.json").unwrap(),
            )
            .unwrap();
            assert_eq!(nested["version"], "2.0.0");
        },
    );
}
