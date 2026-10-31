#[path = "args.rs"]
mod args;

use args::*;

const CLI_USAGE: &str = "usage: bun build <entrypoint>... [--outdir dir | --outfile file] [--minify] \
[--minify-syntax] [--minify-whitespace] [--minify-identifiers] [--format esm|cjs|iife] \
[--target browser|bun|node] [--sourcemap[=linked|inline|external|none]] [--splitting] \
[--external pkg] [--packages bundle|external] [--define K=V] [--root dir] [--public-path p] \
[--entry-naming t] [--chunk-naming t] [--asset-naming t] [--banner s] [--footer s] \
[--production] [--react-fast-refresh] [--no-bundle] [--keep-names] [--metafile[=path]] [--conditions c]";

type Expected = Result<Option<BuildArgs>, String>;

fn cases(usage: &str) -> Vec<(Vec<&'static str>, Expected)> {
    let defaults = BuildArgs::default;
    let mut cases = vec![
        (vec![], Ok(Some(defaults()))),
        (
            vec!["entry.ts", "other=entry.ts"],
            Ok(Some(BuildArgs {
                entry_points: vec!["entry.ts".into(), "other=entry.ts".into()],
                ..defaults()
            })),
        ),
        (
            vec!["--react-fast-refresh"],
            Ok(Some(BuildArgs {
                react_fast_refresh: true,
                ..defaults()
            })),
        ),
        (
            vec![
                "--minify=false",
                "--splitting",
                "--production",
                "--keep-names",
                "--no-bundle",
            ],
            Ok(Some(BuildArgs {
                minify_syntax: true,
                minify_whitespace: true,
                minify_identifiers: true,
                splitting: true,
                production: true,
                keep_names: true,
                no_bundle: true,
                ..defaults()
            })),
        ),
        (
            vec![
                "--minify-syntax",
                "--minify-whitespace",
                "--minify-identifiers",
            ],
            Ok(Some(BuildArgs {
                minify_syntax: true,
                minify_whitespace: true,
                minify_identifiers: true,
                ..defaults()
            })),
        ),
        (
            vec![
                "--outdir",
                "first",
                "--outdir=last",
                "--outfile=out.js",
                "--root",
                "src",
            ],
            Ok(Some(BuildArgs {
                outdir: Some("last".into()),
                outfile: Some("out.js".into()),
                root: Some("src".into()),
                ..defaults()
            })),
        ),
        (
            vec!["--outdir=", "--outfile", "--help"],
            Ok(Some(BuildArgs {
                outdir: Some("".into()),
                outfile: Some("--help".into()),
                ..defaults()
            })),
        ),
        (
            vec![
                "-e",
                "one",
                "--external=two",
                "--external",
                "three",
                "--drop=console",
                "--conditions",
                "custom",
                "--conditions=browser",
            ],
            Ok(Some(BuildArgs {
                external: vec!["one".into(), "two".into(), "three".into()],
                drop: vec!["console".into()],
                conditions: vec!["custom".into(), "browser".into()],
                ..defaults()
            })),
        ),
        (
            vec![
                "--define",
                "A=1=2",
                "--define=B:two",
                "--define==empty-key",
                "--define",
                "EMPTY=",
            ],
            Ok(Some(BuildArgs {
                define: vec![
                    ("A".into(), "1=2".into()),
                    ("B".into(), "two".into()),
                    ("".into(), "empty-key".into()),
                    ("EMPTY".into(), "".into()),
                ],
                ..defaults()
            })),
        ),
        (
            vec![
                "--public-path=/assets",
                "--banner",
                "before",
                "--footer=after",
                "--entry-naming",
                "[name].js",
                "--chunk-naming=chunk-[hash].js",
                "--asset-naming",
                "asset-[hash]",
            ],
            Ok(Some(BuildArgs {
                public_path: Some("/assets".into()),
                banner: Some("before".into()),
                footer: Some("after".into()),
                entry_naming: Some("[name].js".into()),
                chunk_naming: Some("chunk-[hash].js".into()),
                asset_naming: Some("asset-[hash]".into()),
                ..defaults()
            })),
        ),
        (
            vec!["--sourcemap", "inline", "--metafile", "meta.json"],
            Ok(Some(BuildArgs {
                sourcemap: SourceMap::Linked,
                metafile: Some("".into()),
                entry_points: vec!["inline".into(), "meta.json".into()],
                ..defaults()
            })),
        ),
        (
            vec!["--metafile=custom.json", "--sourcemap="],
            Ok(Some(BuildArgs {
                metafile: Some("custom.json".into()),
                sourcemap: SourceMap::Linked,
                ..defaults()
            })),
        ),
        (vec!["-h"], Ok(None)),
        (vec!["--help=ignored", "--invalid"], Ok(None)),
        (
            vec!["--react-fast-refresh", "entry.tsx", "--help"],
            Ok(None),
        ),
        (
            vec!["--format=bad"],
            Err("Invalid value for --format: \"bad\". Must be 'esm', 'cjs', or 'iife'.".into()),
        ),
        (
            vec!["--target", "bad"],
            Err("invalid target \"bad\"".into()),
        ),
        (
            vec!["--sourcemap=bad"],
            Err("Invalid sourcemap setting: \"bad\"".into()),
        ),
        (
            vec!["--packages=bad"],
            Err("Invalid packages setting: \"bad\"".into()),
        ),
        (
            vec!["--define", "bad"],
            Err("--define expects KEY=VALUE".into()),
        ),
        (
            vec!["entry.ts", "--unknown=value"],
            Err(format!("unknown flag --unknown\n{usage}")),
        ),
        (
            vec!["--", "-entry.ts"],
            Err(format!("unknown flag --\n{usage}")),
        ),
        (
            vec!["-e=value"],
            Err(format!("unknown flag -e=value\n{usage}")),
        ),
    ];
    for flag in [
        "--outdir",
        "--outfile",
        "--root",
        "--cwd",
        "--format",
        "--target",
        "--packages",
        "-e",
        "--external",
        "--define",
        "--drop",
        "--conditions",
        "--public-path",
        "--banner",
        "--footer",
        "--entry-naming",
        "--chunk-naming",
        "--asset-naming",
    ] {
        let name = if flag == "-e" { "--external" } else { flag };
        cases.push((vec![flag], Err(format!("{name} needs a value"))));
    }
    for (flag, format) in [
        ("--format=esm", Format::Esm),
        ("--format=cjs", Format::Cjs),
        ("--format=iife", Format::Iife),
    ] {
        cases.push((
            vec![flag],
            Ok(Some(BuildArgs {
                format,
                ..defaults()
            })),
        ));
    }
    for (flag, target) in [
        ("--target=browser", Target::Browser),
        ("--target=bun", Target::Bun),
        ("--target=node", Target::Node),
    ] {
        cases.push((
            vec![flag],
            Ok(Some(BuildArgs {
                target: Some(target),
                ..defaults()
            })),
        ));
    }
    for (flag, sourcemap) in [
        ("--sourcemap=linked", SourceMap::Linked),
        ("--sourcemap=inline", SourceMap::Inline),
        ("--sourcemap=external", SourceMap::External),
        ("--sourcemap=none", SourceMap::None),
    ] {
        cases.push((
            vec![flag],
            Ok(Some(BuildArgs {
                sourcemap,
                ..defaults()
            })),
        ));
    }
    for (flag, packages) in [
        ("--packages=bundle", Packages::Bundle),
        ("--packages=external", Packages::External),
    ] {
        cases.push((
            vec![flag],
            Ok(Some(BuildArgs {
                packages: Some(packages),
                ..defaults()
            })),
        ));
    }
    cases
}

fn check_case(entrypoint: BuildEntrypoint, input: Vec<&str>, expected: Expected) {
    let actual = parse_build_args(input.iter().map(|value| (*value).to_owned()), entrypoint);
    assert_eq!(actual, expected, "{entrypoint:?} {input:?}");
}

fn matrix(entrypoint: BuildEntrypoint) {
    let expected_usage = match entrypoint {
        BuildEntrypoint::Bun => CLI_USAGE.to_owned(),
        BuildEntrypoint::Standalone => CLI_USAGE.replacen("bun build", "bun-build", 1),
    };
    assert_eq!(entrypoint.usage(), expected_usage);
    for (input, expected) in cases(&expected_usage) {
        check_case(entrypoint, input, expected);
    }
}

#[test]
fn bun_build_matrix() {
    matrix(BuildEntrypoint::Bun);
}

#[test]
fn standalone_matrix() {
    matrix(BuildEntrypoint::Standalone);
}

#[test]
fn cwd_ordering() {
    let Some(root) = std::env::var_os("BUN_WASM_BUILD_CWD_TEST") else {
        return run_cwd_child();
    };
    for entrypoint in [BuildEntrypoint::Bun, BuildEntrypoint::Standalone] {
        check_cwd_ordering(entrypoint, std::path::Path::new(&root));
    }
}

fn check_cwd_ordering(entrypoint: BuildEntrypoint, root: &std::path::Path) {
    std::env::set_current_dir(root).unwrap();
    let result = parse_build_args(
        ["--cwd", "nested", "--cwd=deeper", "--help", "--bad"].map(String::from),
        entrypoint,
    );
    assert!(matches!(result, Ok(None)));
    assert_eq!(std::env::current_dir().unwrap(), root.join("nested/deeper"));
    assert!(
        parse_build_args(["--cwd=missing", "--help"].map(String::from), entrypoint)
            .unwrap_err()
            .starts_with("--cwd missing: ")
    );
    let result = parse_build_args(["--cwd=..", "--bad"].map(String::from), entrypoint);
    assert!(result.unwrap_err().starts_with("unknown flag --bad\n"));
    assert_eq!(std::env::current_dir().unwrap(), root.join("nested"));
    let result =
        parse_build_args(["--cwd=deeper", "entry.ts"].map(String::from), entrypoint).unwrap();
    let Some(args) = result else {
        panic!("expected build")
    };
    assert_eq!(args.cwd, None);
    assert_eq!(args.entry_points, ["entry.ts"]);
    assert_eq!(std::env::current_dir().unwrap(), root.join("nested/deeper"));
}

struct CwdFixture(std::path::PathBuf);

impl Drop for CwdFixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn run_cwd_child() {
    let root = std::env::temp_dir().join(format!(
        "bun-wasm-build-cwd-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let fixture = CwdFixture(root);
    std::fs::create_dir_all(fixture.0.join("nested/deeper")).unwrap();
    let thread = std::thread::current();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", thread.name().unwrap(), "--nocapture"])
        .env("BUN_WASM_BUILD_CWD_TEST", &fixture.0)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
