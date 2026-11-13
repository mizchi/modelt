use modelt_core::{ShrinkStatus, ShrinkVerdict, Value, shrink_counterexample};

#[test]
fn native_shrinking_preserves_the_same_failure_and_budget() {
    let actions = ["noise", "bad", "noise", "other"]
        .iter()
        .map(|name| Value::String((*name).into()))
        .collect::<Vec<_>>();
    let evaluate = |sequence: &[Value]| {
        Ok(if sequence.contains(&Value::String("bad".into())) {
            ShrinkVerdict::Mismatch("bug".into())
        } else if sequence.contains(&Value::String("other".into())) {
            ShrinkVerdict::Mismatch("different".into())
        } else {
            ShrinkVerdict::Invalid
        })
    };
    let result = shrink_counterexample(actions.clone(), evaluate, 100).unwrap();
    assert!(matches!(result.status, ShrinkStatus::Minimal));
    assert_eq!(result.actions, vec![Value::String("bad".into())]);
    assert!(matches!(
        shrink_counterexample(actions, evaluate, 2).unwrap().status,
        ShrinkStatus::Bounded
    ));
}
