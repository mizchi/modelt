mod finite;
mod host;
pub use host::{HostEvent, HostMessage, HostTape, SimulationHost, replay_host};
mod shrink;
mod value;
pub use finite::{Edge, FiniteModel, FiniteState, Initial};
pub use shrink::{
    DeletionRange, ShrinkResult, ShrinkStatus, ShrinkVerdict, deletion_candidates,
    shrink_counterexample,
};
#[cfg(target_arch = "wasm32")]
mod wasm;
use serde::{Deserialize, Serialize};
pub use value::{CoreError, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transition {
    pub key: String,
    pub state: Value,
    pub observation: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub key: String,
    pub state: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub action: Value,
    pub observation: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trace {
    pub format: String,
    pub version: u32,
    pub model: String,
    pub initial: Value,
    pub steps: Vec<Step>,
}
impl Trace {
    pub fn normalize(self) -> Result<Self, CoreError> {
        if self.version != 1 || self.format != "modelt.portable-trace" {
            return Err(CoreError::protocol("Unsupported trace format"));
        }
        Ok(Self {
            initial: self.initial.normalize()?,
            steps: self
                .steps
                .into_iter()
                .map(|step| {
                    Ok(Step {
                        action: step.action.normalize()?,
                        observation: step.observation.normalize()?,
                    })
                })
                .collect::<Result<_, CoreError>>()?,
            ..self
        })
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Matched,
    Mismatch,
    Invalid,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConformanceResult {
    pub status: Status,
    pub checked_steps: usize,
    pub actual: Value,
    pub expected: Vec<Value>,
    pub trace: Trace,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Effect {
    ModelInitial {
        id: u32,
    },
    DriverReset {
        id: u32,
    },
    ModelStep {
        id: u32,
        states: Vec<State>,
        action: Value,
    },
    DriverStep {
        id: u32,
        action: Value,
    },
    Done {
        result: ConformanceResult,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Response {
    Transitions { transitions: Vec<Transition> },
    Observation { observation: Value },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    ReplayHost {
        tape: HostTape,
    },
    StartFinite {
        model: FiniteModel,
        actions: Vec<Value>,
    },
    CheckFinite {
        model: FiniteModel,
        traces: Vec<Trace>,
    },
    ShrinkCandidates {
        length: u32,
    },
    Canonicalize {
        value: Value,
    },
    Start {
        model: String,
        actions: Vec<Value>,
    },
    Replay {
        trace: Trace,
    },
    Resume {
        id: u32,
        response: Response,
    },
    Cancel {
        id: u32,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub version: u32,
    pub request: Request,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Message {
    Host { snapshot: Value },
    Results { results: Vec<ConformanceResult> },
    Candidates { ranges: Vec<DeletionRange> },
    Value { value: Value },
    Effect { effect: Effect },
    Cancelled,
    Error { code: String, message: String },
}

#[derive(Clone)]
enum Phase {
    Initial,
    Reset(Vec<Transition>),
    Model,
    Driver(Vec<Transition>),
    Done(ConformanceResult),
}

/// A host drives effects and owns I/O, async execution, and cleanup.
pub struct Session {
    id: u32,
    actions: Vec<Value>,
    oracle: Option<Trace>,
    phase: Phase,
    candidates: Vec<Transition>,
    trace: Trace,
}
impl Session {
    pub fn new(model: String, actions: Vec<Value>) -> Result<Self, CoreError> {
        Ok(Self {
            id: 1,
            actions: actions
                .into_iter()
                .map(Value::normalize)
                .collect::<Result<_, _>>()?,
            oracle: None,
            phase: Phase::Initial,
            candidates: vec![],
            trace: Trace {
                format: "modelt.portable-trace".into(),
                version: 1,
                model,
                initial: Value::Null,
                steps: vec![],
            },
        })
    }
    pub fn replay(trace: Trace) -> Result<Self, CoreError> {
        let trace = trace.normalize()?;
        let mut session = Self::new(
            trace.model.clone(),
            trace.steps.iter().map(|step| step.action.clone()).collect(),
        )?;
        session.phase = Phase::Reset(vec![Transition {
            key: String::new(),
            state: Value::Null,
            observation: trace.initial.clone(),
        }]);
        session.oracle = Some(trace);
        Ok(session)
    }
    pub fn effect(&self) -> Effect {
        match &self.phase {
            Phase::Initial => Effect::ModelInitial { id: self.id },
            Phase::Reset(_) => Effect::DriverReset { id: self.id },
            Phase::Model => Effect::ModelStep {
                id: self.id,
                states: self
                    .candidates
                    .iter()
                    .map(|entry| State {
                        key: entry.key.clone(),
                        state: entry.state.clone(),
                    })
                    .collect(),
                action: self.actions[self.trace.steps.len()].clone(),
            },
            Phase::Driver(_) => Effect::DriverStep {
                id: self.id,
                action: self.actions[self.trace.steps.len()].clone(),
            },
            Phase::Done(result) => Effect::Done {
                result: result.clone(),
            },
        }
    }
    pub fn resume(&mut self, id: u32, response: Response) -> Result<Effect, CoreError> {
        if id != self.id || matches!(self.phase, Phase::Done(_)) {
            return Err(CoreError::protocol("Stale or unexpected reply"));
        }
        let response = match (&self.phase, response) {
            (Phase::Initial | Phase::Model, Response::Transitions { transitions }) => {
                Response::Transitions {
                    transitions: transitions
                        .into_iter()
                        .map(|entry| {
                            Ok(Transition {
                                state: entry.state.normalize()?,
                                observation: entry.observation.normalize()?,
                                ..entry
                            })
                        })
                        .collect::<Result<_, CoreError>>()?,
                }
            }
            (Phase::Reset(_) | Phase::Driver(_), Response::Observation { observation }) => {
                Response::Observation {
                    observation: observation.normalize()?,
                }
            }
            _ => {
                return Err(CoreError::protocol(
                    "Reply kind does not match the pending effect",
                ));
            }
        };
        self.id = self
            .id
            .checked_add(1)
            .ok_or_else(|| CoreError::protocol("Request ID exhausted"))?;
        match (self.phase.clone(), response) {
            (Phase::Initial, Response::Transitions { transitions }) => {
                self.phase = Phase::Reset(transitions)
            }
            (Phase::Model, Response::Transitions { transitions }) => {
                if transitions.is_empty() {
                    self.finish(Status::Invalid, vec![]);
                } else {
                    self.phase = Phase::Driver(transitions);
                }
            }
            (Phase::Reset(transitions), Response::Observation { observation }) => {
                self.trace.initial = observation.clone();
                self.accept(transitions, observation);
            }
            (Phase::Driver(transitions), Response::Observation { observation }) => {
                self.trace.steps.push(Step {
                    action: self.actions[self.trace.steps.len()].clone(),
                    observation: observation.clone(),
                });
                self.accept(transitions, observation);
            }
            _ => unreachable!(),
        }
        Ok(self.effect())
    }
    fn accept(&mut self, transitions: Vec<Transition>, actual: Value) {
        self.candidates.clear();
        for entry in transitions
            .iter()
            .filter(|entry| entry.observation == actual)
        {
            if let Some(previous) = self
                .candidates
                .iter_mut()
                .find(|previous| previous.key == entry.key)
            {
                *previous = entry.clone();
            } else {
                self.candidates.push(entry.clone());
            }
        }
        if self.candidates.is_empty() {
            self.finish(
                if transitions.is_empty() {
                    Status::Invalid
                } else {
                    Status::Mismatch
                },
                transitions
                    .iter()
                    .map(|entry| entry.observation.clone())
                    .collect(),
            );
        } else if self.trace.steps.len() == self.actions.len() {
            self.finish(Status::Matched, vec![actual]);
        } else if let Some(oracle) = &self.oracle {
            self.phase = Phase::Driver(vec![Transition {
                key: String::new(),
                state: Value::Null,
                observation: oracle.steps[self.trace.steps.len()].observation.clone(),
            }]);
        } else {
            self.phase = Phase::Model;
        }
    }
    fn finish(&mut self, status: Status, expected: Vec<Value>) {
        let actual = self.trace.steps.last().map_or_else(
            || self.trace.initial.clone(),
            |step| step.observation.clone(),
        );
        self.phase = Phase::Done(ConformanceResult {
            status,
            checked_steps: self.trace.steps.len(),
            actual,
            expected,
            trace: self.trace.clone(),
        });
    }
}

pub struct Engine {
    session: Option<Session>,
    finite: Option<FiniteModel>,
    next_id: u32,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            session: None,
            finite: None,
            next_id: 1,
        }
    }
}
impl Engine {
    pub fn dispatch(&mut self, bytes: &[u8]) -> Message {
        match serde_json::from_slice(bytes) {
            Ok(command) => self.handle(command),
            Err(error) => Message::Error {
                code: "protocol".into(),
                message: error.to_string(),
            },
        }
    }
    pub fn handle(&mut self, command: Command) -> Message {
        match self.execute(command) {
            Ok(message) => message,
            Err(error) => Message::Error {
                code: error.code.into(),
                message: error.message,
            },
        }
    }
    fn execute(&mut self, command: Command) -> Result<Message, CoreError> {
        if command.version != 1 {
            return Err(CoreError::protocol("Unsupported protocol version"));
        }
        match command.request {
            Request::ReplayHost { tape } => Ok(Message::Host {
                snapshot: replay_host(tape)?,
            }),
            Request::Canonicalize { value } => Ok(Message::Value {
                value: value.normalize()?,
            }),
            Request::Start { model, actions } => self.begin(Session::new(model, actions)?, None),
            Request::Replay { trace } => self.begin(Session::replay(trace)?, None),
            Request::StartFinite { model, actions } => {
                let model = model.normalize()?;
                self.begin(Session::new(model.name.clone(), actions)?, Some(model))
            }
            Request::CheckFinite { model, traces } => {
                let model = model.normalize()?;
                Ok(Message::Results {
                    results: traces
                        .into_iter()
                        .map(|trace| model.check_history(trace))
                        .collect::<Result<_, _>>()?,
                })
            }
            Request::ShrinkCandidates { length } => Ok(Message::Candidates {
                ranges: deletion_candidates(length),
            }),
            Request::Resume { id, response } => {
                let session = self
                    .session
                    .as_mut()
                    .ok_or_else(|| CoreError::protocol("No active session"))?;
                let effect = session.resume(id, response)?;
                self.next_id = session.id;
                self.drive(effect)
            }
            Request::Cancel { id } => {
                let session = self
                    .session
                    .as_ref()
                    .ok_or_else(|| CoreError::protocol("No active session"))?;
                if id != session.id || matches!(session.phase, Phase::Done(_)) {
                    return Err(CoreError::protocol("Stale cancellation"));
                }
                self.next_id = id
                    .checked_add(1)
                    .ok_or_else(|| CoreError::protocol("Request ID exhausted"))?;
                self.session = None;
                self.finite = None;
                Ok(Message::Cancelled)
            }
        }
    }
    fn begin(
        &mut self,
        mut session: Session,
        finite: Option<FiniteModel>,
    ) -> Result<Message, CoreError> {
        if self
            .session
            .as_ref()
            .is_some_and(|current| !matches!(current.phase, Phase::Done(_)))
        {
            return Err(CoreError::protocol("Session already active"));
        }
        session.id = self.next_id;
        let effect = session.effect();
        self.session = Some(session);
        self.finite = finite;
        self.drive(effect)
    }
    fn drive(&mut self, mut effect: Effect) -> Result<Message, CoreError> {
        while let Some(response) = self
            .finite
            .as_ref()
            .map(|model| model.response(&effect))
            .transpose()?
            .flatten()
        {
            let id = match effect {
                Effect::ModelInitial { id } | Effect::ModelStep { id, .. } => id,
                _ => unreachable!(),
            };
            let session = self
                .session
                .as_mut()
                .ok_or_else(|| CoreError::protocol("No finite session"))?;
            effect = session.resume(id, response)?;
            self.next_id = session.id;
        }
        Ok(Message::Effect { effect })
    }
}
