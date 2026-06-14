// Tool-smoke fixture for #209 — rust-analyzer flags the type mismatch
// (assigning a string literal to an i32).
fn main() {
    let _x: i32 = "not a number";
}
