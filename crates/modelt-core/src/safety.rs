use crate::safety_expressions::{EvalContext, validate_branches};
use crate::safety_values::Arena;
use crate::temporal::{GraphEdge, TemporalFormula, TemporalProperty};
use crate::{CoreError, Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Expression {
    Prime {
        argument: Box<Self>,
    },
    Data {
        value: Value,
    },
    Bound {
        slot: usize,
    },
    Old,
    Set {
        values: Vec<Self>,
    },
    Tuple {
        values: Vec<Self>,
    },
    Record {
        fields: Vec<(String, Self)>,
    },
    RecordSet {
        fields: Vec<(String, Self)>,
    },
    At {
        target: Box<Self>,
        key: Box<Self>,
    },
    Update {
        target: Box<Self>,
        updates: Vec<Update>,
    },
    Forall {
        bounds: Vec<Binding>,
        body: Box<Self>,
    },
    Exists {
        bounds: Vec<Binding>,
        body: Box<Self>,
    },
    Function {
        bounds: Vec<Binding>,
        body: Box<Self>,
    },
    Filter {
        bounds: Vec<Binding>,
        body: Box<Self>,
    },
    MapSet {
        bounds: Vec<Binding>,
        body: Box<Self>,
    },
    Domain {
        argument: Box<Self>,
    },
    Cardinality {
        argument: Box<Self>,
    },
    SequenceSet {
        argument: Box<Self>,
    },
    Len {
        argument: Box<Self>,
    },
    Head {
        argument: Box<Self>,
    },
    Tail {
        argument: Box<Self>,
    },
    Powerset {
        argument: Box<Self>,
    },
    Union {
        argument: Box<Self>,
    },
    Cup {
        left: Box<Self>,
        right: Box<Self>,
    },
    Cap {
        left: Box<Self>,
        right: Box<Self>,
    },
    Difference {
        left: Box<Self>,
        right: Box<Self>,
    },
    SubsetEq {
        left: Box<Self>,
        right: Box<Self>,
    },
    Append {
        left: Box<Self>,
        right: Box<Self>,
    },
    Concat {
        left: Box<Self>,
        right: Box<Self>,
    },
    FunctionSet {
        left: Box<Self>,
        right: Box<Self>,
    },
    FunctionIn {
        left: Box<Self>,
        right: Box<Self>,
    },
    SequenceIn {
        left: Box<Self>,
        right: Box<Self>,
    },
    Subseq {
        sequence: Box<Self>,
        from: Box<Self>,
        to: Box<Self>,
    },
    Enabled {
        branches: Vec<Branch>,
        #[serde(default)]
        subscript: Option<Box<Self>>,
    },
    Literal {
        value: Scalar,
    },
    Read {
        slot: usize,
        next: bool,
    },
    Not {
        argument: Box<Self>,
    },
    Neg {
        argument: Box<Self>,
    },
    Add {
        left: Box<Self>,
        right: Box<Self>,
    },
    Sub {
        left: Box<Self>,
        right: Box<Self>,
    },
    Mul {
        left: Box<Self>,
        right: Box<Self>,
    },
    Eq {
        left: Box<Self>,
        right: Box<Self>,
    },
    Ne {
        left: Box<Self>,
        right: Box<Self>,
    },
    Lt {
        left: Box<Self>,
        right: Box<Self>,
    },
    Le {
        left: Box<Self>,
        right: Box<Self>,
    },
    Gt {
        left: Box<Self>,
        right: Box<Self>,
    },
    Ge {
        left: Box<Self>,
        right: Box<Self>,
    },
    And {
        left: Box<Self>,
        right: Box<Self>,
    },
    Or {
        left: Box<Self>,
        right: Box<Self>,
    },
    Implies {
        left: Box<Self>,
        right: Box<Self>,
    },
    If {
        condition: Box<Self>,
        consequent: Box<Self>,
        alternative: Box<Self>,
    },
    In {
        value: Box<Self>,
        domain: Domain,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Domain {
    Value {
        value: Box<Expression>,
    },
    Range {
        lower: Box<Expression>,
        upper: Box<Expression>,
    },
    Set {
        values: Vec<Expression>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Step {
    Bind {
        slot: usize,
        domain: Domain,
        #[serde(rename = "tupleSize", default, skip_serializing_if = "Option::is_none")]
        tuple_size: Option<usize>,
    },
    Guard {
        expression: Expression,
    },
    Assign {
        slot: usize,
        value: Expression,
    },
    Choose {
        slot: usize,
        domain: Domain,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    #[serde(rename = "tupleSize", default, skip_serializing_if = "Option::is_none")]
    pub tuple_size: Option<usize>,
    pub slot: usize,
    pub domain: Domain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub path: Vec<Expression>,
    pub value: Expression,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Branch {
    pub name: String,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    pub name: String,
    pub expression: Expression,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SafetyProgram {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub variables: Vec<String>,
    pub initial: Vec<Branch>,
    pub next: Vec<Branch>,
    pub invariants: Vec<Predicate>,
    pub assumptions: Vec<Predicate>,
    pub check_deadlock: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initial_properties: Vec<Predicate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub action_properties: Vec<Predicate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<TemporalProperty>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fairness: Vec<TemporalFormula>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SafetyBounds {
    pub max_depth: u32,
    pub max_states: u32,
    pub max_work: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_temporal_nodes: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafetyTraceStep {
    pub action: Option<String>,
    pub values: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafetyViolation {
    pub name: String,
    pub trace: Vec<SafetyTraceStep>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "loopStart")]
    pub loop_start: Option<usize>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "loopAction"
    )]
    pub loop_action: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafetyResult {
    pub status: String,
    pub reason: Option<String>,
    pub states: usize,
    pub generated: u32,
    pub depth: u32,
    pub work: u32,
    pub violation: Option<SafetyViolation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(try_from = "Value")]
pub enum Scalar {
    Bool(bool),
    Int(i32),
    Ref(u32),
}

impl TryFrom<Value> for Scalar {
    type Error = CoreError;
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl Serialize for Scalar {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = match self {
            Self::Bool(value) => Value::Bool(*value),
            Self::Int(value) => Value::Int(value.to_string()),
            Self::Ref(_) => return Err(serde::ser::Error::custom("Internal value reference")),
        };
        value.serialize(serializer)
    }
}

impl Scalar {
    pub(crate) fn parse(value: &Value) -> Result<Self, CoreError> {
        match value {
            Value::Bool(value) => Ok(Self::Bool(*value)),
            Value::Int(value) => {
                let parsed = value.parse::<i32>().map_err(|_| {
                    CoreError::protocol("Safety integer exceeds signed 32 bit range")
                })?;
                if parsed.to_string() != *value {
                    return Err(CoreError::protocol("Noncanonical safety integer"));
                }
                Ok(Self::Int(parsed))
            }
            _ => Err(CoreError::protocol(
                "Safety values must be integers or booleans",
            )),
        }
    }
    pub(crate) fn integer(self) -> Result<i32, CoreError> {
        match self {
            Self::Int(value) => Ok(value),
            _ => Err(CoreError::protocol("Expected an integer")),
        }
    }
    pub(crate) fn boolean(self) -> Result<bool, CoreError> {
        match self {
            Self::Bool(value) => Ok(value),
            _ => Err(CoreError::protocol("Expected a boolean")),
        }
    }
}

struct Node {
    parent: Option<usize>,
    action: Option<usize>,
    depth: u32,
}

#[derive(Clone, Copy)]
struct BranchCursor<'a> {
    definition: &'a Branch,
    index: usize,
}

struct StateStore {
    width: usize,
    values: Vec<Scalar>,
    heads: HashMap<u64, usize>,
    links: Vec<Option<usize>>,
}

impl StateStore {
    fn new(width: usize) -> Self {
        Self {
            width,
            values: vec![],
            heads: HashMap::new(),
            links: vec![],
        }
    }
    fn state(&self, index: usize) -> &[Scalar] {
        &self.values[index * self.width..(index + 1) * self.width]
    }
    fn find(&self, hash: u64, values: &[Option<Scalar>]) -> Option<usize> {
        if values.len() != self.width {
            return None;
        }
        let mut candidate = self.heads.get(&hash).copied();
        while let Some(index) = candidate {
            if self
                .state(index)
                .iter()
                .zip(values)
                .all(|(stored, actual)| Some(*stored) == *actual)
            {
                return Some(index);
            }
            candidate = self.links[index];
        }
        None
    }
    fn push(&mut self, hash: u64, values: &[Option<Scalar>]) -> Result<usize, CoreError> {
        if values.len() != self.width || values.iter().any(Option::is_none) {
            return Err(CoreError::protocol("Incomplete safety state"));
        }
        let index = self.links.len();
        self.values.extend(values.iter().flatten().copied());
        self.links.push(self.heads.insert(hash, index));
        Ok(index)
    }
}

fn get_hash(values: &[Option<Scalar>]) -> Result<u64, CoreError> {
    values
        .iter()
        .try_fold(0xcbf2_9ce4_8422_2325_u64, |hash, value| {
            let bits = match value.ok_or_else(|| CoreError::protocol("Incomplete safety state"))? {
                Scalar::Int(value) => u64::from(value as u32) << 1,
                Scalar::Bool(value) => (u64::from(value) << 1) | 1,
                Scalar::Ref(value) => u64::from(value) ^ 0x9e37_79b9_7f4a_7c15,
            };
            Ok(hash.wrapping_mul(0x0000_0100_0000_01b3) ^ bits)
        })
}

struct Search<'a> {
    program: &'a SafetyProgram,
    bounds: SafetyBounds,
    nodes: Vec<Node>,
    store: StateStore,
    result: SafetyResult,
    arena: Arena,
    graph: Option<Vec<Vec<GraphEdge>>>,
    roots: Vec<usize>,
}

impl SafetyProgram {
    pub fn check(&self, bounds: SafetyBounds) -> Result<SafetyResult, CoreError> {
        if self.format != "modelt.safety-program"
            || self.version != 1
            || self.name.is_empty()
            || self.variables.is_empty()
            || self.variables.len() > 256
            || self.variables.iter().any(String::is_empty)
            || self.variables.iter().collect::<HashSet<_>>().len() != self.variables.len()
            || bounds.max_states == 0
            || bounds.max_work == 0
        {
            return Err(CoreError::protocol("Invalid safety program or bounds"));
        }
        let mut search = Search {
            program: self,
            bounds,
            nodes: vec![],
            arena: Arena::new(bounds.max_work),
            graph: (!self.properties.is_empty()).then(Vec::new),
            roots: vec![],
            store: StateStore::new(self.variables.len()),
            result: SafetyResult {
                status: "complete".into(),
                reason: None,
                states: 0,
                generated: 0,
                depth: 0,
                work: 0,
                violation: None,
            },
        };
        let outcome = search.run();
        if let Err(error) = outcome {
            if error.code != "budget" && error.code != "temporal-budget" {
                return Err(error);
            }
            search.result.status = "bounded".into();
            search.result.reason = Some(
                if error.code == "temporal-budget" {
                    "temporal"
                } else {
                    "work"
                }
                .into(),
            );
        }
        search.result.work = search.arena.work;
        Ok(search.result)
    }
}

impl Search<'_> {
    fn run(&mut self) -> Result<(), CoreError> {
        let program = self.program;
        validate_branches(&program.initial, program.variables.len(), 0, 0)?;
        validate_branches(&program.next, program.variables.len(), 1, 0)?;
        for predicate in program.invariants.iter().chain(&program.initial_properties) {
            predicate
                .expression
                .validate(program.variables.len(), 2, 0)?;
            if predicate.expression.is_constant()
                && !predicate
                    .expression
                    .eval(EvalContext::new(&[], &[]), &mut self.arena)?
                    .boolean()?
            {
                return Err(CoreError::protocol(
                    "Constant invariant or property is false",
                ));
            }
        }
        for predicate in &program.action_properties {
            predicate
                .expression
                .validate(program.variables.len(), 1, 0)?;
        }
        for property in &program.properties {
            property.formula.validate(program.variables.len(), 0)?;
        }
        for fairness in &program.fairness {
            fairness.validate(program.variables.len(), 0)?;
        }
        for predicate in &program.assumptions {
            predicate
                .expression
                .validate(program.variables.len(), 3, 0)?;
            if !predicate
                .expression
                .eval(EvalContext::new(&[], &[]), &mut self.arena)?
                .boolean()?
            {
                self.result.status = "assumption-violation".into();
                self.result.violation = Some(SafetyViolation {
                    name: predicate.name.clone(),
                    trace: vec![],
                    loop_start: None,
                    loop_action: None,
                });
                return Ok(());
            }
        }
        let mut next = vec![None; program.variables.len()];
        for (index, branch) in program.initial.iter().enumerate() {
            self.walk(
                BranchCursor {
                    definition: branch,
                    index,
                },
                0,
                EvalContext::new(&[], &[]),
                &mut next,
                None,
                &mut false,
            )?;
            if self.stopped() {
                return Ok(());
            }
        }
        if self.nodes.is_empty() {
            self.result.status = "empty".into();
            return Ok(());
        }
        let mut index = 0;
        let mut current = vec![Scalar::Int(0); program.variables.len()];
        while index < self.nodes.len() {
            current.copy_from_slice(self.store.state(index));
            let mut enabled = false;
            for (branch_index, branch) in program.next.iter().enumerate() {
                self.walk(
                    BranchCursor {
                        definition: branch,
                        index: branch_index,
                    },
                    0,
                    EvalContext::new(&current, &[]),
                    &mut next,
                    Some(index),
                    &mut enabled,
                )?;
                if self.stopped() {
                    return Ok(());
                }
            }
            if !enabled && program.check_deadlock {
                self.result.status = "deadlock".into();
                self.result.reason = None;
                self.result.violation = Some(SafetyViolation {
                    name: "deadlock".into(),
                    trace: self.trace(index)?,
                    loop_start: None,
                    loop_action: None,
                });
                return Ok(());
            }
            index += 1;
        }
        if self.result.status == "complete"
            && let Some(graph) = &mut self.graph
        {
            for (index, edges) in graph.iter_mut().enumerate() {
                edges.push(GraphEdge {
                    target: index,
                    action: None,
                });
            }
            if let Some(violation) = crate::temporal::check(
                program,
                self.bounds,
                &self.store.values,
                self.store.width,
                graph,
                &self.roots,
                &mut self.arena,
            )? {
                self.result.status = "liveness-violation".into();
                self.result.violation = Some(violation);
            }
        }
        Ok(())
    }
    fn stopped(&self) -> bool {
        self.result.violation.is_some()
            || self.result.reason.as_deref() == Some("work")
            || self.result.reason.as_deref() == Some("states")
    }
    fn tick(&mut self) -> bool {
        if self.arena.tick().is_err() {
            self.result.status = "bounded".into();
            self.result.reason = Some("work".into());
            return false;
        }
        true
    }
    fn walk(
        &mut self,
        branch: BranchCursor<'_>,
        position: usize,
        context: EvalContext<'_>,
        next: &mut [Option<Scalar>],
        parent: Option<usize>,
        enabled: &mut bool,
    ) -> Result<(), CoreError> {
        if !self.tick() {
            return Ok(());
        }
        let Some(step) = branch.definition.steps.get(position) else {
            *enabled = true;
            self.accept(next, parent, branch.index)?;
            return Ok(());
        };
        let ctx = EvalContext { next, ..context };
        match step {
            Step::Guard { expression } => {
                if expression.eval(ctx, &mut self.arena)?.boolean()? {
                    self.walk(branch, position + 1, context, next, parent, enabled)?;
                }
            }
            Step::Assign { slot, value } => {
                let value = value.eval(ctx, &mut self.arena)?;
                let previous = next[*slot];
                if previous
                    .map(|previous| self.arena.equal(previous, value))
                    .transpose()?
                    .unwrap_or(true)
                {
                    next[*slot] = Some(value);
                    self.walk(branch, position + 1, context, next, parent, enabled)?;
                    next[*slot] = previous;
                }
            }
            Step::Choose { slot, domain } => {
                if let Some(value) = next[*slot] {
                    if domain.contains(value, ctx, &mut self.arena)? {
                        self.walk(branch, position + 1, context, next, parent, enabled)?;
                    }
                    return Ok(());
                }
                for value in domain.values(ctx, &mut self.arena)? {
                    next[*slot] = Some(value);
                    self.walk(branch, position + 1, context, next, parent, enabled)?;
                    if self.stopped() {
                        break;
                    }
                }
                next[*slot] = None;
            }
            Step::Bind {
                slot,
                domain,
                tuple_size,
            } => {
                let values = domain.values(ctx, &mut self.arena)?;
                let mut locals = context.locals.to_vec();
                if *slot != locals.len() {
                    return Err(CoreError::protocol("Invalid bound slot"));
                }
                for value in values {
                    self.arena.check_tuple(value, *tuple_size)?;
                    locals.push(value);
                    self.walk(
                        branch,
                        position + 1,
                        EvalContext {
                            locals: &locals,
                            ..context
                        },
                        next,
                        parent,
                        enabled,
                    )?;
                    locals.pop();
                    if self.stopped() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    fn accept(
        &mut self,
        values: &[Option<Scalar>],
        parent: Option<usize>,
        action: usize,
    ) -> Result<(), CoreError> {
        let hash = get_hash(values)?;
        self.result.generated += 1;
        let existing = self.store.find(hash, values);
        let index = if let Some(index) = existing {
            index
        } else {
            let depth = parent.map_or(0, |index| self.nodes[index].depth + 1);
            if depth > self.bounds.max_depth {
                self.result.status = "bounded".into();
                self.result.reason = Some("depth".into());
                return Ok(());
            }
            if self.nodes.len() == self.bounds.max_states as usize {
                self.result.status = "bounded".into();
                self.result.reason = Some("states".into());
                return Ok(());
            }
            let index = self.store.push(hash, values)?;
            self.nodes.push(Node {
                parent,
                action: parent.map(|_| action),
                depth,
            });
            if let Some(graph) = &mut self.graph {
                graph.push(vec![]);
            }
            self.result.states = self.nodes.len();
            self.result.depth = self.result.depth.max(depth);
            index
        };
        if let Some(parent) = parent {
            if let Some(graph) = &mut self.graph {
                graph[parent].push(GraphEdge {
                    target: index,
                    action: Some(action),
                });
            }
        } else if !self.roots.contains(&index) {
            self.roots.push(index);
        }
        if existing.is_none() {
            for predicate in &self.program.invariants {
                if !predicate
                    .expression
                    .eval(
                        EvalContext::new(self.store.state(index), &[]),
                        &mut self.arena,
                    )?
                    .boolean()?
                {
                    self.result.status = "invariant-violation".into();
                    self.result.reason = None;
                    self.result.violation = Some(SafetyViolation {
                        name: predicate.name.clone(),
                        trace: self.trace(index)?,
                        loop_start: None,
                        loop_action: None,
                    });
                    return Ok(());
                }
            }
        }
        if let Some(parent) = parent {
            for predicate in &self.program.action_properties {
                if !predicate
                    .expression
                    .eval(
                        EvalContext::new(self.store.state(parent), values),
                        &mut self.arena,
                    )?
                    .boolean()?
                {
                    let mut trace = self.trace(parent)?;
                    trace.push(SafetyTraceStep {
                        action: Some(self.program.next[action].name.clone()),
                        values: self.portable(index)?,
                    });
                    self.result.status = "property-violation".into();
                    self.result.reason = None;
                    self.result.violation = Some(SafetyViolation {
                        name: predicate.name.clone(),
                        trace,
                        loop_start: None,
                        loop_action: None,
                    });
                    return Ok(());
                }
            }
        } else {
            for predicate in &self.program.initial_properties {
                if !predicate
                    .expression
                    .eval(
                        EvalContext::new(self.store.state(index), &[]),
                        &mut self.arena,
                    )?
                    .boolean()?
                {
                    self.result.status = "property-violation".into();
                    self.result.reason = None;
                    self.result.violation = Some(SafetyViolation {
                        name: predicate.name.clone(),
                        trace: self.trace(index)?,
                        loop_start: None,
                        loop_action: None,
                    });
                    return Ok(());
                }
            }
        }
        Ok(())
    }
    fn portable(&self, index: usize) -> Result<Vec<Value>, CoreError> {
        self.store
            .state(index)
            .iter()
            .map(|value| self.arena.portable(*value))
            .collect()
    }
    fn trace(&self, mut index: usize) -> Result<Vec<SafetyTraceStep>, CoreError> {
        let mut trace = vec![];
        loop {
            let node = &self.nodes[index];
            trace.push(SafetyTraceStep {
                action: node
                    .action
                    .map(|index| self.program.next[index].name.clone()),
                values: self.portable(index)?,
            });
            match node.parent {
                Some(parent) => index = parent,
                None => break,
            }
        }
        trace.reverse();
        Ok(trace)
    }
}

#[cfg(test)]
mod tests {
    use super::{Scalar, StateStore};

    #[test]
    fn colliding_hashes_keep_distinct_typed_states() {
        let mut store = StateStore::new(2);
        let first = [Some(Scalar::Int(0)), Some(Scalar::Int(1))];
        let second = [Some(Scalar::Int(0)), Some(Scalar::Int(2))];
        let third = [Some(Scalar::Bool(false)), Some(Scalar::Int(1))];
        for values in [&first, &second, &third] {
            store.push(0, values).unwrap();
        }
        assert_eq!(store.find(0, &first), Some(0));
        assert_eq!(store.find(0, &second), Some(1));
        assert_eq!(store.find(0, &third), Some(2));
        assert_eq!(
            store.find(0, &[Some(Scalar::Int(0)), Some(Scalar::Int(3))]),
            None
        );
        assert_eq!(store.find(0, &first[..1]), None);
        assert!(store.push(0, &[Some(Scalar::Int(0)), None]).is_err());
        assert_eq!(store.find(0, &third), Some(2));
    }
}
