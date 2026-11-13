use modelt_core::{Engine, Message};

#[test]
fn loaded_models_reject_stale_handles_and_keep_live_sessions() {
    let model = serde_json::json!({"format":"modelt.finite-model","version":1,"name":"one","initial":[{"key":"0","observation":{"type":"int","value":"0"}}],"states":[{"key":"0","violations":[],"transitions":[]}]});
    let mut core = Engine::default();
    let load = serde_json::json!({"version":1,"request":{"kind":"load-model","model":model}});
    assert!(matches!(
        core.dispatch(load.to_string().as_bytes()),
        Message::Loaded { handle: 1 }
    ));
    let start = br#"{"version":1,"request":{"kind":"start-loaded","handle":1,"actions":[]}}"#;
    assert!(matches!(core.dispatch(start), Message::Effect { .. }));
    let release = br#"{"version":1,"request":{"kind":"release-model","handle":1}}"#;
    assert!(matches!(core.dispatch(release), Message::Error { .. }));
    core.dispatch(br#"{"version":1,"request":{"kind":"cancel","id":2}}"#);
    assert!(matches!(core.dispatch(release), Message::Released));
    assert!(matches!(core.dispatch(start), Message::Error { .. }));
    assert!(matches!(
        core.dispatch(load.to_string().as_bytes()),
        Message::Loaded { handle: 2 }
    ));
}
