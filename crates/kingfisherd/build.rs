fn main() {
    // rust-embed refuses to compile against a missing folder; an empty one just serves a 404 hint.
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    std::fs::create_dir_all(&dist).expect("creating web/dist");
    println!("cargo:rerun-if-changed=../../web/dist");
}
