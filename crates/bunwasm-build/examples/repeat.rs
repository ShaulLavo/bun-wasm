//! `repeat <n> <entry> <outdir>`: run the same build n times in one process.
fn main() {
    #[cfg(target_os = "wasi")]
    bunwasm_glue::init();
    let a: Vec<String> = std::env::args().collect();
    let n: usize = a[1].parse().unwrap();
    let mut args = bunwasm_build::BuildArgs {
        entry_points: vec![a[2].clone()],
        outdir: Some(a[3].clone()),
        ..Default::default()
    };
    let mut first: Option<Vec<Vec<u8>>> = None;
    for i in 0..n {
        args.set_minify(i % 2 == 1);
        let out = bunwasm_build::build(&args).unwrap_or_else(|e| panic!("build {i}: {e}"));
        let contents: Vec<Vec<u8>> = out.files.iter().map(|f| f.contents.clone()).collect();
        if i < 2 {
            print!("{}", out.summary(0, false));
        } else if Some(&contents) != first.as_ref().filter(|_| i % 2 == 0) && i % 2 == 0 {
            panic!("build {i} differs");
        }
        if i == 0 {
            first = Some(contents);
        }
    }
    println!("{n} builds ok");
}
