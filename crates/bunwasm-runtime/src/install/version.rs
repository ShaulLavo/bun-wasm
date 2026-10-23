use std::path::Path;

use bun_semver::{SlicedString, Version};

use super::io::{self, Result};
use crate::Transpiler;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

enum Change {
    Patch,
    Minor,
    Major,
    Specific(String),
}

fn parsed(input: &str) -> Option<Version> {
    let bytes = input.as_bytes();
    Version::parse_exact(SlicedString::init(bytes, bytes))
        .filter(|version| version.major.max(version.minor).max(version.patch) <= MAX_SAFE_INTEGER)
}

fn normalized(version: Version, input: &str) -> String {
    let core = format!("{}.{}.{}", version.major, version.minor, version.patch);
    if !version.tag.has_pre() {
        return core;
    }
    format!(
        "{core}-{}",
        String::from_utf8_lossy(version.tag.pre.slice(input.as_bytes()))
    )
}

impl Change {
    fn parse(input: &str) -> Result<Self> {
        match input {
            "patch" => return Ok(Self::Patch),
            "minor" => return Ok(Self::Minor),
            "major" => return Ok(Self::Major),
            "prepatch" | "preminor" | "premajor" | "prerelease" | "from-git" => {
                return Err(format!(
                    "bun pm version {input} is not supported in bun-wasm"
                ));
            }
            _ => {}
        }
        let version = parsed(input).ok_or_else(|| format!(
            "Invalid version argument: \"{input}\"\nnote: Valid options: patch, minor, major, prepatch, preminor, premajor, prerelease, from-git, or a specific semver version"
        ))?;
        Ok(Self::Specific(normalized(version, input)))
    }

    fn apply(&self, current: &str) -> Result<String> {
        if let Self::Specific(version) = self {
            return Ok(version.clone());
        }
        let version = parsed(current)
            .ok_or_else(|| format!("Current version \"{current}\" is not a valid semver"))?;
        let (major, minor, patch) = (version.major, version.minor, version.patch);
        let next = match self {
            Self::Patch if version.tag.has_pre() => format!("{major}.{minor}.{patch}"),
            Self::Patch => format!("{major}.{minor}.{}", patch + 1),
            Self::Minor if version.tag.has_pre() && patch == 0 => format!("{major}.{minor}.0"),
            Self::Minor => format!("{major}.{}.0", minor + 1),
            Self::Major if version.tag.has_pre() && minor == 0 && patch == 0 => {
                format!("{major}.0.0")
            }
            Self::Major => format!("{}.0.0", major + 1),
            Self::Specific(_) => unreachable!(),
        };
        parsed(&next).ok_or("Resulting version is not a valid semver")?;
        Ok(next)
    }
}

pub(super) fn run(args: impl Iterator<Item = String>, parser: &dyn Transpiler) -> Result<()> {
    let mut requested = None;
    let mut no_git = false;
    let mut allow_same = false;
    let mut dry_run = false;
    let mut ignore_scripts = false;
    let mut args = args;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--no-git-tag-version" => no_git = true,
            "--allow-same-version" => allow_same = true,
            "--dry-run" => dry_run = true,
            "--ignore-scripts" => ignore_scripts = true,
            "--cwd" => std::env::set_current_dir(args.next().ok_or("--cwd requires a directory")?)
                .map_err(|e| e.to_string())?,
            flag if flag.starts_with('-') => return Err(format!("Unknown version option: {flag}")),
            _ if requested.is_none() => requested = Some(Change::parse(&arg)?),
            _ => return Err("bun pm version requires one version argument".into()),
        }
    }
    let change = requested.ok_or("bun pm version requires a version argument")?;
    let path = Path::new("package.json");
    let mut manifest = io::read(path, "JSON", parser)?;
    if !manifest.is_object() {
        return Err("Failed to parse package.json: root must be an object".into());
    }
    let current = manifest["version"].as_str();
    let next = change.apply(current.unwrap_or("0.0.0"))?;
    if !allow_same && current == Some(next.as_str()) {
        return Err("Version not changed".into());
    }
    if !no_git && !dry_run {
        return Err("bun pm version requires --no-git-tag-version in bun-wasm".into());
    }
    if dry_run {
        println!("v{next}");
        return Ok(());
    }
    if !ignore_scripts
        && ["preversion", "version", "postversion"]
            .iter()
            .any(|name| manifest["scripts"][name].is_string())
    {
        return Err(
            "Version lifecycle scripts are not supported in bun-wasm; use --ignore-scripts".into(),
        );
    }
    manifest["version"] = next.clone().into();
    io::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()).as_bytes(),
    )?;
    println!("v{next}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_versions_are_rejected_before_changing_a_manifest() {
        for input in ["1.0.18446744073709551616", "9007199254740992.0.0", "1.2"] {
            assert!(Change::parse(input).is_err(), "{input}");
            assert!(Change::Patch.apply(input).is_err(), "{input}");
        }
    }

    #[test]
    fn increments_and_normalizes_versions() {
        for (input, current, expected) in [
            ("patch", "1.2.3", "1.2.4"),
            ("patch", "1.2.3-rc.1", "1.2.3"),
            ("minor", "1.2.0-rc.1", "1.2.0"),
            ("major", "2.0.0-rc.1", "2.0.0"),
            ("v3.4.5-rc.1+build", "invalid", "3.4.5-rc.1"),
        ] {
            assert_eq!(
                Change::parse(input).unwrap().apply(current).unwrap(),
                expected
            );
        }
        assert!(Change::Patch.apply("1.2.9007199254740991").is_err());
    }
}
