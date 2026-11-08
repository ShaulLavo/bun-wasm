#[path = "../src/glue/special_case.rs"]
mod special_case;

fn main() {
    let sets = special_case::compute();
    let ignore: Vec<_> = sets.ignore.into_iter().collect();
    let supplementary: Vec<_> = sets.supplementary.into_iter().collect();
    println!("{{\"ignore\":{ignore:?},\"supplementary\":{supplementary:?}}}");
}
