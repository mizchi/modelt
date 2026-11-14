use modelt_core::Engine;
use serde_json::{Value, json};

fn ring(limit: i32) -> Value {
    let int = |value: i32| json!({"op":"literal","value":{"type":"int","value":value.to_string()}});
    json!({
        "format":"modelt.safety-program", "version":1, "name":"Ring", "variables":["x"],
        "initial":[{"name":"Init","steps":[{"kind":"assign","slot":0,"value":int(0)}]}],
        "next":[{"name":"Next","steps":[{"kind":"assign","slot":0,"value":{
            "op":"if", "condition":{"op":"lt","left":{"op":"read","slot":0,"next":false},"right":int(limit)},
            "consequent":{"op":"add","left":{"op":"read","slot":0,"next":false},"right":int(1)},
            "alternative":int(0)
        }}]}],
        "invariants":[{"name":"Safe","expression":{"op":"le","left":{"op":"read","slot":0,"next":false},"right":int(limit)}}],
        "assumptions":[], "checkDeadlock":true
    })
}

fn check(program: Value, depth: u32, states: u32, work: u32) -> Value {
    serde_json::to_value(
        Engine::default().dispatch(
            &serde_json::to_vec(&json!({
                "version":1,"request":{"kind":"check-safety","program":program,"bounds":{
                    "maxDepth":depth,"maxStates":states,"maxWork":work
                }}
            }))
            .unwrap(),
        ),
    )
    .unwrap()
}

#[test]
fn safety_backend_generates_and_closes_a_cycle_without_a_finite_graph() {
    let result = check(ring(3), 3, 4, 1000);
    assert_eq!(result["kind"], "safety");
    assert_eq!(result["result"]["status"], "complete");
    assert_eq!(result["result"]["states"], 4);
    assert_eq!(result["result"]["generated"], 5);
}

#[test]
fn cuts_never_report_complete_but_closed_frontiers_can() {
    assert_eq!(check(ring(3), 2, 4, 1000)["result"]["reason"], "depth");
    assert_eq!(check(ring(3), 3, 3, 1000)["result"]["reason"], "states");
    assert_eq!(check(ring(3), 3, 4, 1)["result"]["reason"], "work");
    assert_eq!(check(ring(0), 0, 1, 1000)["result"]["status"], "complete");
}

#[test]
fn shortest_counterexample_is_reconstructed_from_parents() {
    let mut program = ring(3);
    program["invariants"][0]["expression"]["right"]["value"]["value"] = json!("1");
    let result = check(program, 3, 4, 1000);
    assert_eq!(result["result"]["status"], "invariant-violation");
    let trace = result["result"]["violation"]["trace"].as_array().unwrap();
    assert_eq!(trace.len(), 3);
    assert_eq!(trace[0]["action"], Value::Null);
    assert_eq!(trace[2]["values"][0]["value"], "2");
}

#[test]
fn malformed_ir_is_rejected_before_search() {
    let mut invalid = ring(3);
    invalid["next"][0]["steps"][0]["slot"] = json!(1);
    assert_eq!(check(invalid, 3, 4, 1000)["kind"], "error");
    let mut invalid = ring(3);
    invalid["initial"][0]["steps"][0]["value"]["value"]["value"] = json!("2147483648");
    assert_eq!(check(invalid, 3, 4, 1000)["kind"], "error");
    assert_eq!(check(ring(3), 3, 0, 1000)["kind"], "error");
    assert_eq!(check(ring(3), 3, 4, 0)["kind"], "error");
}

#[test]
fn prepared_literals_preserve_the_wire_format_and_validate_unreachable_values() {
    let input = ring(3);
    let program: modelt_core::SafetyProgram = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(program).unwrap(), input);
    let mut invalid = ring(3);
    invalid["initial"][0]["steps"] = json!([{"kind":"guard","expression":{"op":"literal","value":{"type":"bool","value":false}}}]);
    invalid["next"][0]["steps"][0]["value"]["alternative"]["value"]["value"] = json!("2147483648");
    assert_eq!(check(invalid, 3, 4, 1000)["kind"], "error");
}
