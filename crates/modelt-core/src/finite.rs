use crate::{
    ConformanceResult, CoreError, Effect, Response, Session, State, Trace, Transition, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Initial {
    pub key: String,
    pub observation: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub action: Value,
    pub target: String,
    pub observation: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FiniteState {
    pub key: String,
    pub violations: Vec<String>,
    pub transitions: Vec<Edge>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FiniteModel {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub initial: Vec<Initial>,
    pub states: Vec<FiniteState>,
}

impl FiniteModel {
    pub fn normalize(self) -> Result<Self, CoreError> {
        if self.format != "modelt.finite-model" || self.version != 1 {
            return Err(CoreError::protocol("Unsupported finite model"));
        }
        let keys: BTreeSet<_> = self.states.iter().map(|state| state.key.as_str()).collect();
        if keys.len() != self.states.len()
            || self
                .initial
                .iter()
                .any(|entry| !keys.contains(entry.key.as_str()))
            || self.states.iter().any(|state| {
                state
                    .transitions
                    .iter()
                    .any(|edge| !keys.contains(edge.target.as_str()))
            })
        {
            return Err(CoreError::protocol("Duplicate state or missing target"));
        }
        Ok(Self {
            initial: self
                .initial
                .into_iter()
                .map(|entry| {
                    Ok(Initial {
                        observation: entry.observation.normalize()?,
                        ..entry
                    })
                })
                .collect::<Result<_, CoreError>>()?,
            states: self
                .states
                .into_iter()
                .map(|state| {
                    Ok(FiniteState {
                        transitions: state
                            .transitions
                            .into_iter()
                            .map(|edge| {
                                Ok(Edge {
                                    action: edge.action.normalize()?,
                                    observation: edge.observation.normalize()?,
                                    ..edge
                                })
                            })
                            .collect::<Result<_, CoreError>>()?,
                        ..state
                    })
                })
                .collect::<Result<_, CoreError>>()?,
            ..self
        })
    }
    pub fn response(&self, effect: &Effect) -> Result<Option<Response>, CoreError> {
        match effect {
            Effect::ModelInitial { .. } => Ok(Some(Response::Transitions {
                transitions: self
                    .initial
                    .iter()
                    .map(|entry| Transition {
                        key: entry.key.clone(),
                        state: Value::String(entry.key.clone()),
                        observation: entry.observation.clone(),
                    })
                    .collect(),
            })),
            Effect::ModelStep { states, action, .. } => Ok(Some(Response::Transitions {
                transitions: self.successors(states, action)?,
            })),
            _ => Ok(None),
        }
    }
    fn successors(&self, states: &[State], action: &Value) -> Result<Vec<Transition>, CoreError> {
        let mut transitions = vec![];
        for entry in states {
            let state = self
                .states
                .iter()
                .find(|state| state.key == entry.key)
                .ok_or_else(|| CoreError::protocol("Unknown finite state"))?;
            for edge in state
                .transitions
                .iter()
                .filter(|edge| edge.action == *action)
            {
                transitions.push(Transition {
                    key: edge.target.clone(),
                    state: Value::String(edge.target.clone()),
                    observation: edge.observation.clone(),
                });
            }
        }
        Ok(transitions)
    }
    pub fn check_history(&self, trace: Trace) -> Result<ConformanceResult, CoreError> {
        let trace = trace.normalize()?;
        if trace.model != self.name {
            return Err(CoreError::protocol("Finite history model differs"));
        }
        let mut session = Session::new(
            self.name.clone(),
            trace.steps.iter().map(|step| step.action.clone()).collect(),
        )?;
        let mut position = 0;
        loop {
            let effect = session.effect();
            if let Some(response) = self.response(&effect)? {
                let id = match effect {
                    Effect::ModelInitial { id } | Effect::ModelStep { id, .. } => id,
                    _ => unreachable!(),
                };
                session.resume(id, response)?;
                continue;
            }
            match effect {
                Effect::Done { result } => return Ok(result),
                Effect::DriverReset { id } => {
                    session.resume(
                        id,
                        Response::Observation {
                            observation: trace.initial.clone(),
                        },
                    )?;
                }
                Effect::DriverStep { id, .. } => {
                    let observation = trace
                        .steps
                        .get(position)
                        .ok_or_else(|| CoreError::protocol("Missing finite history step"))?
                        .observation
                        .clone();
                    position += 1;
                    session.resume(id, Response::Observation { observation })?;
                }
                _ => unreachable!(),
            }
        }
    }
}
