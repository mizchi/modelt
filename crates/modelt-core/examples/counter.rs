use modelt_core::{ConformanceResult, Effect, Response, Session, Status, Transition, Value};

// The executable model and mutable implementation use separate transitions.
fn execute(mut session: Session, persist: bool) -> ConformanceResult {
    let mut memory = 0;
    let mut disk = 0;
    loop {
        let effect = session.effect();
        let (id, response) = match effect {
            Effect::Done { result } => return result,
            Effect::ModelInitial { id } => (
                id,
                Response::Transitions {
                    transitions: vec![Transition {
                        key: "0,0".into(),
                        state: Value::List(vec![Value::Int("0".into()), Value::Int("0".into())]),
                        observation: Value::Int("0".into()),
                    }],
                },
            ),
            Effect::ModelStep { id, states, action } => {
                let transitions = states
                    .into_iter()
                    .map(|entry| {
                        let Value::List(values) = entry.state else {
                            panic!("invalid state")
                        };
                        let Value::Int(current) = &values[0] else {
                            panic!("invalid memory")
                        };
                        let Value::Int(saved) = &values[1] else {
                            panic!("invalid disk")
                        };
                        let current: i32 = current.parse().unwrap();
                        let saved: i32 = saved.parse().unwrap();
                        let (next, stored) = match &action {
                            Value::String(name) if name == "add" => (current + 1, current + 1),
                            Value::String(name) if name == "crash" => (0, saved),
                            Value::String(name) if name == "restart" => (saved, saved),
                            _ => panic!("invalid action"),
                        };
                        Transition {
                            key: format!("{next},{stored}"),
                            state: Value::List(vec![
                                Value::Int(next.to_string()),
                                Value::Int(stored.to_string()),
                            ]),
                            observation: Value::Int(next.to_string()),
                        }
                    })
                    .collect();
                (id, Response::Transitions { transitions })
            }
            Effect::DriverReset { id } => {
                memory = 0;
                disk = 0;
                (
                    id,
                    Response::Observation {
                        observation: Value::Int("0".into()),
                    },
                )
            }
            Effect::DriverStep { id, action } => {
                match action {
                    Value::String(name) if name == "add" => {
                        memory += 1;
                        if persist {
                            disk = memory;
                        }
                    }
                    Value::String(name) if name == "crash" => memory = 0,
                    Value::String(name) if name == "restart" => memory = disk,
                    _ => panic!("invalid action"),
                }
                (
                    id,
                    Response::Observation {
                        observation: Value::Int(memory.to_string()),
                    },
                )
            }
        };
        session.resume(id, response).expect("valid effect response");
    }
}

fn main() {
    let actions = ["add", "crash", "restart"]
        .into_iter()
        .map(|name| Value::String(name.into()))
        .collect();
    let normal = execute(Session::new("durability".into(), actions).unwrap(), true);
    let broken = execute(Session::replay(normal.trace.clone()).unwrap(), false);
    assert_eq!(normal.status, Status::Matched);
    assert_eq!(broken.status, Status::Mismatch);
    println!("{}", serde_json::to_string(&broken).unwrap());
}

#[test]
fn native_rust_model_and_driver_reproduce_the_saved_oracle() {
    main();
}
