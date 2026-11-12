use std::{env, fs, hint::black_box, process::Command};

unsafe extern "C" {
    fn setsid() -> i32;
}

#[inline(never)]
fn spin(iterations: u64) -> u64 {
    let mut value = 0u64;
    for index in 0..iterations {
        value = black_box(value).wrapping_add(black_box(index));
    }
    value
}

fn threads(count: u64) {
    let handles: Vec<_> = (0..2)
        .map(|_| std::thread::spawn(move || spin(count)))
        .collect();
    for handle in handles {
        println!("{}", handle.join().unwrap());
    }
}

fn wait(path: &str) {
    unsafe {
        setsid();
    }
    fs::write(path, std::process::id().to_string()).unwrap();
    std::thread::sleep(std::time::Duration::from_secs(60));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("spin") => {
            let iterations: u64 = args[2].parse().unwrap();
            println!("{}", spin(iterations));
        }
        Some("orphan-spin") => {
            Command::new(env::current_exe().unwrap())
                .args(["spin", &args[2]])
                .spawn()
                .unwrap();
        }
        Some("threads") => threads(args[2].parse().unwrap()),
        Some("wait") => wait(&args[2]),
        Some("orphan-wait") => {
            Command::new(env::current_exe().unwrap())
                .args(["wait", &args[2]])
                .spawn()
                .unwrap();
        }
        _ => panic!("unknown control"),
    }
}
