use modelt_runtime_probe::{Table, run};
use std::{env, fs, time::Instant};

fn execute() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 7 {
        return Err("usage: probe table seed operations depth strategy repeats".into());
    }
    let bytes = fs::read(&args[1]).map_err(|error| error.to_string())?;
    if bytes.len() % 4 != 0 {
        return Err("invalid table bytes".into());
    }
    let words: Vec<u32> = bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    if words.len() < 2 {
        return Err("missing table header".into());
    }
    let states = words[0] as usize;
    let edges = words[1] as usize;
    if words.len() != 3 + states + 2 * edges {
        return Err("invalid table length".into());
    }
    let table = Table {
        offsets: words[2..3 + states].to_vec(),
        actions: words[3 + states..3 + states + edges].to_vec(),
        targets: words[3 + states + edges..].to_vec(),
    };
    let numbers: Result<Vec<u32>, _> = args[2..].iter().map(|value| value.parse::<u32>()).collect();
    let numbers = numbers.map_err(|error| error.to_string())?;
    let start = Instant::now();
    let result = run(
        &table, numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], false,
    )
    .ok_or("invalid model or options")?;
    println!(
        "{},{},{},{},{}",
        result.cases,
        result.operations,
        result.steps,
        result.checksum,
        start.elapsed().as_nanos()
    );
    Ok(())
}

fn main() {
    if let Err(error) = execute() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
