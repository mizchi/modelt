use modelt_core::{Command, Engine, Message, Value};

#[test]
fn shared_values_have_identical_canonical_bytes() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/portable-values.json")).unwrap();
    for fixture in fixtures["valid"].as_array().unwrap() {
        let value: Value = serde_json::from_value(fixture["input"].clone()).unwrap();
        assert_eq!(
            serde_json::to_string(&value.normalize().unwrap()).unwrap(),
            fixture["canonical"].as_str().unwrap(),
            "{}",
            fixture["name"]
        );
    }
    for fixture in fixtures["invalid"].as_array().unwrap() {
        let value = match fixture["json"].as_str() {
            Some(raw) => serde_json::from_str::<Value>(raw),
            None => serde_json::from_value::<Value>(fixture["input"].clone()),
        };
        assert!(
            value.is_err() || value.unwrap().normalize().is_err(),
            "{}",
            fixture["name"]
        );
    }
}

#[test]
fn protocol_rejects_wrong_versions_and_out_of_order_responses() {
    let mut engine = Engine::default();
    assert!(matches!(
        engine.dispatch(br#"{"version":2,"request":{"kind":"start","model":"test","actions":[]}}"#),
        Message::Error { .. }
    ));
    assert!(matches!(engine.dispatch(br#"{"version":1,"request":{"kind":"resume","id":1,"response":{"kind":"transitions","transitions":[]}}}"#), Message::Error { .. }));
    let command: Command = serde_json::from_str(
        r#"{"version":1,"request":{"kind":"start","model":"test","actions":[]}}"#,
    )
    .unwrap();
    assert!(!matches!(engine.handle(command), Message::Error { .. }));
    assert!(matches!(engine.dispatch(br#"{"version":1,"request":{"kind":"resume","id":2,"response":{"kind":"transitions","transitions":[]}}}"#), Message::Error { .. }));
    assert!(!matches!(engine.dispatch(br#"{"version":1,"request":{"kind":"resume","id":1,"response":{"kind":"transitions","transitions":[]}}}"#), Message::Error { .. }));
}
