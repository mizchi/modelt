use modelt_core::{HostTape, SimulationHost, Value, replay_host};

#[test]
fn host_rejects_invalid_choices_without_accepting_a_divergent_replay() {
    let mut host = SimulationHost::new(1).unwrap();
    assert!(host.choose("bad", &[Value::Int("invalid".into())]).is_err());
    let mut replay = SimulationHost::replay(HostTape {
        format: "modelt.host-tape".into(),
        version: 1,
        events: vec![],
    })
    .unwrap();
    assert!(replay.choose("extra", &[Value::Int("0".into())]).is_err());
    assert!(replay.finish().is_err());
}

#[test]
fn host_replay_preserves_choices_messages_and_recovery() {
    let mut host = SimulationHost::new(3).unwrap();
    host.write("counter", Value::Int("1".into())).unwrap();
    host.persist().unwrap();
    host.write("counter", Value::Int("2".into())).unwrap();
    host.send("a", "b", Value::Int("1".into())).unwrap();
    host.send("b", "a", Value::Int("2".into())).unwrap();
    let choice = host
        .choose(
            "delivery",
            &[Value::Int("0".into()), Value::Int("1".into())],
        )
        .unwrap();
    let Value::Int(index) = choice else {
        panic!("expected index")
    };
    host.deliver(index.parse().unwrap()).unwrap();
    host.drop_message(0).unwrap();
    host.advance(10).unwrap();
    host.crash().unwrap();
    host.restart().unwrap();
    assert_eq!(host.read("counter").unwrap(), Some(Value::Int("1".into())));
    host.finish().unwrap();
    assert_eq!(replay_host(host.trace()).unwrap(), host.snapshot());
}
