//! Evaluation SUT: this module does not read model tables or expected observations.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fault {
    None,
    Persistence,
    Deduplication,
    LateRetry,
    FifoOnly,
    DropIgnored,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Add { id: String, amount: i64 },
    Send { id: String, amount: i64 },
    Deliver { index: usize },
    Drop { index: usize },
    Crash,
    Restart,
}

pub struct Observation {
    pub running: bool,
    pub value: i64,
}
struct Request {
    id: String,
    amount: i64,
}

pub struct Counter {
    fault: Fault,
    running: bool,
    value: i64,
    durable_value: i64,
    seen: BTreeSet<String>,
    durable_seen: BTreeSet<String>,
    pending: Vec<Request>,
    attempts: BTreeMap<String, u32>,
}

impl Counter {
    pub fn new(fault: Fault) -> Self {
        Self {
            fault,
            running: true,
            value: 0,
            durable_value: 0,
            seen: BTreeSet::new(),
            durable_seen: BTreeSet::new(),
            pending: vec![],
            attempts: BTreeMap::new(),
        }
    }
    fn observe(&self) -> Observation {
        Observation {
            running: self.running,
            value: if self.running { self.value } else { 0 },
        }
    }
    pub fn reset(&mut self) -> Observation {
        *self = Self::new(self.fault);
        self.observe()
    }
    fn apply(&mut self, request: Request) {
        if !self.running || self.fault != Fault::Deduplication && self.seen.contains(&request.id) {
            return;
        }
        self.value += request.amount;
        self.seen.insert(request.id);
        if self.fault != Fault::Persistence {
            self.durable_value = self.value;
            self.durable_seen = self.seen.clone();
        }
    }
    pub fn step(&mut self, action: Action) -> Observation {
        match action {
            Action::Add { mut id, amount } => {
                let attempts = self.attempts.entry(id.clone()).or_default();
                *attempts += 1;
                if self.fault == Fault::LateRetry && *attempts == 3 {
                    id.push_str(":third-attempt");
                }
                self.apply(Request { id, amount });
            }
            Action::Send { id, amount } => self.pending.push(Request { id, amount }),
            Action::Deliver { index } => {
                let index = if self.fault == Fault::FifoOnly {
                    0
                } else {
                    index
                };
                if index < self.pending.len() {
                    let request = self.pending.remove(index);
                    self.apply(request);
                }
            }
            Action::Drop { index } => {
                if self.fault != Fault::DropIgnored && index < self.pending.len() {
                    self.pending.remove(index);
                }
            }
            Action::Crash => {
                self.running = false;
                self.value = 0;
                self.seen.clear();
            }
            Action::Restart => {
                if !self.running {
                    self.running = true;
                    self.value = self.durable_value;
                    self.seen = self.durable_seen.clone();
                }
            }
        }
        self.observe()
    }
}
