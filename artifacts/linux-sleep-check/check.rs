#[macro_export]
macro_rules! logln { ($($arg:tt)*) => { eprintln!($($arg)*) } }
#[path = "../../src/linux/sleep.rs"]
mod sleep;
fn main() { let _ = sleep::start(|| {}); }
