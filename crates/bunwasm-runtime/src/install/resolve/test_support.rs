use super::{Resolver, Value, json, lock_info};

pub(super) fn lock_snapshot(manifest: &Value, resolver: &Resolver) -> Value {
    let mut locked = json!({"packages": {}, "workspaces": {"": manifest}});
    for (key, package) in resolver.packages.iter().chain(&resolver.skipped) {
        locked["packages"][key] = json!([
            format!("{}@{}", package.name, package.version),
            package.tarball,
            lock_info(&package.meta),
            package.integrity
        ]);
    }
    locked
}

pub(super) fn archive(meta: &Value) -> Vec<u8> {
    let compressor = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(compressor);
    let bytes = serde_json::to_vec(meta).unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "package/package.json", bytes.as_slice())
        .unwrap();
    archive.into_inner().unwrap().finish().unwrap()
}
