use std::borrow::Cow;
use std::fs::File;
use std::io;
use std::path::Path;

use sha2::{Digest, Sha256};

const WASM: &str = "006b1889047c7e437732104a61d92f15967516a84d7bc738f043e870ac5d0679";

fn file_digest(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    io::copy(&mut file, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn source_digest(path: &str) -> Option<&'static str> {
    let filename = path
        .rsplit_once("/node_modules/@rolldown/binding-wasm32-wasi/")?
        .1;
    match filename {
        "rolldown-binding.wasi.cjs" => {
            Some("01fd76391144044f32cb53d6de240fb6abe85a98180517db78c010e514303612")
        }
        "rolldown-binding.wasi-browser.js" => {
            Some("169928275e38b417fd87baacd822509abcc0a547893c4f7b59524d17d65e7635")
        }
        _ => None,
    }
}

pub(super) fn depends_on_binary(path: &str) -> bool {
    source_digest(path).is_some()
}

pub(super) fn adapt<'a>(source: &'a str, path: &str) -> Cow<'a, str> {
    let Some(expected) = source_digest(path) else {
        return Cow::Borrowed(source);
    };
    if format!("{:x}", Sha256::digest(source.as_bytes())) != expected {
        return Cow::Borrowed(source);
    }
    let Some(directory) = Path::new(path).parent() else {
        return Cow::Borrowed(source);
    };
    if directory
        .join("rolldown-binding.wasm32-wasi.debug.wasm")
        .exists()
    {
        return Cow::Borrowed(source);
    }
    let wasm = directory.join("rolldown-binding.wasm32-wasi.wasm");
    if file_digest(&wasm).ok().as_deref() != Some(WASM) {
        return Cow::Borrowed(source);
    }
    // The real binary imports 1001 pages. Equal width preserves source positions.
    Cow::Owned(source.replacen("initial: 16384,", "initial: 1001 ,", 1))
}
