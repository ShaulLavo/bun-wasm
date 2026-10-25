use super::*;

fn resolver(locked: Value) -> Resolver {
    let mut resolver = Resolver::new(
        io::Registry::new("http://registry.invalid").unwrap(),
        locked,
        false,
    );
    for name in ["versioned", "@fixture/selected", "selector-fits"] {
        let mut versions = json!({});
        for version in ["0.5.0", "1.0.0", "2.0.0"] {
            versions[version] = json!({"name":name,"version":version,"dist":{"tarball":format!("http://registry.invalid/{name}-{version}.tgz")}});
        }
        resolver.packuments.insert(
            name.into(),
            json!({"dist-tags":{"latest":"2.0.0"},"versions":versions}),
        );
    }
    resolver
}

fn alias_pin(transitive: bool) {
    let parent = json!({"dependencies":{"alias":"npm:versioned@latest"}});
    let dependencies = if transitive {
        json!({"parent":"1.0.0"})
    } else {
        parent["dependencies"].clone()
    };
    let mut locked = json!({"packages":{"alias":["versioned@1.0.0","http://registry.invalid/versioned.tgz",{},""]},"workspaces":{"":{"dependencies":dependencies}}});
    if transitive {
        locked["packages"]["parent"] = json!([
            "parent@1.0.0",
            "http://registry.invalid/parent.tgz",
            parent,
            ""
        ]);
    }
    let before = locked.clone();
    let mut resolver = resolver(locked);
    resolver
        .resolve(
            &json!({"dependencies":dependencies,"overrides":{"versioned":"2.0.0"}}),
            false,
        )
        .unwrap();
    assert_eq!(resolver.packages["alias"].version, "1.0.0");
    assert_eq!(resolver.locked, before);
}

#[test]
fn root_alias_keeps_unrelated_target_pin() {
    alias_pin(false);
}

#[test]
fn transitive_alias_keeps_unrelated_target_pin() {
    alias_pin(true);
}

fn local_root(workspace: bool) {
    let name = if workspace {
        "workspace_override_is_root_relative"
    } else {
        "local_override_is_root_relative"
    };
    if std::env::var("BUN_WASM_OVERRIDE_TEST").as_deref() != Ok(name) {
        return isolated(name);
    }
    for path in ["parent", "replacement", "parent/declared"] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write("parent/package.json", json!({"name":"parent","version":"1.0.0","dependencies":{"selector-fits":"^1","declared":"file:./declared"}}).to_string()).unwrap();
    std::fs::write(
        "replacement/package.json",
        r#"{"name":"selector-fits","version":"0.5.0"}"#,
    )
    .unwrap();
    std::fs::write(
        "parent/declared/package.json",
        r#"{"name":"declared","version":"1.0.0"}"#,
    )
    .unwrap();
    let manifest = json!({"dependencies":{"parent":"file:./parent"},"overrides":{"selector-fits":"file:./replacement"}});
    let mut resolver = resolver(json!({}));
    if workspace {
        let mut local = resolver
            .local_package("parent", "file:./parent")
            .unwrap()
            .unwrap();
        local.workspace = true;
        resolver.workspaces.insert("parent".into(), local);
    }
    resolver.resolve(&manifest, false).unwrap();
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        resolver.packages["selector-fits"]
            .local
            .as_ref()
            .unwrap()
            .path,
        cwd.join("replacement")
    );
    assert_eq!(
        resolver.packages["declared"].local.as_ref().unwrap().path,
        cwd.join("parent/declared")
    );
}

fn isolated(name: &str) {
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-overrides-{}-{name}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("install::resolve::override_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(&directory)
        .env("BUN_WASM_OVERRIDE_TEST", name)
        .output();
    std::fs::remove_dir_all(directory).unwrap();
    let output = output.unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn local_override_is_root_relative() {
    local_root(false);
}

#[test]
fn workspace_override_is_root_relative() {
    local_root(true);
}

#[test]
fn explicit_alias_selectors_match_identity_and_intersection() {
    for target in ["versioned", "@fixture/selected"] {
        let key = format!("alias@npm:{target}@^1");
        let manifest = json!({"dependencies":{"alias":format!("npm:{target}@<2")},"overrides":{key.clone():"npm:selector-fits@0.5.0",target:"2.0.0"}});
        let mut resolver = resolver(json!({}));
        resolver.resolve(&manifest, false).unwrap();
        assert_eq!(resolver.packages["alias"].name, "selector-fits");
        assert_eq!(resolver.packages["alias"].version, "0.5.0");
        assert_eq!(
            resolver.overrides.metadata[&key],
            json!({".":"npm:selector-fits@0.5.0"})
        );
    }
}
