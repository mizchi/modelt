use crate::{CoreError, Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Expression {
    Literal {
        value: Value,
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
    Guard { expression: Expression },
    Assign { slot: usize, value: Expression },
    Choose { slot: usize, domain: Domain },
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
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SafetyBounds {
    pub max_depth: u32,
    pub max_states: u32,
    pub max_work: u32,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Scalar {
    Bool(bool),
    Int(i32),
}

impl Scalar {
    fn parse(value: &Value) -> Result<Self, CoreError> {
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
    fn integer(self) -> Result<i32, CoreError> {
        match self {
            Self::Int(value) => Ok(value),
            _ => Err(CoreError::protocol("Expected an integer")),
        }
    }
    fn boolean(self) -> Result<bool, CoreError> {
        match self {
            Self::Bool(value) => Ok(value),
            _ => Err(CoreError::protocol("Expected a boolean")),
        }
    }
    fn equal(self, other: Self) -> Result<bool, CoreError> {
        if std::mem::discriminant(&self) != std::mem::discriminant(&other) {
            return Err(CoreError::protocol("Incomparable safety values"));
        }
        Ok(self == other)
    }
    fn portable(self) -> Value {
        match self {
            Self::Bool(value) => Value::Bool(value),
            Self::Int(value) => Value::Int(value.to_string()),
        }
    }
}

impl Expression {
    fn validate(&self, variables: usize, phase: u8, depth: usize) -> Result<(), CoreError> {
        if depth > 48 {
            return Err(CoreError::protocol("Safety expression nesting exceeds 48"));
        }
        let child = |value: &Self| value.validate(variables, phase, depth + 1);
        match self {
            Self::Literal { value } => {
                Scalar::parse(value)?;
            }
            Self::Read { slot, next } => {
                if *slot >= variables
                    || (phase == 0 && !next)
                    || (phase == 2 && *next)
                    || phase == 3
                {
                    return Err(CoreError::protocol("Invalid safety variable read"));
                }
            }
            Self::Not { argument } | Self::Neg { argument } => child(argument)?,
            Self::If {
                condition,
                consequent,
                alternative,
            } => {
                child(condition)?;
                child(consequent)?;
                child(alternative)?;
            }
            Self::In { value, domain } => {
                child(value)?;
                domain.validate(variables, phase, depth + 1)?;
            }
            Self::Add { left, right }
            | Self::Sub { left, right }
            | Self::Mul { left, right }
            | Self::Eq { left, right }
            | Self::Ne { left, right }
            | Self::Lt { left, right }
            | Self::Le { left, right }
            | Self::Gt { left, right }
            | Self::Ge { left, right }
            | Self::And { left, right }
            | Self::Or { left, right }
            | Self::Implies { left, right } => {
                child(left)?;
                child(right)?;
            }
        }
        Ok(())
    }
    fn eval(&self, current: &[Scalar], next: &[Option<Scalar>]) -> Result<Scalar, CoreError> {
        let eval = |value: &Self| value.eval(current, next);
        let arithmetic = |left: &Self, right: &Self, operation: fn(i32, i32) -> Option<i32>| {
            operation(eval(left)?.integer()?, eval(right)?.integer()?)
                .map(Scalar::Int)
                .ok_or_else(|| CoreError::protocol("Safety integer overflow"))
        };
        Ok(match self {
            Self::Literal { value } => Scalar::parse(value)?,
            Self::Read { slot, next: true } => next
                .get(*slot)
                .copied()
                .flatten()
                .ok_or_else(|| CoreError::protocol("Read of an unassigned next variable"))?,
            Self::Read { slot, next: false } => *current
                .get(*slot)
                .ok_or_else(|| CoreError::protocol("Read of a missing current variable"))?,
            Self::Not { argument } => Scalar::Bool(!eval(argument)?.boolean()?),
            Self::Neg { argument } => Scalar::Int(
                eval(argument)?
                    .integer()?
                    .checked_neg()
                    .ok_or_else(|| CoreError::protocol("Safety integer overflow"))?,
            ),
            Self::Add { left, right } => arithmetic(left, right, i32::checked_add)?,
            Self::Sub { left, right } => arithmetic(left, right, i32::checked_sub)?,
            Self::Mul { left, right } => arithmetic(left, right, i32::checked_mul)?,
            Self::Eq { left, right } | Self::Ne { left, right } => {
                let left = eval(left)?;
                let right = eval(right)?;
                if std::mem::discriminant(&left) != std::mem::discriminant(&right) {
                    return Err(CoreError::protocol("Incomparable safety values"));
                }
                Scalar::Bool((left == right) == matches!(self, Self::Eq { .. }))
            }
            Self::Lt { left, right } => {
                Scalar::Bool(eval(left)?.integer()? < eval(right)?.integer()?)
            }
            Self::Le { left, right } => {
                Scalar::Bool(eval(left)?.integer()? <= eval(right)?.integer()?)
            }
            Self::Gt { left, right } => {
                Scalar::Bool(eval(left)?.integer()? > eval(right)?.integer()?)
            }
            Self::Ge { left, right } => {
                Scalar::Bool(eval(left)?.integer()? >= eval(right)?.integer()?)
            }
            Self::And { left, right } => {
                Scalar::Bool(eval(left)?.boolean()? && eval(right)?.boolean()?)
            }
            Self::Or { left, right } => {
                Scalar::Bool(eval(left)?.boolean()? || eval(right)?.boolean()?)
            }
            Self::Implies { left, right } => {
                Scalar::Bool(!eval(left)?.boolean()? || eval(right)?.boolean()?)
            }
            Self::If {
                condition,
                consequent,
                alternative,
            } => eval(if eval(condition)?.boolean()? {
                consequent
            } else {
                alternative
            })?,
            Self::In { value, domain } => {
                Scalar::Bool(domain.contains(eval(value)?, current, next)?)
            }
        })
    }
}

impl Domain {
    fn validate(&self, variables: usize, phase: u8, depth: usize) -> Result<(), CoreError> {
        match self {
            Self::Range { lower, upper } => {
                lower.validate(variables, phase, depth)?;
                upper.validate(variables, phase, depth)?;
            }
            Self::Set { values } => {
                for value in values {
                    value.validate(variables, phase, depth)?;
                }
            }
        }
        Ok(())
    }
    fn contains(
        &self,
        value: Scalar,
        current: &[Scalar],
        next: &[Option<Scalar>],
    ) -> Result<bool, CoreError> {
        match self {
            Self::Range { lower, upper } => {
                let lower = lower.eval(current, next)?.integer()?;
                let upper = upper.eval(current, next)?.integer()?;
                let value = value.integer()?;
                Ok(lower <= value && value <= upper)
            }
            Self::Set { values } => {
                let values = set_values(values, current, next)?;
                if let Some(first) = values.first() {
                    first.equal(value)?;
                }
                Ok(values.contains(&value))
            }
        }
    }
}

fn set_values(
    values: &[Expression],
    current: &[Scalar],
    next: &[Option<Scalar>],
) -> Result<Vec<Scalar>, CoreError> {
    let mut evaluated = values
        .iter()
        .map(|value| value.eval(current, next))
        .collect::<Result<Vec<_>, _>>()?;
    for pair in evaluated.windows(2) {
        pair[0].equal(pair[1])?;
    }
    evaluated.sort();
    evaluated.dedup();
    Ok(evaluated)
}

struct Node {
    values: Vec<Scalar>,
    parent: Option<usize>,
    action: Option<String>,
    depth: u32,
}

struct Search<'a> {
    program: &'a SafetyProgram,
    bounds: SafetyBounds,
    nodes: Vec<Node>,
    visited: HashMap<Vec<Scalar>, usize>,
    result: SafetyResult,
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
        for (phase, branches) in [(0, &self.initial), (1, &self.next)] {
            for branch in branches {
                if branch.steps.len() > 256 {
                    return Err(CoreError::protocol("Safety branch exceeds 256 steps"));
                }
                for step in &branch.steps {
                    match step {
                        Step::Guard { expression } => {
                            expression.validate(self.variables.len(), phase, 0)?
                        }
                        Step::Assign { slot, value } => {
                            self.slot(*slot)?;
                            value.validate(self.variables.len(), phase, 0)?;
                        }
                        Step::Choose { slot, domain } => {
                            self.slot(*slot)?;
                            domain.validate(self.variables.len(), phase, 0)?;
                        }
                    }
                }
            }
        }
        for predicate in &self.invariants {
            predicate.expression.validate(self.variables.len(), 2, 0)?;
        }
        for predicate in &self.assumptions {
            predicate.expression.validate(self.variables.len(), 3, 0)?;
            if !predicate.expression.eval(&[], &[])?.boolean()? {
                return Ok(SafetyResult {
                    status: "assumption-violation".into(),
                    reason: None,
                    states: 0,
                    generated: 0,
                    depth: 0,
                    work: 0,
                    violation: Some(SafetyViolation {
                        name: predicate.name.clone(),
                        trace: vec![],
                    }),
                });
            }
        }
        let mut search = Search {
            program: self,
            bounds,
            nodes: vec![],
            visited: HashMap::new(),
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
        for branch in &self.initial {
            search.walk(
                branch,
                0,
                &[],
                &mut vec![None; self.variables.len()],
                None,
                &mut false,
            )?;
            if search.stopped() {
                return Ok(search.result);
            }
        }
        if search.nodes.is_empty() {
            search.result.status = "empty".into();
            return Ok(search.result);
        }
        let mut index = 0;
        while index < search.nodes.len() {
            let current = search.nodes[index].values.clone();
            let mut enabled = false;
            for branch in &self.next {
                search.walk(
                    branch,
                    0,
                    &current,
                    &mut vec![None; self.variables.len()],
                    Some(index),
                    &mut enabled,
                )?;
                if search.stopped() {
                    return Ok(search.result);
                }
            }
            if !enabled && self.check_deadlock {
                search.result.status = "deadlock".into();
                search.result.reason = None;
                search.result.violation = Some(SafetyViolation {
                    name: "deadlock".into(),
                    trace: search.trace(index),
                });
                return Ok(search.result);
            }
            index += 1;
        }
        Ok(search.result)
    }
    fn slot(&self, slot: usize) -> Result<(), CoreError> {
        if slot >= self.variables.len() {
            return Err(CoreError::protocol("Invalid safety assignment slot"));
        }
        Ok(())
    }
}

impl Search<'_> {
    fn stopped(&self) -> bool {
        self.result.violation.is_some()
            || self.result.reason.as_deref() == Some("work")
            || self.result.reason.as_deref() == Some("states")
    }
    fn tick(&mut self) -> bool {
        if self.result.work == self.bounds.max_work {
            self.result.status = "bounded".into();
            self.result.reason = Some("work".into());
            return false;
        }
        self.result.work += 1;
        true
    }
    fn walk(
        &mut self,
        branch: &Branch,
        position: usize,
        current: &[Scalar],
        next: &mut [Option<Scalar>],
        parent: Option<usize>,
        enabled: &mut bool,
    ) -> Result<(), CoreError> {
        if !self.tick() {
            return Ok(());
        }
        let Some(step) = branch.steps.get(position) else {
            let values = next
                .iter()
                .map(|value| value.ok_or_else(|| CoreError::protocol("Incomplete safety state")))
                .collect::<Result<Vec<_>, _>>()?;
            *enabled = true;
            self.accept(values, parent, &branch.name)?;
            return Ok(());
        };
        match step {
            Step::Guard { expression } => {
                if expression.eval(current, next)?.boolean()? {
                    self.walk(branch, position + 1, current, next, parent, enabled)?;
                }
            }
            Step::Assign { slot, value } => {
                let value = value.eval(current, next)?;
                let previous = next[*slot];
                if previous
                    .map(|previous| previous.equal(value))
                    .transpose()?
                    .unwrap_or(true)
                {
                    next[*slot] = Some(value);
                    self.walk(branch, position + 1, current, next, parent, enabled)?;
                    next[*slot] = previous;
                }
            }
            Step::Choose { slot, domain } => {
                if let Some(value) = next[*slot] {
                    if domain.contains(value, current, next)? {
                        self.walk(branch, position + 1, current, next, parent, enabled)?;
                    }
                    return Ok(());
                }
                match domain {
                    Domain::Range { lower, upper } => {
                        let lower = lower.eval(current, next)?.integer()?;
                        let upper = upper.eval(current, next)?.integer()?;
                        for value in lower..=upper {
                            next[*slot] = Some(Scalar::Int(value));
                            self.walk(branch, position + 1, current, next, parent, enabled)?;
                            if self.stopped() {
                                break;
                            }
                        }
                    }
                    Domain::Set { values } => {
                        let values = set_values(values, current, next)?;
                        for value in values {
                            next[*slot] = Some(value);
                            self.walk(branch, position + 1, current, next, parent, enabled)?;
                            if self.stopped() {
                                break;
                            }
                        }
                    }
                }
                next[*slot] = None;
            }
        }
        Ok(())
    }
    fn accept(
        &mut self,
        values: Vec<Scalar>,
        parent: Option<usize>,
        action: &str,
    ) -> Result<(), CoreError> {
        self.result.generated += 1;
        if self.visited.contains_key(&values) {
            return Ok(());
        }
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
        let index = self.nodes.len();
        self.visited.insert(values.clone(), index);
        self.nodes.push(Node {
            values,
            parent,
            action: parent.map(|_| action.to_string()),
            depth,
        });
        self.result.states = self.nodes.len();
        self.result.depth = self.result.depth.max(depth);
        for predicate in &self.program.invariants {
            if !predicate
                .expression
                .eval(&self.nodes[index].values, &[])?
                .boolean()?
            {
                self.result.status = "invariant-violation".into();
                self.result.reason = None;
                self.result.violation = Some(SafetyViolation {
                    name: predicate.name.clone(),
                    trace: self.trace(index),
                });
                break;
            }
        }
        Ok(())
    }
    fn trace(&self, mut index: usize) -> Vec<SafetyTraceStep> {
        let mut trace = vec![];
        loop {
            let node = &self.nodes[index];
            trace.push(SafetyTraceStep {
                action: node.action.clone(),
                values: node.values.iter().map(|value| value.portable()).collect(),
            });
            match node.parent {
                Some(parent) => index = parent,
                None => break,
            }
        }
        trace.reverse();
        trace
    }
}
