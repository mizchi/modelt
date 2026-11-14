use modelt_core::Engine;
use serde_json::json;

#[test]
fn tuple_and_finite_function_states_are_semantically_equal() {
    let literal =
        |value: i32| json!({"op":"literal","value":{"type":"int","value":value.to_string()}});
    let program = json!({"format":"modelt.safety-program","version":1,"name":"collections","variables":["q"],
        "initial":[{"name":"Init","steps":[{"kind":"assign","slot":0,"value":{"op":"tuple","values":[literal(7)]}}]}],
        "next":[{"name":"Next","steps":[{"kind":"assign","slot":0,"value":{"op":"read","slot":0,"next":false}}]}],
        "invariants":[{"name":"Same","expression":{"op":"eq","left":{"op":"read","slot":0,"next":false},"right":{"op":"data","value":{"type":"map","value":[[{"type":"int","value":"1"},{"type":"int","value":"7"}]]}}}}],
        "assumptions":[],"checkDeadlock":true});
    let request = json!({"version":1,"request":{"kind":"check-safety","program":program,"bounds":{"maxDepth":10,"maxStates":10,"maxWork":1000}}});
    let actual =
        serde_json::to_value(Engine::default().dispatch(&serde_json::to_vec(&request).unwrap()))
            .unwrap();
    assert_eq!(actual["kind"], "safety", "{actual}");
    assert_eq!(actual["result"]["status"], "complete");
    assert_eq!(actual["result"]["states"], 1);
}
