use modelt_core::{Engine, Message, Status};

#[test]
fn finite_model_runs_without_a_model_host_and_rejects_bad_targets() {
    let model = serde_json::json!({"format":"modelt.finite-model","version":1,"name":"one","initial":[{"key":"0","observation":{"type":"int","value":"0"}}],"states":[{"key":"0","violations":[],"transitions":[{"action":{"type":"string","value":"tick"},"target":"0","observation":{"type":"int","value":"1"}}]}]});
    let mut engine = Engine::default();
    let trace = serde_json::json!({"format":"modelt.portable-trace","version":1,"model":"one","initial":{"type":"int","value":"0"},"steps":[{"action":{"type":"string","value":"tick"},"observation":{"type":"int","value":"1"}}]});
    let command = serde_json::json!({"version":1,"request":{"kind":"check-finite","model":model,"traces":[trace]}});
    let result = engine.dispatch(command.to_string().as_bytes());
    assert!(matches!(result, Message::Results { results } if results[0].status == Status::Matched));
    let mut broken = command.clone();
    broken["request"]["model"]["states"][0]["transitions"][0]["target"] =
        serde_json::json!("missing");
    assert!(matches!(
        engine.dispatch(broken.to_string().as_bytes()),
        Message::Error { .. }
    ));
}
