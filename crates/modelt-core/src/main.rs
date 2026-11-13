use modelt_core::Engine;
use std::io::{self, BufRead};

fn main() -> io::Result<()> {
    let mut engine = Engine::default();
    for line in io::stdin().lock().lines() {
        println!(
            "{}",
            serde_json::to_string(&engine.dispatch(line?.as_bytes()))?
        );
    }
    Ok(())
}
