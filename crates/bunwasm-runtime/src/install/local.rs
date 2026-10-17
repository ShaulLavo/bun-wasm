use super::{
    io::{self, Result},
    resolve,
};
use crate::Transpiler;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Local {
    pub path: PathBuf,
    pub meta: Value,
    pub workspace: bool,
}

pub fn root(parser: &dyn Transpiler) -> Result<Option<PathBuf>> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    for ancestor in cwd.ancestors().skip(1) {
        if !ancestor.join("package.json").exists() {
            continue;
        }
        let manifest = io::read(&ancestor.join("package.json"), "JSON", parser)?;
        if manifest.get("workspaces").is_none() {
            continue;
        }
        let members = workspaces(ancestor, &manifest, parser)?;
        if members.values().any(|member| member.path == cwd) {
            std::env::set_current_dir(ancestor).map_err(|e| e.to_string())?;
            return Ok(Some(cwd));
        }
    }
    Ok(None)
}

pub fn workspaces(root: &Path, manifest: &Value, parser: &dyn Transpiler) -> Result<BTreeMap<String, Local>> {
    let mut members = BTreeMap::new();
    let config = &manifest["workspaces"];
    if config.is_null() {
        return Ok(members);
    }
    let patterns = config
        .as_array()
        .or_else(|| config["packages"].as_array())
        .ok_or("workspaces must be an array or an object with packages")?;
    let mut paths = Vec::new();
    for pattern in patterns {
        let pattern = pattern.as_str().ok_or("workspace patterns must be strings")?;
        let (exclude, pattern) = pattern.strip_prefix('!').map_or((false, pattern), |p| (true, p));
        let pattern = format!("{}/package.json", pattern.trim_end_matches('/'));
        let mut walker = bun_glob::BunGlobWalker::init_with_cwd(
            pattern.as_bytes(),
            root.to_string_lossy().as_bytes(),
            false,
            true,
            false,
            false,
            true,
            None,
        )
        .map_err(|e| format!("Workspace glob: {e:?}"))?
        .map_err(|e| format!("Workspace glob: {e:?}"))?;
        walker
            .walk()
            .map_err(|e| format!("Workspace glob: {e:?}"))?
            .map_err(|e| format!("Workspace glob: {e:?}"))?;
        for path in walker.matched_paths.keys().iter() {
            let path = PathBuf::from(String::from_utf8_lossy(path).into_owned());
            if exclude {
                paths.retain(|p| p != &path);
            } else {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths.dedup();
    for path in paths {
        let meta = io::read(&path, "JSON", parser)?;
        let name = meta["name"]
            .as_str()
            .ok_or("Workspace package.json needs a name")?
            .to_owned();
        resolve::valid_name(&name)?;
        let local = Local {
            path: path.parent().unwrap().to_owned(),
            meta,
            workspace: true,
        };
        if members.insert(name.clone(), local).is_some() {
            return Err(format!("Duplicate workspace name: {name}"));
        }
    }
    Ok(members)
}

pub fn link(target: &Path, path: &Path) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Invalid link path")?).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_symlink() && fs::read_link(path).ok().as_deref() == Some(target) {
            return Ok(());
        }
        if meta.is_dir() && !meta.is_symlink() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
        .map_err(|e| e.to_string())?;
    }
    super::super::natives::symlink(&target.to_string_lossy(), &path.to_string_lossy()).map_err(|e| e.to_string())
}

pub fn lock_meta(meta: &Value) -> Value {
    let mut row = json!({});
    for field in [
        "name",
        "version",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if !meta[field].is_null() {
            row[field] = meta[field].clone();
        }
    }
    row
}
