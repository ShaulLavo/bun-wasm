use std::borrow::Cow;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

struct Binding {
    name: &'static str,
    source: &'static str,
    wasm: &'static str,
    initial: &'static str,
}

// These identities bind the layout to the unmodified public 0.94.0 packages.
static BINDINGS: [Binding; 3] = [
    Binding {
        name: "parser",
        source: "ad3db1eb96b2b8d5e2cd66a4c292361c76b7619dfef8bf91138acd1796404a5f",
        wasm: "524ab47f068fac666372e1466f650d434036f427b5f9004b6faf4c8583a1587c",
        initial: "980 ",
    },
    Binding {
        name: "transform",
        source: "43c898b7b5ccef7581aec0112b2b3dc37ec6f31bc489208fdc6dcc9d23997f30",
        wasm: "d47a282563172705ed12004d2be59b952186f28e2494f97c4e002064b7b4d60f",
        initial: "981 ",
    },
    Binding {
        name: "minify",
        source: "5065d23453b3d9e8996a7f56cc4aa48feee33263d2aeab4d9c3d64d6b2396ceb",
        wasm: "e21979305f89d13739a47364e54a32682265f6a75bf1685f27e760a6f9b23779",
        initial: "981 ",
    },
];

fn file_digest(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        digest.update(&buffer[..count]);
    }
}

fn binding(path: &str) -> Option<&'static Binding> {
    if !path.ends_with(".wasi.cjs") {
        return None;
    }
    BINDINGS.iter().find(|binding| {
        path.ends_with(&format!(
            "/node_modules/@oxc-{}/binding-wasm32-wasi/{}.wasi.cjs",
            binding.name, binding.name
        ))
    })
}

pub(super) fn depends_on_binary(path: &str) -> bool {
    binding(path).is_some()
}

pub(super) fn adapt<'a>(source: &'a str, path: &str) -> Cow<'a, str> {
    let Some(binding) = binding(path) else {
        return Cow::Borrowed(source);
    };
    if format!("{:x}", Sha256::digest(source.as_bytes())) != binding.source {
        return Cow::Borrowed(source);
    }
    let Some(directory) = Path::new(path).parent() else {
        return Cow::Borrowed(source);
    };
    if directory
        .join(format!("{}.wasm32-wasi.debug.wasm", binding.name))
        .exists()
    {
        return Cow::Borrowed(source);
    }
    let wasm = directory.join(format!("{}.wasm32-wasi.wasm", binding.name));
    if file_digest(&wasm).ok().as_deref() != Some(binding.wasm) {
        return Cow::Borrowed(source);
    }
    // Equal-width replacement keeps every original source position unchanged.
    Cow::Owned(source.replacen(
        "initial: 4000,",
        &format!("initial: {},", binding.initial),
        1,
    ))
}
