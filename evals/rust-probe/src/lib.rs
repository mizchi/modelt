use std::cell::RefCell;

#[derive(Default)]
pub struct Table {
    pub offsets: Vec<u32>,
    pub actions: Vec<u32>,
    pub targets: Vec<u32>,
}

impl Table {
    pub fn validate(&self) -> bool {
        self.offsets.len() >= 2
            && self.offsets[0] == 0
            && self.offsets.last().copied() == Some(self.actions.len() as u32)
            && self.actions.len() == self.targets.len()
            && self.offsets.windows(2).all(|pair| pair[0] < pair[1])
            && self
                .targets
                .iter()
                .all(|target| (*target as usize) < self.offsets.len() - 1)
    }
}

#[derive(Default, Debug, PartialEq)]
pub struct Run {
    pub cases: u32,
    pub operations: u32,
    pub steps: u32,
    pub checksum: u32,
    pub trace: Vec<u32>,
}

pub fn run(
    table: &Table,
    seed: u32,
    operations: u32,
    depth: u32,
    strategy: u32,
    repeats: u32,
    trace: bool,
) -> Option<Run> {
    if !table.validate()
        || operations < 2
        || depth == 0
        || strategy > 1
        || repeats == 0
        || operations.checked_mul(repeats).is_none()
    {
        return None;
    }
    let mut result = Run {
        checksum: 2_166_136_261,
        ..Run::default()
    };
    for repeat in 0..repeats {
        let mut random = seed.wrapping_add(repeat);
        if random == 0 {
            random = 0x9e37_79b9;
        }
        let mut used = 0;
        let mut cases = 0;
        while operations - used >= 2 {
            let limit = if strategy == 1 && cases % 2 == 0 {
                (depth / 2).max(1)
            } else {
                depth
            };
            let length = limit.min(operations - used - 1);
            if trace {
                result.trace.push(length);
            }
            result.checksum = result.checksum.wrapping_mul(16_777_619) ^ 0xffff_fffe;
            let mut state = 0_usize;
            for _ in 0..length {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                let start = table.offsets[state] as usize;
                let count = table.offsets[state + 1] as usize - start;
                let edge =
                    start + (((random as f64) / 4_294_967_296.0) * (count as f64)).floor() as usize;
                let action = table.actions[edge];
                let target = table.targets[edge];
                result.checksum = (result.checksum.wrapping_mul(16_777_619) ^ action)
                    .wrapping_mul(16_777_619)
                    ^ target;
                if trace {
                    result.trace.push(action);
                }
                state = target as usize;
                result.steps += 1;
            }
            used += length + 1;
            cases += 1;
        }
        result.cases += cases;
        result.operations += used;
    }
    Some(result)
}

#[derive(Default)]
struct Instance {
    table: Table,
    result: Run,
}

thread_local! { static INSTANCE: RefCell<Instance> = RefCell::new(Instance::default()); }

// SAFETY: modelt_probe_* names are reserved by this standalone probe ABI.
#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_begin(states: u32, edges: u32) -> u32 {
    INSTANCE.with_borrow_mut(|instance| {
        instance.table = Table {
            offsets: vec![0; states as usize + 1],
            actions: vec![0; edges as usize],
            targets: vec![0; edges as usize],
        };
        instance.result = Run::default();
    });
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_offset(index: u32, value: u32) -> u32 {
    INSTANCE.with_borrow_mut(
        |instance| match instance.table.offsets.get_mut(index as usize) {
            Some(slot) => {
                *slot = value;
                1
            }
            None => 0,
        },
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_edge(index: u32, action: u32, target: u32) -> u32 {
    INSTANCE.with_borrow_mut(|instance| {
        if index as usize >= instance.table.actions.len() {
            return 0;
        }
        instance.table.actions[index as usize] = action;
        instance.table.targets[index as usize] = target;
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_run(
    seed: u32,
    operations: u32,
    depth: u32,
    strategy: u32,
    repeats: u32,
    trace: u32,
) -> u32 {
    INSTANCE.with_borrow_mut(|instance| {
        match run(
            &instance.table,
            seed,
            operations,
            depth,
            strategy,
            repeats,
            trace != 0,
        ) {
            Some(result) => {
                instance.result = result;
                1
            }
            None => {
                instance.result = Run::default();
                0
            }
        }
    })
}

macro_rules! export_result {
    ($name:ident, $field:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> u32 {
            INSTANCE.with_borrow(|instance| instance.result.$field)
        }
    };
}
export_result!(modelt_probe_cases, cases);
export_result!(modelt_probe_operations, operations);
export_result!(modelt_probe_steps, steps);
export_result!(modelt_probe_checksum, checksum);

#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_trace_len() -> u32 {
    INSTANCE.with_borrow(|instance| instance.result.trace.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn modelt_probe_trace_ptr() -> *const u32 {
    INSTANCE.with_borrow(|instance| instance.result.trace.as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_state_model_is_reproducible_and_preserves_trace_budget() {
        let table = Table {
            offsets: vec![0, 1],
            actions: vec![4],
            targets: vec![0],
        };
        let result = run(&table, 61, 17, 8, 0, 1, true).expect("valid model");
        assert_eq!(result.operations, 17);
        assert_eq!(result.trace.len(), 17);
        assert_eq!(
            result,
            run(&table, 61, 17, 8, 0, 1, true).expect("valid model")
        );
    }

    #[test]
    fn invalid_tables_and_budgets_are_rejected() {
        assert!(run(&Table::default(), 1, 100, 8, 0, 1, false).is_none());
        let table = Table {
            offsets: vec![0, 1],
            actions: vec![0],
            targets: vec![0],
        };
        assert!(run(&table, 1, 0, 8, 0, 1, false).is_none());
        assert!(run(&table, 1, u32::MAX, 8, 0, 2, false).is_none());
    }
}
