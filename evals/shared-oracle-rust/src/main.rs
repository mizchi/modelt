use modelt_core::{
    ConformanceResult, CoreError, Effect, FiniteModel, Response, Session, Status, Trace, Value,
};
use modelt_shared_oracle::{Action, Counter, Fault, Observation};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OracleCase {
    id: String,
    #[serde(rename = "seed")]
    _seed: Option<i64>,
    oracle: Trace,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Suite {
    format: String,
    version: u32,
    model: FiniteModel,
    faults: Vec<Fault>,
    cases: Vec<OracleCase>,
}

#[derive(Default, Serialize)]
struct Calls {
    resets: u32,
    steps: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Execution {
    case_id: String,
    fault: Fault,
    finite: ConformanceResult,
    replay: ConformanceResult,
    finite_calls: Calls,
    replay_calls: Calls,
}

fn native_value(value: Value) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    match value {
        Value::String(value) => Ok(value.into()),
        Value::Int(value) => Ok(value.parse::<i64>()?.into()),
        Value::Record(fields) => Ok(serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, native_value(value)?)))
                .collect::<Result<_, Box<dyn std::error::Error>>>()?,
        )),
        _ => Err(CoreError::protocol("Unsupported counter action value").into()),
    }
}

fn observation(value: Observation) -> Value {
    Value::Record(vec![
        ("running".into(), Value::Bool(value.running)),
        ("value".into(), Value::Int(value.value.to_string())),
    ])
}

fn execute(
    mut session: Session,
    model: &FiniteModel,
    fault: Fault,
    calls: &mut Calls,
) -> Result<ConformanceResult, Box<dyn std::error::Error>> {
    let mut sut = Counter::new(fault);
    loop {
        let effect = session.effect();
        if let Some(response) = model.response(&effect)? {
            let id = match effect {
                Effect::ModelInitial { id } | Effect::ModelStep { id, .. } => id,
                _ => unreachable!(),
            };
            session.resume(id, response)?;
            continue;
        }
        match effect {
            Effect::DriverReset { id } => {
                calls.resets += 1;
                session.resume(
                    id,
                    Response::Observation {
                        observation: observation(sut.reset()),
                    },
                )?;
            }
            Effect::DriverStep { id, action } => {
                let action: Action = serde_json::from_value(native_value(action)?)?;
                calls.steps += 1;
                session.resume(
                    id,
                    Response::Observation {
                        observation: observation(sut.step(action)),
                    },
                )?;
            }
            Effect::Done { result } => return Ok(result),
            _ => return Err(CoreError::protocol("Unexpected SUT effect").into()),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes)?;
    let suite: Suite = serde_json::from_slice(&bytes)?;
    if suite.format != "modelt.oracle-suite"
        || suite.version != 1
        || suite.cases.is_empty()
        || suite.faults.is_empty()
    {
        return Err(CoreError::protocol("Invalid oracle suite").into());
    }
    let model = suite.model.normalize()?;
    for entry in &suite.cases {
        if model.check_history(entry.oracle.clone())?.status != Status::Matched {
            return Err(CoreError::protocol("Oracle differs from finite model").into());
        }
    }
    let mut rows = vec![];
    for entry in suite.cases {
        for fault in &suite.faults {
            let mut finite_calls = Calls::default();
            let mut replay_calls = Calls::default();
            let finite = execute(
                Session::new(
                    model.name.clone(),
                    entry
                        .oracle
                        .steps
                        .iter()
                        .map(|step| step.action.clone())
                        .collect(),
                )?,
                &model,
                *fault,
                &mut finite_calls,
            )?;
            let replay = execute(
                Session::replay(entry.oracle.clone())?,
                &model,
                *fault,
                &mut replay_calls,
            )?;
            rows.push(Execution {
                case_id: entry.id.clone(),
                fault: *fault,
                finite,
                replay,
                finite_calls,
                replay_calls,
            });
        }
    }
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}
