use crate::CoreError;
use crate::safety::{
    Expression, SafetyBounds, SafetyProgram, SafetyTraceStep, SafetyViolation, Scalar,
};
use crate::safety_expressions::EvalContext;
use crate::safety_values::Arena;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TemporalFormula {
    Atom { expression: Expression },
    Not { formula: Box<Self> },
    Always { formula: Box<Self> },
    Eventually { formula: Box<Self> },
    And { left: Box<Self>, right: Box<Self> },
    Or { left: Box<Self>, right: Box<Self> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemporalProperty {
    pub name: String,
    pub formula: TemporalFormula,
}
impl TemporalFormula {
    pub(crate) fn validate(&self, variables: usize, depth: usize) -> Result<(), CoreError> {
        if depth > 40 {
            return Err(CoreError::protocol("Temporal formula nesting exceeds 40"));
        }
        match self {
            Self::Atom { expression } => expression.validate(variables, 1, 0)?,
            Self::Not { formula } | Self::Always { formula } | Self::Eventually { formula } => {
                formula.validate(variables, depth + 1)?
            }
            Self::And { left, right } | Self::Or { left, right } => {
                left.validate(variables, depth + 1)?;
                right.validate(variables, depth + 1)?;
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy)]
pub(crate) struct GraphEdge {
    pub target: usize,
    pub action: Option<usize>,
}

enum Formula<'a> {
    True,
    False,
    Atom(&'a Expression, bool),
    And(usize, usize),
    Or(usize, usize),
    Until(usize, usize),
    Release(usize, usize),
}
struct Pool<'a> {
    formulas: Vec<Formula<'a>>,
    until: Vec<usize>,
}
impl<'a> Pool<'a> {
    fn add(&mut self, formula: Formula<'a>) -> usize {
        let index = self.formulas.len();
        if matches!(formula, Formula::Until(..)) {
            self.until.push(index);
        }
        self.formulas.push(formula);
        index
    }
    fn lower(&mut self, formula: &'a TemporalFormula, negative: bool) -> usize {
        match formula {
            TemporalFormula::Atom { expression } => self.add(Formula::Atom(expression, negative)),
            TemporalFormula::Not { formula } => self.lower(formula, !negative),
            TemporalFormula::And { left, right } | TemporalFormula::Or { left, right } => {
                let left = self.lower(left, negative);
                let right = self.lower(right, negative);
                if matches!(formula, TemporalFormula::And { .. }) != negative {
                    self.add(Formula::And(left, right))
                } else {
                    self.add(Formula::Or(left, right))
                }
            }
            TemporalFormula::Always { formula: inner }
            | TemporalFormula::Eventually { formula: inner } => {
                let child = self.lower(inner, negative);
                if matches!(formula, TemporalFormula::Eventually { .. }) != negative {
                    let truth = self.add(Formula::True);
                    self.add(Formula::Until(truth, child))
                } else {
                    let falsity = self.add(Formula::False);
                    self.add(Formula::Release(falsity, child))
                }
            }
        }
    }
}
#[derive(Clone)]
struct Expansion {
    todo: Vec<usize>,
    seen: HashSet<usize>,
    next: Vec<usize>,
    pending: Vec<usize>,
}
struct Alternative {
    next: Vec<usize>,
    pending: Vec<usize>,
}
fn expand(
    pool: &Pool<'_>,
    required: &[usize],
    ctx: EvalContext<'_>,
    arena: &mut Arena,
) -> Result<Vec<Alternative>, CoreError> {
    let mut stack = vec![Expansion {
        todo: required.to_vec(),
        seen: HashSet::new(),
        next: vec![],
        pending: vec![],
    }];
    let mut result = vec![];
    'alternative: while let Some(mut state) = stack.pop() {
        while let Some(id) = state.todo.pop() {
            arena.tick()?;
            if !state.seen.insert(id) {
                continue;
            }
            match &pool.formulas[id] {
                Formula::True => {}
                Formula::False => continue 'alternative,
                Formula::Atom(expression, negative) => {
                    if expression.eval(ctx, arena)?.boolean()? == *negative {
                        continue 'alternative;
                    }
                }
                Formula::And(left, right) => {
                    state.todo.push(*right);
                    state.todo.push(*left);
                }
                Formula::Or(left, right) => {
                    let mut other = state.clone();
                    other.todo.push(*right);
                    stack.push(other);
                    state.todo.push(*left);
                }
                Formula::Until(left, right) => {
                    let mut other = state.clone();
                    other.todo.push(*left);
                    other.next.push(id);
                    other.pending.push(id);
                    stack.push(other);
                    state.todo.push(*right);
                }
                Formula::Release(left, right) => {
                    let mut other = state.clone();
                    other.todo.push(*right);
                    other.next.push(id);
                    stack.push(other);
                    state.todo.push(*right);
                    state.todo.push(*left);
                }
            }
        }
        state.next.sort_unstable();
        state.next.dedup();
        state.pending.retain(|id| match pool.formulas[*id] {
            Formula::Until(_, right) => !state.seen.contains(&right),
            _ => false,
        });
        state.pending.sort_unstable();
        state.pending.dedup();
        result.push(Alternative {
            next: state.next,
            pending: state.pending,
        });
    }
    Ok(result)
}
#[derive(Clone)]
struct ProductEdge {
    target: usize,
    action: Option<usize>,
    pending: Vec<usize>,
}
struct ProductNode {
    state: usize,
    required: Vec<usize>,
    parent: Option<(usize, usize)>,
}
struct Cycle {
    entry: usize,
    edges: Vec<(usize, usize)>,
}
struct Product<'a> {
    pool: Pool<'a>,
    nodes: Vec<ProductNode>,
    edges: Vec<Vec<ProductEdge>>,
    lookup: HashMap<(usize, Vec<usize>), usize>,
    maximum: usize,
}
impl Product<'_> {
    fn node(
        &mut self,
        state: usize,
        required: Vec<usize>,
        parent: Option<(usize, usize)>,
    ) -> Result<usize, CoreError> {
        if let Some(index) = self.lookup.get(&(state, required.clone())) {
            return Ok(*index);
        }
        if self.nodes.len() == self.maximum {
            return Err(CoreError {
                code: "temporal-budget",
                message: "Temporal product node budget exhausted".into(),
            });
        }
        let index = self.nodes.len();
        self.lookup.insert((state, required.clone()), index);
        self.nodes.push(ProductNode {
            state,
            required,
            parent,
        });
        self.edges.push(vec![]);
        Ok(index)
    }
    fn components(&self, arena: &mut Arena) -> Result<Vec<Vec<usize>>, CoreError> {
        let mut visited = vec![false; self.nodes.len()];
        let mut order = vec![];
        for root in 0..self.nodes.len() {
            if visited[root] {
                continue;
            }
            visited[root] = true;
            let mut stack = vec![(root, 0)];
            while let Some((node, position)) = stack.last_mut() {
                arena.tick()?;
                if let Some(edge) = self.edges[*node].get(*position) {
                    *position += 1;
                    if !visited[edge.target] {
                        visited[edge.target] = true;
                        stack.push((edge.target, 0));
                    }
                } else {
                    order.push(*node);
                    stack.pop();
                }
            }
        }
        let mut reverse = vec![vec![]; self.nodes.len()];
        for (source, edges) in self.edges.iter().enumerate() {
            for edge in edges {
                arena.tick()?;
                reverse[edge.target].push(source);
            }
        }
        visited.fill(false);
        let mut components = vec![];
        for root in order.into_iter().rev() {
            if visited[root] {
                continue;
            }
            visited[root] = true;
            let mut component = vec![];
            let mut stack = vec![root];
            while let Some(node) = stack.pop() {
                arena.tick()?;
                component.push(node);
                for parent in &reverse[node] {
                    if !visited[*parent] {
                        visited[*parent] = true;
                        stack.push(*parent);
                    }
                }
            }
            component.sort_unstable();
            components.push(component);
        }
        Ok(components)
    }
    fn path(
        &self,
        start: usize,
        end: usize,
        members: &HashSet<usize>,
        arena: &mut Arena,
    ) -> Result<Vec<(usize, usize)>, CoreError> {
        if start == end {
            return Ok(vec![]);
        }
        let mut queue = VecDeque::from([start]);
        let mut parents = HashMap::from([(start, None)]);
        while let Some(source) = queue.pop_front() {
            arena.tick()?;
            for (index, edge) in self.edges[source].iter().enumerate() {
                if members.contains(&edge.target) && !parents.contains_key(&edge.target) {
                    parents.insert(edge.target, Some((source, index)));
                    if edge.target == end {
                        let mut path = vec![];
                        let mut node = end;
                        while let Some(Some((source, index))) = parents.get(&node) {
                            path.push((*source, *index));
                            node = *source;
                        }
                        path.reverse();
                        return Ok(path);
                    }
                    queue.push_back(edge.target);
                }
            }
        }
        Err(CoreError::protocol("Broken temporal component"))
    }
    fn accepting_cycle(&self, arena: &mut Arena) -> Result<Option<Cycle>, CoreError> {
        for component in self.components(arena)? {
            let entry = component[0];
            let members: HashSet<_> = component.iter().copied().collect();
            if component.len() == 1 && !self.edges[entry].iter().any(|edge| edge.target == entry) {
                continue;
            }
            let mut selected = vec![];
            let mut accepting = true;
            for until in &self.pool.until {
                let mut witness = None;
                'find: for source in &component {
                    for (index, edge) in self.edges[*source].iter().enumerate() {
                        arena.tick()?;
                        if members.contains(&edge.target) && !edge.pending.contains(until) {
                            witness = Some((*source, index));
                            break 'find;
                        }
                    }
                }
                if let Some(edge) = witness {
                    selected.push(edge);
                } else {
                    accepting = false;
                    break;
                }
            }
            if !accepting {
                continue;
            }
            if selected.is_empty() {
                let Some(index) = self.edges[entry]
                    .iter()
                    .position(|edge| members.contains(&edge.target))
                else {
                    continue;
                };
                selected.push((entry, index));
            }
            let mut current = entry;
            let mut cycle = vec![];
            for (source, index) in selected {
                cycle.extend(self.path(current, source, &members, arena)?);
                cycle.push((source, index));
                current = self.edges[source][index].target;
            }
            cycle.extend(self.path(current, entry, &members, arena)?);
            return Ok(Some(Cycle {
                entry,
                edges: cycle,
            }));
        }
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn check(
    program: &SafetyProgram,
    bounds: SafetyBounds,
    values: &[Scalar],
    width: usize,
    graph: &[Vec<GraphEdge>],
    roots: &[usize],
    arena: &mut Arena,
) -> Result<Option<SafetyViolation>, CoreError> {
    for property in &program.properties {
        let mut pool = Pool {
            formulas: vec![],
            until: vec![],
        };
        let mut root = pool.lower(&property.formula, true);
        for fairness in &program.fairness {
            let fairness = pool.lower(fairness, false);
            root = pool.add(Formula::And(fairness, root));
        }
        let mut product = Product {
            pool,
            nodes: vec![],
            edges: vec![],
            lookup: HashMap::new(),
            maximum: bounds.max_temporal_nodes.unwrap_or(bounds.max_states) as usize,
        };
        for state in roots {
            product.node(*state, vec![root], None)?;
        }
        let mut index = 0;
        while index < product.nodes.len() {
            arena.tick()?;
            let source = product.nodes[index].state;
            let required = product.nodes[index].required.clone();
            for edge in &graph[source] {
                let current = &values[source * width..(source + 1) * width];
                let next: Vec<_> = values[edge.target * width..(edge.target + 1) * width]
                    .iter()
                    .copied()
                    .map(Some)
                    .collect();
                for alternative in expand(
                    &product.pool,
                    &required,
                    EvalContext::new(current, &next),
                    arena,
                )? {
                    arena.tick()?;
                    let ordinal = product.edges[index].len();
                    let target =
                        product.node(edge.target, alternative.next, Some((index, ordinal)))?;
                    product.edges[index].push(ProductEdge {
                        target,
                        action: edge.action,
                        pending: alternative.pending,
                    });
                }
            }
            index += 1;
        }
        if let Some(cycle) = product.accepting_cycle(arena)? {
            let entry = cycle.entry;
            let cycle = cycle.edges;
            let mut prefix = vec![];
            let mut current = entry;
            while let Some((source, index)) = product.nodes[current].parent {
                prefix.push((source, index));
                current = source;
            }
            prefix.reverse();
            let mut trace = vec![SafetyTraceStep {
                action: None,
                values: values[product.nodes[current].state * width
                    ..(product.nodes[current].state + 1) * width]
                    .iter()
                    .map(|value| arena.portable(*value))
                    .collect::<Result<_, _>>()?,
            }];
            let label = |action: Option<usize>| {
                action
                    .map(|index| program.next[index].name.clone())
                    .unwrap_or_else(|| "<stuttering>".into())
            };
            for (source, index) in &prefix {
                let edge = &product.edges[*source][*index];
                let state = product.nodes[edge.target].state;
                trace.push(SafetyTraceStep {
                    action: Some(label(edge.action)),
                    values: values[state * width..(state + 1) * width]
                        .iter()
                        .map(|value| arena.portable(*value))
                        .collect::<Result<_, _>>()?,
                });
            }
            let loop_start = trace.len() - 1;
            for (source, index) in cycle.iter().take(cycle.len() - 1) {
                let edge = &product.edges[*source][*index];
                let state = product.nodes[edge.target].state;
                trace.push(SafetyTraceStep {
                    action: Some(label(edge.action)),
                    values: values[state * width..(state + 1) * width]
                        .iter()
                        .map(|value| arena.portable(*value))
                        .collect::<Result<_, _>>()?,
                });
            }
            let (source, index) = cycle[cycle.len() - 1];
            return Ok(Some(SafetyViolation {
                name: property.name.clone(),
                trace,
                loop_start: Some(loop_start),
                loop_action: Some(label(product.edges[source][index].action)),
            }));
        }
    }
    Ok(None)
}
