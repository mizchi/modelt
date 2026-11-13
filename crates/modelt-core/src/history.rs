use crate::{CoreError, PreparedFiniteModel, Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HistoryEvent {
    Invoke { id: String, action: Value },
    Return { id: String, observation: Value },
    Fail { id: String },
    Unknown { id: String },
    Cancel { id: String },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConcurrentHistory {
    pub format: String,
    pub version: u32,
    pub model: String,
    pub initial: Value,
    pub events: Vec<HistoryEvent>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ConcurrentStatus {
    Linearizable,
    NotLinearizable,
    Inconclusive,
    Empty,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConcurrentResult {
    pub status: ConcurrentStatus,
    pub explored: u32,
    pub order: Vec<String>,
    pub omitted: Vec<String>,
    pub pending: Vec<String>,
}
struct Operation {
    id: String,
    call: usize,
    action: Value,
    returned: Option<usize>,
    observation: Option<Value>,
    ended: bool,
    uncertain: bool,
    failed: bool,
}
struct Frame {
    state: String,
    remaining: Vec<usize>,
    order: Vec<String>,
}

impl PreparedFiniteModel {
    pub fn check_concurrent(
        &self,
        history: ConcurrentHistory,
        max_nodes: u32,
    ) -> Result<ConcurrentResult, CoreError> {
        if max_nodes == 0
            || history.format != "modelt.concurrent-history"
            || history.version != 1
            || history.model.is_empty()
            || history.model != self.name()
        {
            return Err(CoreError::protocol(
                "Invalid concurrent history or node budget",
            ));
        }
        if self.model.initial.is_empty() {
            return Err(CoreError::protocol(
                "Concurrent model has no initial states",
            ));
        }
        let initial = history.initial.normalize()?;
        let mut entries: Vec<Operation> = vec![];
        let mut ids = BTreeMap::new();
        let empty = history.events.is_empty();
        for (index, event) in history.events.into_iter().enumerate() {
            let id = match &event {
                HistoryEvent::Invoke { id, .. }
                | HistoryEvent::Return { id, .. }
                | HistoryEvent::Fail { id }
                | HistoryEvent::Unknown { id }
                | HistoryEvent::Cancel { id } => id,
            };
            if id.is_empty() {
                return Err(CoreError::protocol("Invalid history id"));
            }
            if let HistoryEvent::Invoke { id, action } = event {
                if ids.contains_key(&id) {
                    return Err(CoreError::protocol("Duplicate history id"));
                }
                ids.insert(id.clone(), entries.len());
                entries.push(Operation {
                    id,
                    call: index,
                    action: action.normalize()?,
                    returned: None,
                    observation: None,
                    ended: false,
                    uncertain: false,
                    failed: false,
                });
                continue;
            }
            let entry = entries
                .get_mut(
                    *ids.get(id)
                        .ok_or_else(|| CoreError::protocol("Missing history id"))?,
                )
                .expect("known index");
            let terminal = matches!(
                event,
                HistoryEvent::Return { .. } | HistoryEvent::Fail { .. }
            );
            if entry.ended || (entry.uncertain && !terminal) {
                return Err(CoreError::protocol("Already completed history id"));
            }
            entry.ended = terminal;
            entry.uncertain = !terminal;
            match event {
                HistoryEvent::Return { observation, .. } => {
                    entry.returned = Some(index);
                    entry.observation = Some(observation.normalize()?);
                }
                HistoryEvent::Fail { .. } => entry.failed = true,
                _ => {}
            }
        }
        let entries: Vec<_> = entries.into_iter().filter(|entry| !entry.failed).collect();
        let pending: Vec<_> = entries
            .iter()
            .filter(|entry| entry.returned.is_none())
            .map(|entry| entry.id.clone())
            .collect();
        let result = |status, explored| ConcurrentResult {
            status,
            explored,
            order: vec![],
            omitted: vec![],
            pending: pending.clone(),
        };
        if empty {
            return Ok(result(ConcurrentStatus::Empty, 0));
        }
        let mut stack: Vec<_> = self
            .model
            .initial
            .iter()
            .filter(|entry| entry.observation == initial)
            .rev()
            .map(|entry| Frame {
                state: entry.key.clone(),
                remaining: (0..entries.len()).collect(),
                order: vec![],
            })
            .collect();
        let mut visited = BTreeSet::new();
        let mut explored = 0;
        while let Some(frame) = stack.pop() {
            if frame
                .remaining
                .iter()
                .all(|index| entries[*index].returned.is_none())
            {
                return Ok(ConcurrentResult {
                    status: ConcurrentStatus::Linearizable,
                    explored,
                    order: frame.order,
                    omitted: frame
                        .remaining
                        .iter()
                        .map(|index| entries[*index].id.clone())
                        .collect(),
                    pending,
                });
            }
            if visited.contains(&(frame.state.clone(), frame.remaining.clone())) {
                continue;
            }
            if explored == max_nodes {
                return Ok(result(ConcurrentStatus::Inconclusive, explored));
            }
            visited.insert((frame.state.clone(), frame.remaining.clone()));
            explored += 1;
            let mut children = vec![];
            for index in &frame.remaining {
                let operation = &entries[*index];
                if frame.remaining.iter().any(|other| {
                    entries[*other]
                        .returned
                        .is_some_and(|returned| returned < operation.call)
                }) {
                    continue;
                }
                for edge in self.successors(&frame.state, &operation.action)? {
                    if operation
                        .observation
                        .as_ref()
                        .is_some_and(|expected| *expected != edge.observation)
                    {
                        continue;
                    }
                    let mut order = frame.order.clone();
                    order.push(operation.id.clone());
                    children.push(Frame {
                        state: edge.key.clone(),
                        remaining: frame
                            .remaining
                            .iter()
                            .copied()
                            .filter(|other| other != index)
                            .collect(),
                        order,
                    });
                }
            }
            stack.extend(children.into_iter().rev());
        }
        Ok(result(ConcurrentStatus::NotLinearizable, explored))
    }
}
