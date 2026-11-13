use crate::{CoreError, Value};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostEvent {
    pub operation: String,
    pub input: Value,
    pub output: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostTape {
    pub format: String,
    pub version: u32,
    pub events: Vec<HostEvent>,
}
#[derive(Clone, Debug)]
pub struct HostMessage {
    pub id: u32,
    pub from: String,
    pub to: String,
    pub payload: Value,
}
fn record(fields: Vec<(&str, Value)>) -> Value {
    Value::Record(
        fields
            .into_iter()
            .map(|(name, value)| (name.into(), value))
            .collect(),
    )
    .normalize()
    .expect("valid host record")
}
fn integer(value: u64) -> Value {
    Value::Int(value.to_string())
}
impl HostMessage {
    fn value(&self) -> Value {
        record(vec![
            ("id", integer(u64::from(self.id))),
            ("from", Value::String(self.from.clone())),
            ("to", Value::String(self.to.clone())),
            ("payload", self.payload.clone()),
        ])
    }
}
pub struct SimulationHost {
    random: u32,
    clock: u64,
    running: bool,
    closed: bool,
    failed: bool,
    next_id: u32,
    volatile: BTreeMap<String, Value>,
    durable: BTreeMap<String, Value>,
    messages: Vec<HostMessage>,
    events: Vec<HostEvent>,
    source: Option<Vec<HostEvent>>,
    cursor: usize,
}
impl SimulationHost {
    pub fn new(seed: u32) -> Result<Self, CoreError> {
        if seed == 0 {
            return Err(CoreError::protocol("Invalid simulation seed"));
        }
        Ok(Self {
            random: seed,
            clock: 0,
            running: true,
            closed: false,
            failed: false,
            next_id: 1,
            volatile: BTreeMap::new(),
            durable: BTreeMap::new(),
            messages: vec![],
            events: vec![],
            source: None,
            cursor: 0,
        })
    }
    pub fn replay(tape: HostTape) -> Result<Self, CoreError> {
        if tape.format != "modelt.host-tape" || tape.version != 1 {
            return Err(CoreError::protocol("Unsupported host tape"));
        }
        let mut host = Self::new(1)?;
        host.source = Some(
            tape.events
                .into_iter()
                .map(|event| {
                    Ok(HostEvent {
                        input: event.input.normalize()?,
                        output: event.output.normalize()?,
                        ..event
                    })
                })
                .collect::<Result<_, CoreError>>()?,
        );
        Ok(host)
    }
    fn event(&mut self, operation: &str, input: Value, output: Value) -> Result<(), CoreError> {
        if self.closed || self.failed {
            return Err(CoreError::protocol("Host tape is closed or divergent"));
        }
        let input = input.normalize()?;
        let output = output.normalize()?;
        if self.source.as_ref().is_some_and(|source| {
            !source.get(self.cursor).is_some_and(|event| {
                event.operation == operation && event.input == input && event.output == output
            })
        }) {
            self.failed = true;
            return Err(CoreError::protocol("Host replay differs"));
        }
        self.events.push(HostEvent {
            operation: operation.into(),
            input,
            output,
        });
        self.cursor += 1;
        Ok(())
    }
    fn require_running(&self) -> Result<(), CoreError> {
        if !self.running || self.closed || self.failed {
            Err(CoreError::protocol("Host is stopped"))
        } else {
            Ok(())
        }
    }
    pub fn now(&self) -> u64 {
        self.clock
    }
    pub fn advance(&mut self, amount: u64) -> Result<(), CoreError> {
        let next = self
            .clock
            .checked_add(amount)
            .filter(|next| *next <= 9_007_199_254_740_991)
            .ok_or_else(|| CoreError::protocol("Clock overflow"))?;
        self.event("advance", integer(amount), integer(next))?;
        self.clock = next;
        Ok(())
    }
    pub fn choose(&mut self, label: &str, choices: &[Value]) -> Result<Value, CoreError> {
        let choices = choices
            .iter()
            .cloned()
            .map(Value::normalize)
            .collect::<Result<Vec<_>, _>>()?;
        if choices.is_empty() {
            return Err(CoreError::protocol("No host choices"));
        }
        let selection = if let Some(source) = &self.source {
            source.get(self.cursor).and_then(|event| {
                if let Value::Int(index) = &event.output {
                    index.parse::<usize>().ok()
                } else {
                    None
                }
            })
        } else {
            self.random ^= self.random << 13;
            self.random ^= self.random >> 17;
            self.random ^= self.random << 5;
            Some(self.random as usize % choices.len())
        };
        let Some(index) = selection.filter(|index| *index < choices.len()) else {
            self.failed = true;
            return Err(CoreError::protocol("Invalid replay choice"));
        };
        let chosen = choices[index].clone();
        self.event(
            "choose",
            record(vec![
                ("label", Value::String(label.into())),
                ("choices", Value::List(choices.to_vec())),
            ]),
            integer(index as u64),
        )?;
        Ok(chosen)
    }
    pub fn write(&mut self, key: &str, value: Value) -> Result<(), CoreError> {
        self.require_running()?;
        let value = value.normalize()?;
        self.event(
            "write",
            record(vec![
                ("key", Value::String(key.into())),
                ("value", value.clone()),
            ]),
            Value::Null,
        )?;
        self.volatile.insert(key.into(), value);
        Ok(())
    }
    pub fn read(&self, key: &str) -> Result<Option<Value>, CoreError> {
        self.require_running()?;
        Ok(self.volatile.get(key).cloned())
    }
    pub fn persist(&mut self) -> Result<(), CoreError> {
        self.require_running()?;
        self.event("persist", Value::Null, Value::Null)?;
        self.durable = self.volatile.clone();
        Ok(())
    }
    pub fn crash(&mut self) -> Result<(), CoreError> {
        self.event("crash", Value::Null, Value::Null)?;
        self.running = false;
        self.volatile.clear();
        Ok(())
    }
    pub fn restart(&mut self) -> Result<(), CoreError> {
        self.event("restart", Value::Null, Value::Null)?;
        self.running = true;
        self.volatile = self.durable.clone();
        Ok(())
    }
    pub fn send(&mut self, from: &str, to: &str, payload: Value) -> Result<u32, CoreError> {
        self.require_running()?;
        let payload = payload.normalize()?;
        let id = self.next_id;
        let next = id
            .checked_add(1)
            .ok_or_else(|| CoreError::protocol("Message ID overflow"))?;
        self.event(
            "send",
            record(vec![
                ("from", Value::String(from.into())),
                ("to", Value::String(to.into())),
                ("payload", payload.clone()),
            ]),
            integer(u64::from(id)),
        )?;
        self.messages.push(HostMessage {
            id,
            from: from.into(),
            to: to.into(),
            payload,
        });
        self.next_id = next;
        Ok(id)
    }
    pub fn deliver(&mut self, index: usize) -> Result<HostMessage, CoreError> {
        self.require_running()?;
        let message = self
            .messages
            .get(index)
            .ok_or_else(|| CoreError::protocol("Invalid message index"))?
            .clone();
        self.event(
            "deliver",
            record(vec![
                ("index", integer(index as u64)),
                ("id", integer(u64::from(message.id))),
            ]),
            message.value(),
        )?;
        self.messages.remove(index);
        Ok(message)
    }
    pub fn drop_message(&mut self, index: usize) -> Result<(), CoreError> {
        let message = self
            .messages
            .get(index)
            .ok_or_else(|| CoreError::protocol("Invalid message index"))?;
        self.event(
            "drop",
            record(vec![
                ("index", integer(index as u64)),
                ("id", integer(u64::from(message.id))),
            ]),
            Value::Null,
        )?;
        self.messages.remove(index);
        Ok(())
    }
    pub fn trace(&self) -> HostTape {
        HostTape {
            format: "modelt.host-tape".into(),
            version: 1,
            events: self.events.clone(),
        }
    }
    pub fn finish(&mut self) -> Result<(), CoreError> {
        if self.failed
            || self
                .source
                .as_ref()
                .is_some_and(|source| source.len() != self.cursor)
        {
            return Err(CoreError::protocol("Divergent or unconsumed host tape"));
        }
        self.closed = true;
        Ok(())
    }
    pub fn snapshot(&self) -> Value {
        record(vec![
            ("clock", integer(self.clock)),
            ("running", Value::Bool(self.running)),
            (
                "storage",
                Value::Record(self.volatile.clone().into_iter().collect()),
            ),
            (
                "pending",
                Value::List(self.messages.iter().map(HostMessage::value).collect()),
            ),
        ])
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, CoreError> {
    match value {
        Value::Record(entries) => entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
            .ok_or_else(|| CoreError::protocol("Missing host field")),
        _ => Err(CoreError::protocol("Missing host field")),
    }
}
fn text(value: &Value) -> Result<&str, CoreError> {
    if let Value::String(value) = value {
        Ok(value)
    } else {
        Err(CoreError::protocol("Expected host string"))
    }
}
fn unsigned(value: &Value) -> Result<u64, CoreError> {
    if let Value::Int(value) = value {
        value
            .parse()
            .map_err(|_| CoreError::protocol("Expected host integer"))
    } else {
        Err(CoreError::protocol("Expected host integer"))
    }
}
pub fn replay_host(tape: HostTape) -> Result<Value, CoreError> {
    let mut host = SimulationHost::replay(tape.clone())?;
    for event in tape.events {
        match event.operation.as_str() {
            "write" => host.write(
                text(field(&event.input, "key")?)?,
                field(&event.input, "value")?.clone(),
            )?,
            "persist" => host.persist()?,
            "crash" => host.crash()?,
            "restart" => host.restart()?,
            "advance" => host.advance(unsigned(&event.input)?)?,
            "choose" => {
                let Value::List(choices) = field(&event.input, "choices")? else {
                    return Err(CoreError::protocol("Expected host choices"));
                };
                host.choose(text(field(&event.input, "label")?)?, choices)?;
            }
            "send" => {
                host.send(
                    text(field(&event.input, "from")?)?,
                    text(field(&event.input, "to")?)?,
                    field(&event.input, "payload")?.clone(),
                )?;
            }
            "deliver" => {
                host.deliver(
                    usize::try_from(unsigned(field(&event.input, "index")?)?)
                        .map_err(|_| CoreError::protocol("Message index overflow"))?,
                )?;
            }
            "drop" => host.drop_message(
                usize::try_from(unsigned(field(&event.input, "index")?)?)
                    .map_err(|_| CoreError::protocol("Message index overflow"))?,
            )?,
            _ => return Err(CoreError::protocol("Unknown host operation")),
        }
    }
    host.finish()?;
    Ok(host.snapshot())
}
