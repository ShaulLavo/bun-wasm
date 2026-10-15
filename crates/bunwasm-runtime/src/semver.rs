//! The same parser, range matching and ordering as Bun's SemverObject bridge.
use core::cmp::Ordering;

use bun_semver::{SlicedString, Version, query};

use crate::engine::NativeError;
use crate::natives::Table;

pub fn install(table: &mut Table) {
    table.add("semverSatisfies", |args| {
        let version = args.str(0)?.as_bytes();
        let range = args.str(1)?.as_bytes();
        if !version.is_ascii() || !range.is_ascii() {
            return Ok(false.into());
        }
        let Some(version_value) = Version::parse_exact(SlicedString::init(version, version)) else {
            return Ok(false.into());
        };
        let group = query::parse(range, SlicedString::init(range, range))
            .map_err(|_| NativeError::error("Out of memory"))?;
        let result = match group.get_exact_version() {
            Some(exact) => version_value.eql(exact),
            None => group.satisfies(version_value, range, version),
        };
        Ok(result.into())
    });
    table.add("semverOrder", |args| {
        let left = args.str(0)?.as_bytes();
        let right = args.str(1)?.as_bytes();
        if !left.is_ascii() || !right.is_ascii() {
            return Ok(0.into());
        }
        let left_version = parsed_version(left)?;
        let right_version = parsed_version(right)?;
        let result = match left_version.order_without_build(right_version, left, right) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        };
        Ok(result.into())
    });
}

fn parsed_version(input: &[u8]) -> Result<Version, NativeError> {
    let result = Version::parse(SlicedString::init(input, input));
    if !result.valid {
        return Err(NativeError::error(format!("Invalid SemVer: {}\n", String::from_utf8_lossy(input))));
    }
    Ok(result.version.max())
}
