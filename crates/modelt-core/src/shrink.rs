use crate::{CoreError, Value};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeletionRange {
    pub start: u32,
    pub count: u32,
}
pub fn deletion_candidates(length: u32) -> Vec<DeletionRange> {
    let mut result = vec![];
    let mut seen = BTreeSet::new();
    let mut size = length;
    while size >= 1 {
        let mut start = 0;
        while start < length {
            let count = size.min(length - start);
            if seen.insert((start, count)) {
                result.push(DeletionRange { start, count });
            }
            match start.checked_add(size) {
                Some(next) => start = next,
                None => break,
            }
        }
        size = if size == 1 { 0 } else { size.div_ceil(2) };
    }
    result
}

pub enum ShrinkVerdict {
    Matched,
    Invalid,
    Mismatch(String),
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShrinkStatus {
    Minimal,
    Bounded,
    NotFailing,
}
#[derive(Debug, Serialize)]
pub struct ShrinkResult {
    pub status: ShrinkStatus,
    pub actions: Vec<Value>,
    pub checks: usize,
}
pub fn shrink_counterexample(
    mut actions: Vec<Value>,
    mut evaluate: impl FnMut(&[Value]) -> Result<ShrinkVerdict, CoreError>,
    max_checks: usize,
) -> Result<ShrinkResult, CoreError> {
    if max_checks < 2 || actions.len() > u32::MAX as usize {
        return Err(CoreError::protocol("Invalid shrinking budget"));
    }
    let ShrinkVerdict::Mismatch(signature) = evaluate(&actions)? else {
        return Ok(ShrinkResult {
            status: ShrinkStatus::NotFailing,
            actions,
            checks: 1,
        });
    };
    if signature.is_empty() {
        return Err(CoreError::protocol("Missing failure signature"));
    }
    let mut checks = 1;
    let mut minimal = false;
    while !minimal && checks + 1 < max_checks {
        let mut reduced = false;
        let mut exhausted = true;
        for range in deletion_candidates(actions.len() as u32) {
            if checks + 1 >= max_checks {
                exhausted = false;
                break;
            }
            let candidate: Vec<_> = actions
                .iter()
                .enumerate()
                .filter(|(index, _)| {
                    *index < range.start as usize || *index >= (range.start + range.count) as usize
                })
                .map(|(_, value)| value.clone())
                .collect();
            let verdict = evaluate(&candidate)?;
            checks += 1;
            if matches!(verdict, ShrinkVerdict::Mismatch(current) if current == signature) {
                actions = candidate;
                reduced = true;
                break;
            }
        }
        minimal = !reduced && exhausted;
    }
    if actions.is_empty() {
        minimal = true;
    }
    let confirmation = evaluate(&actions)?;
    checks += 1;
    if !matches!(confirmation, ShrinkVerdict::Mismatch(current) if current == signature) {
        return Err(CoreError::protocol(
            "Shrunk counterexample did not reproduce",
        ));
    }
    Ok(ShrinkResult {
        status: if minimal {
            ShrinkStatus::Minimal
        } else {
            ShrinkStatus::Bounded
        },
        actions,
        checks,
    })
}
