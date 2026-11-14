use crate::CoreError;
use crate::safety::{Binding, Branch, Domain, Expression, Scalar, Step};
use crate::safety_values::Arena;

#[derive(Clone, Copy)]
pub(crate) struct EvalContext<'a> {
    pub current: &'a [Scalar],
    pub next: &'a [Option<Scalar>],
    pub locals: &'a [Scalar],
    pub old: Option<Scalar>,
    pub prime: bool,
}
impl<'a> EvalContext<'a> {
    pub fn new(current: &'a [Scalar], next: &'a [Option<Scalar>]) -> Self {
        Self {
            current,
            next,
            locals: &[],
            old: None,
            prime: false,
        }
    }
    fn read(self, slot: usize, next: bool) -> Result<Scalar, CoreError> {
        if next || self.prime {
            self.next
                .get(slot)
                .copied()
                .flatten()
                .ok_or_else(|| CoreError::protocol("Read of an unassigned next variable"))
        } else {
            self.current
                .get(slot)
                .copied()
                .ok_or_else(|| CoreError::protocol("Read of a missing current variable"))
        }
    }
}

#[derive(Clone, Copy)]
struct Validation {
    variables: usize,
    phase: u8,
    depth: usize,
    locals: usize,
    old: bool,
}
impl Validation {
    fn child(self) -> Self {
        Self {
            depth: self.depth + 1,
            ..self
        }
    }
}

pub(crate) enum Values {
    Range(std::ops::RangeInclusive<i32>),
    Items(std::vec::IntoIter<Scalar>),
}
impl Iterator for Values {
    type Item = Scalar;
    fn next(&mut self) -> Option<Scalar> {
        match self {
            Self::Range(values) => values.next().map(Scalar::Int),
            Self::Items(values) => values.next(),
        }
    }
}

impl Domain {
    fn children(&self) -> Vec<&Expression> {
        match self {
            Self::Range { lower, upper } => vec![lower, upper],
            Self::Set { values } => values.iter().collect(),
            Self::Value { value } => vec![value],
        }
    }
    fn validate(&self, context: Validation) -> Result<(), CoreError> {
        for value in self.children() {
            value.validate_with(context)?;
        }
        Ok(())
    }
    pub(crate) fn values(
        &self,
        ctx: EvalContext<'_>,
        arena: &mut Arena,
    ) -> Result<Values, CoreError> {
        Ok(match self {
            Self::Range { lower, upper } => Values::Range(
                lower.eval(ctx, arena)?.integer()?..=upper.eval(ctx, arena)?.integer()?,
            ),
            Self::Set { values } => {
                let values = values
                    .iter()
                    .map(|value| value.eval(ctx, arena))
                    .collect::<Result<Vec<_>, _>>()?;
                Values::Items(arena.ordered(values)?.into_iter())
            }
            Self::Value { value } => {
                let value = value.eval(ctx, arena)?;
                Values::Items(arena.members(value)?.into_iter())
            }
        })
    }
    pub(crate) fn contains(
        &self,
        value: Scalar,
        ctx: EvalContext<'_>,
        arena: &mut Arena,
    ) -> Result<bool, CoreError> {
        match self {
            Self::Range { lower, upper } => {
                let lower = lower.eval(ctx, arena)?.integer()?;
                let upper = upper.eval(ctx, arena)?.integer()?;
                if lower > upper {
                    return Ok(false);
                }
                let value = value.integer()?;
                Ok(lower <= value && value <= upper)
            }
            Self::Set { .. } => {
                let values = self.values(ctx, arena)?;
                for candidate in values {
                    if arena.equal(value, candidate)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Self::Value { value: set } => {
                let set = set.eval(ctx, arena)?;
                arena.contains(value, set)
            }
        }
    }
}

pub(crate) fn validate_branches(
    branches: &[Branch],
    variables: usize,
    phase: u8,
    locals: usize,
) -> Result<(), CoreError> {
    for branch in branches {
        if branch.steps.len() > 256 {
            return Err(CoreError::protocol("Safety branch exceeds 256 steps"));
        }
        let mut context = Validation {
            variables,
            phase,
            depth: 0,
            locals,
            old: false,
        };
        for step in &branch.steps {
            match step {
                Step::Guard { expression } => expression.validate_with(context)?,
                Step::Assign { slot, value } => {
                    if *slot >= variables {
                        return Err(CoreError::protocol("Invalid safety assignment slot"));
                    }
                    value.validate_with(context)?;
                }
                Step::Choose { slot, domain } => {
                    if *slot >= variables {
                        return Err(CoreError::protocol("Invalid safety assignment slot"));
                    }
                    domain.validate(context)?;
                }
                Step::Bind {
                    slot,
                    domain,
                    tuple_size,
                } => {
                    if *slot != context.locals || tuple_size.is_some_and(|size| size > 256) {
                        return Err(CoreError::protocol("Invalid bound variable slot"));
                    }
                    domain.validate(context)?;
                    context.locals += 1;
                }
            }
        }
    }
    Ok(())
}

impl Expression {
    fn children(&self) -> Vec<&Self> {
        match self {
            Self::Literal { .. }
            | Self::Data { .. }
            | Self::Read { .. }
            | Self::Bound { .. }
            | Self::Old => vec![],
            Self::Prime { argument }
            | Self::Not { argument }
            | Self::Neg { argument }
            | Self::Domain { argument }
            | Self::Cardinality { argument }
            | Self::SequenceSet { argument }
            | Self::Len { argument }
            | Self::Head { argument }
            | Self::Tail { argument }
            | Self::Powerset { argument }
            | Self::Union { argument } => vec![argument],
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
            | Self::Implies { left, right }
            | Self::Cup { left, right }
            | Self::Cap { left, right }
            | Self::Difference { left, right }
            | Self::SubsetEq { left, right }
            | Self::Append { left, right }
            | Self::Concat { left, right }
            | Self::FunctionSet { left, right }
            | Self::FunctionIn { left, right }
            | Self::SequenceIn { left, right } => vec![left, right],
            Self::If {
                condition,
                consequent,
                alternative,
            } => vec![condition, consequent, alternative],
            Self::In { value, domain } => {
                let mut children = vec![value.as_ref()];
                children.extend(domain.children());
                children
            }
            Self::Set { values } | Self::Tuple { values } => values.iter().collect(),
            Self::Record { fields } | Self::RecordSet { fields } => {
                fields.iter().map(|entry| &entry.1).collect()
            }
            Self::At { target, key } => vec![target, key],
            Self::Update { target, updates } => {
                let mut children = vec![target.as_ref()];
                for update in updates {
                    children.extend(update.path.iter());
                    children.push(&update.value);
                }
                children
            }
            Self::Forall { bounds, body }
            | Self::Exists { bounds, body }
            | Self::Function { bounds, body }
            | Self::Filter { bounds, body }
            | Self::MapSet { bounds, body } => {
                let mut children = vec![];
                for bound in bounds {
                    children.extend(bound.domain.children());
                }
                children.push(body);
                children
            }
            Self::Subseq { sequence, from, to } => vec![sequence, from, to],
            Self::Enabled { .. } => vec![],
        }
    }
    pub(crate) fn is_constant(&self) -> bool {
        !matches!(self, Self::Read { .. } | Self::Enabled { .. })
            && self.children().iter().all(|value| value.is_constant())
    }
    pub(crate) fn validate(
        &self,
        variables: usize,
        phase: u8,
        depth: usize,
    ) -> Result<(), CoreError> {
        self.validate_with(Validation {
            variables,
            phase,
            depth,
            locals: 0,
            old: false,
        })
    }
    fn validate_with(&self, ctx: Validation) -> Result<(), CoreError> {
        if ctx.depth > 48 {
            return Err(CoreError::protocol("Safety expression nesting exceeds 48"));
        }
        match self {
            Self::Prime { argument } => {
                if ctx.phase != 1 {
                    return Err(CoreError::protocol("Prime requires an action context"));
                }
                argument.validate_with(Validation {
                    phase: 2,
                    ..ctx.child()
                })?;
                return Ok(());
            }
            Self::Read { slot, next } => {
                if *slot >= ctx.variables
                    || (ctx.phase == 0 && !*next)
                    || (ctx.phase == 2 && *next)
                    || ctx.phase == 3
                {
                    return Err(CoreError::protocol("Invalid safety variable read"));
                }
            }
            Self::Bound { slot } => {
                if *slot >= ctx.locals {
                    return Err(CoreError::protocol("Unbound quantified variable"));
                }
            }
            Self::Old => {
                if !ctx.old {
                    return Err(CoreError::protocol("Unbound EXCEPT @"));
                }
            }
            Self::Forall { bounds, body }
            | Self::Exists { bounds, body }
            | Self::Function { bounds, body }
            | Self::Filter { bounds, body }
            | Self::MapSet { bounds, body } => {
                if bounds.is_empty() || bounds.len() > 40 {
                    return Err(CoreError::protocol("Empty binding list"));
                }
                let mut child = ctx.child();
                for bound in bounds {
                    if bound.slot != child.locals || bound.tuple_size.is_some_and(|size| size > 256)
                    {
                        return Err(CoreError::protocol("Invalid bound variable slot"));
                    }
                    bound.domain.validate(child)?;
                    child.locals += 1;
                }
                body.validate_with(child)?;
                return Ok(());
            }
            Self::Update { target, updates } => {
                target.validate_with(ctx.child())?;
                for update in updates {
                    if update.path.is_empty() || update.path.len() > 48 {
                        return Err(CoreError::protocol("Empty EXCEPT path"));
                    }
                    for part in &update.path {
                        part.validate_with(ctx.child())?;
                    }
                    update.value.validate_with(Validation {
                        old: true,
                        ..ctx.child()
                    })?;
                }
                return Ok(());
            }
            Self::Enabled {
                branches,
                subscript,
            } => {
                if ctx.phase == 3 {
                    return Err(CoreError::protocol("ENABLED is not a constant"));
                }
                validate_branches(branches, ctx.variables, 1, ctx.locals)?;
                if let Some(subscript) = subscript {
                    subscript.validate_with(Validation {
                        phase: 2,
                        ..ctx.child()
                    })?;
                }
                return Ok(());
            }
            _ => {}
        }
        for child in self.children() {
            child.validate_with(ctx.child())?;
        }
        Ok(())
    }
    pub(crate) fn eval(
        &self,
        ctx: EvalContext<'_>,
        arena: &mut Arena,
    ) -> Result<Scalar, CoreError> {
        Ok(match self {
            Self::Literal { value } => *value,
            Self::Data { value } => arena.data(value)?,
            Self::Read { slot, next } => ctx.read(*slot, *next)?,
            Self::Bound { slot } => *ctx
                .locals
                .get(*slot)
                .ok_or_else(|| CoreError::protocol("Unbound quantified variable"))?,
            Self::Old => ctx
                .old
                .ok_or_else(|| CoreError::protocol("Unbound EXCEPT @"))?,
            Self::Prime { argument } => argument.eval(EvalContext { prime: true, ..ctx }, arena)?,
            Self::Not { argument } => Scalar::Bool(!argument.eval(ctx, arena)?.boolean()?),
            Self::Neg { argument } => Scalar::Int(
                argument
                    .eval(ctx, arena)?
                    .integer()?
                    .checked_neg()
                    .ok_or_else(|| CoreError::protocol("Safety integer overflow"))?,
            ),
            Self::Add { left, right } | Self::Sub { left, right } | Self::Mul { left, right } => {
                let left = left.eval(ctx, arena)?.integer()?;
                let right = right.eval(ctx, arena)?.integer()?;
                Scalar::Int(
                    match self {
                        Self::Add { .. } => left.checked_add(right),
                        Self::Sub { .. } => left.checked_sub(right),
                        _ => left.checked_mul(right),
                    }
                    .ok_or_else(|| CoreError::protocol("Safety integer overflow"))?,
                )
            }
            Self::Eq { left, right } | Self::Ne { left, right } => {
                let left = left.eval(ctx, arena)?;
                let right = right.eval(ctx, arena)?;
                Scalar::Bool(arena.equal(left, right)? == matches!(self, Self::Eq { .. }))
            }
            Self::Lt { left, right }
            | Self::Le { left, right }
            | Self::Gt { left, right }
            | Self::Ge { left, right } => {
                let left = left.eval(ctx, arena)?.integer()?;
                let right = right.eval(ctx, arena)?.integer()?;
                Scalar::Bool(match self {
                    Self::Lt { .. } => left < right,
                    Self::Le { .. } => left <= right,
                    Self::Gt { .. } => left > right,
                    _ => left >= right,
                })
            }
            Self::And { left, right } => Scalar::Bool(
                left.eval(ctx, arena)?.boolean()? && right.eval(ctx, arena)?.boolean()?,
            ),
            Self::Or { left, right } => Scalar::Bool(
                left.eval(ctx, arena)?.boolean()? || right.eval(ctx, arena)?.boolean()?,
            ),
            Self::Implies { left, right } => Scalar::Bool(
                !left.eval(ctx, arena)?.boolean()? || right.eval(ctx, arena)?.boolean()?,
            ),
            Self::If {
                condition,
                consequent,
                alternative,
            } => if condition.eval(ctx, arena)?.boolean()? {
                consequent
            } else {
                alternative
            }
            .eval(ctx, arena)?,
            Self::In { value, domain } => {
                let value = value.eval(ctx, arena)?;
                Scalar::Bool(domain.contains(value, ctx, arena)?)
            }
            Self::Set { values } | Self::Tuple { values } => {
                let mut result = vec![];
                for value in values {
                    arena.tick()?;
                    result.push(value.eval(ctx, arena)?);
                }
                if matches!(self, Self::Set { .. }) {
                    arena.set(result)?
                } else {
                    arena.tuple(result)?
                }
            }
            Self::Record { fields } => {
                let mut result = vec![];
                for (name, value) in fields {
                    arena.tick()?;
                    let name = arena.string(name.clone())?;
                    let value = value.eval(ctx, arena)?;
                    result.push((name, value));
                }
                arena.function(result)?
            }
            Self::At { target, key } => {
                let target = target.eval(ctx, arena)?;
                let key = key.eval(ctx, arena)?;
                arena.at(target, key)?
            }
            Self::Update { target, updates } => {
                let mut result = target.eval(ctx, arena)?;
                for update in updates {
                    arena.tick()?;
                    let path = update
                        .path
                        .iter()
                        .map(|part| part.eval(ctx, arena))
                        .collect::<Result<Vec<_>, _>>()?;
                    if let Some(old) = arena.path(result, &path)? {
                        let value = update.value.eval(
                            EvalContext {
                                old: Some(old),
                                ..ctx
                            },
                            arena,
                        )?;
                        result = arena.replace(result, &path, value)?;
                    }
                }
                result
            }
            Self::Forall { bounds, body } | Self::Exists { bounds, body } => {
                let forall = matches!(self, Self::Forall { .. });
                let mut result = forall;
                visit_bindings(bounds, 0, ctx, arena, &mut |ctx, arena| {
                    let value = body.eval(ctx, arena)?.boolean()?;
                    if value != forall {
                        result = value;
                        Ok(false)
                    } else {
                        Ok(true)
                    }
                })?;
                Scalar::Bool(result)
            }
            Self::Function { bounds, body }
            | Self::Filter { bounds, body }
            | Self::MapSet { bounds, body } => {
                let mut values = vec![];
                let mut entries = vec![];
                visit_bindings(bounds, 0, ctx, arena, &mut |inner, arena| {
                    let value = body.eval(inner, arena)?;
                    if matches!(self, Self::Function { .. }) {
                        let keys = inner.locals[ctx.locals.len()..].to_vec();
                        let key = if keys.len() == 1 {
                            keys[0]
                        } else {
                            arena.tuple(keys)?
                        };
                        entries.push((key, value));
                    } else if matches!(self, Self::Filter { .. }) {
                        if value.boolean()? {
                            if bounds.len() != 1 {
                                return Err(CoreError::protocol("Filter requires one bound"));
                            }
                            values.push(inner.locals[ctx.locals.len()]);
                        }
                    } else {
                        values.push(value);
                    }
                    Ok(true)
                })?;
                if matches!(self, Self::Function { .. }) {
                    arena.function(entries)?
                } else {
                    arena.set(values)?
                }
            }
            Self::Domain { argument } => {
                let value = argument.eval(ctx, arena)?;
                arena.domain(value)?
            }
            Self::Cardinality { argument } => {
                let value = argument.eval(ctx, arena)?;
                Scalar::Int(
                    i32::try_from(arena.members(value)?.len())
                        .map_err(|_| CoreError::protocol("Set cardinality overflow"))?,
                )
            }
            Self::Len { argument } | Self::Head { argument } | Self::Tail { argument } => {
                let value = argument.eval(ctx, arena)?;
                if let Some(text) = arena.text(value) {
                    let units = text.encode_utf16().collect::<Vec<_>>();
                    return Ok(match self {
                        Self::Len { .. } => Scalar::Int(
                            i32::try_from(units.len())
                                .map_err(|_| CoreError::protocol("String length overflow"))?,
                        ),
                        Self::Head { .. } => {
                            let first = units
                                .first()
                                .ok_or_else(|| CoreError::protocol("Head of an empty string"))?;
                            arena.string_utf16(&[*first])?
                        }
                        _ => {
                            if units.is_empty() {
                                return Err(CoreError::protocol("Tail of an empty string"));
                            }
                            arena.string_utf16(&units[1..])?
                        }
                    });
                }
                let mut values = arena.sequence(value)?;
                match self {
                    Self::Len { .. } => Scalar::Int(values.len() as i32),
                    Self::Head { .. } => *values
                        .first()
                        .ok_or_else(|| CoreError::protocol("Head of an empty sequence"))?,
                    _ => {
                        if values.is_empty() {
                            return Err(CoreError::protocol("Tail of an empty sequence"));
                        }
                        values.remove(0);
                        arena.tuple(values)?
                    }
                }
            }
            Self::Append { left, right } | Self::Concat { left, right } => {
                let left = left.eval(ctx, arena)?;
                let right = right.eval(ctx, arena)?;
                if let Some(text) = arena.text(left) {
                    let suffix = arena.text(right).ok_or_else(|| {
                        CoreError::protocol("String concatenation requires strings")
                    })?;
                    let size = text
                        .len()
                        .checked_add(suffix.len())
                        .ok_or_else(|| CoreError::protocol("String length overflow"))?;
                    arena.consume(size)?;
                    let text = arena
                        .text(left)
                        .ok_or_else(|| CoreError::protocol("Expected a string"))?;
                    let suffix = arena
                        .text(right)
                        .ok_or_else(|| CoreError::protocol("Expected a string"))?;
                    let value = format!("{text}{suffix}");
                    return arena.string(value);
                }
                let mut values = arena.sequence_values(left)?;
                if matches!(self, Self::Append { .. }) {
                    values.push(right);
                } else {
                    values.extend(arena.sequence_values(right)?);
                }
                arena.tuple(values)?
            }
            Self::Subseq { sequence, from, to } => {
                let sequence = sequence.eval(ctx, arena)?;
                let from = from.eval(ctx, arena)?.integer()?;
                let to = to.eval(ctx, arena)?.integer()?;
                if let Some(text) = arena.text(sequence) {
                    let units = text.encode_utf16().collect::<Vec<_>>();
                    if from > to {
                        return arena.string(String::new());
                    }
                    if from < 1 || to as usize > units.len() {
                        return Err(CoreError::protocol("SubSeq bounds are outside the string"));
                    }
                    return arena.string_utf16(&units[(from - 1) as usize..to as usize]);
                }
                let values = arena.sequence(sequence)?;
                if from > to {
                    arena.tuple(vec![])?
                } else {
                    if from < 1 || to as usize > values.len() {
                        return Err(CoreError::protocol(
                            "SubSeq bounds are outside the sequence",
                        ));
                    }
                    arena.tuple(values[(from - 1) as usize..to as usize].to_vec())?
                }
            }
            Self::Cup { left, right }
            | Self::Cap { left, right }
            | Self::Difference { left, right }
            | Self::SubsetEq { left, right } => {
                let left = left.eval(ctx, arena)?;
                let right = right.eval(ctx, arena)?;
                let mut result = vec![];
                for value in arena.members(left)? {
                    arena.tick()?;
                    let contains = arena.contains(value, right)?;
                    if matches!(self, Self::SubsetEq { .. }) && !contains {
                        return Ok(Scalar::Bool(false));
                    }
                    if matches!(self, Self::Cup { .. })
                        || (matches!(self, Self::Cap { .. }) && contains)
                        || (matches!(self, Self::Difference { .. }) && !contains)
                    {
                        result.push(value);
                    }
                }
                if matches!(self, Self::SubsetEq { .. }) {
                    Scalar::Bool(true)
                } else {
                    if matches!(self, Self::Cup { .. }) {
                        result.extend(arena.members(right)?);
                    }
                    arena.set(result)?
                }
            }
            Self::Union { argument } => {
                let outer = argument.eval(ctx, arena)?;
                let mut values = vec![];
                for set in arena.members(outer)? {
                    arena.tick()?;
                    values.extend(arena.members(set)?);
                }
                arena.set(values)?
            }
            Self::Powerset { argument } => {
                let set = argument.eval(ctx, arena)?;
                let members = arena.members(set)?;
                let mut sets = vec![arena.set(vec![])?];
                for value in members {
                    let mut additions = vec![];
                    for set in &sets {
                        arena.tick()?;
                        let mut members = arena.members(*set)?;
                        members.push(value);
                        additions.push(arena.set(members)?);
                    }
                    sets.extend(additions);
                }
                arena.set(sets)?
            }
            Self::FunctionSet { left, right } => {
                let domain = left.eval(ctx, arena)?;
                let range = right.eval(ctx, arena)?;
                let keys = arena.members(domain)?;
                let values = arena.members(range)?;
                let mut functions = vec![];
                enumerate_functions(
                    &keys,
                    &vec![values.as_slice(); keys.len()],
                    arena,
                    &mut functions,
                )?;
                arena.set(functions)?
            }
            Self::RecordSet { fields } => {
                let mut keys = vec![];
                let mut ranges = vec![];
                for (name, set) in fields {
                    keys.push(arena.string(name.clone())?);
                    let set = set.eval(ctx, arena)?;
                    ranges.push(arena.members(set)?);
                }
                let mut functions = vec![];
                enumerate_functions(
                    &keys,
                    &ranges.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                    arena,
                    &mut functions,
                )?;
                arena.set(functions)?
            }
            Self::FunctionIn { left, right } => {
                let value = left.eval(ctx, arena)?;
                let set = MembershipSet::eval(right, ctx, arena)?;
                Scalar::Bool(set.contains(value, arena)?)
            }
            Self::SequenceIn { left, right } => {
                let value = left.eval(ctx, arena)?;
                let set =
                    MembershipSet::Sequences(Box::new(MembershipSet::eval(right, ctx, arena)?));
                Scalar::Bool(set.contains(value, arena)?)
            }
            Self::SequenceSet { .. } => {
                return Err(CoreError::protocol("Sequence sets cannot be enumerated"));
            }
            Self::Enabled {
                branches,
                subscript,
            } => {
                let current = if ctx.current.is_empty() || ctx.prime {
                    ctx.next
                        .iter()
                        .map(|value| {
                            value.ok_or_else(|| {
                                CoreError::protocol("ENABLED requires assigned initial variables")
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    ctx.current.to_vec()
                };
                let mut enabled = false;
                for branch in branches {
                    let mut next = vec![None; current.len()];
                    walk_enabled(
                        branch,
                        0,
                        EvalContext {
                            current: &current,
                            next: &[],
                            locals: ctx.locals,
                            old: None,
                            prime: false,
                        },
                        &mut next,
                        arena,
                        &mut |next, arena| {
                            if let Some(subscript) = subscript {
                                let context = EvalContext {
                                    locals: ctx.locals,
                                    ..EvalContext::new(&current, next)
                                };
                                let before = subscript.eval(context, arena)?;
                                let after = subscript.eval(
                                    EvalContext {
                                        prime: true,
                                        ..context
                                    },
                                    arena,
                                )?;
                                if arena.equal(before, after)? {
                                    return Ok(false);
                                }
                            }
                            enabled = true;
                            Ok(true)
                        },
                    )?;
                    if enabled {
                        break;
                    }
                }
                Scalar::Bool(enabled)
            }
        })
    }
}

enum MembershipSet {
    Finite(Scalar),
    Sequences(Box<Self>),
    Functions { domain: Scalar, range: Box<Self> },
    Records(Vec<(Scalar, Self)>),
    Subsets(Scalar),
}
impl MembershipSet {
    fn eval(
        expression: &Expression,
        ctx: EvalContext<'_>,
        arena: &mut Arena,
    ) -> Result<Self, CoreError> {
        Ok(match expression {
            Expression::SequenceSet { argument } => {
                Self::Sequences(Box::new(Self::eval(argument, ctx, arena)?))
            }
            Expression::FunctionSet { left, right } => Self::Functions {
                domain: left.eval(ctx, arena)?,
                range: Box::new(Self::eval(right, ctx, arena)?),
            },
            Expression::RecordSet { fields } => {
                let mut values = vec![];
                for (name, set) in fields {
                    let name = arena.string(name.clone())?;
                    let set = Self::eval(set, ctx, arena)?;
                    values.push((name, set));
                }
                values.sort_by(|left, right| arena.total(left.0, right.0));
                Self::Records(values)
            }
            Expression::Powerset { argument } => Self::Subsets(argument.eval(ctx, arena)?),
            _ => Self::Finite(expression.eval(ctx, arena)?),
        })
    }
    fn contains(&self, value: Scalar, arena: &mut Arena) -> Result<bool, CoreError> {
        match self {
            Self::Finite(set) => arena.contains(value, *set),
            Self::Subsets(set) => {
                for element in arena.members(value)? {
                    arena.tick()?;
                    if !arena.contains(element, *set)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Self::Sequences(set) => {
                for element in arena.sequence_values(value)? {
                    arena.tick()?;
                    if !set.contains(element, arena)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Self::Functions { domain, range } => {
                let entries = arena.entries(value)?;
                let actual = arena.domain(value)?;
                if !arena.equal(*domain, actual)? {
                    return Ok(false);
                }
                for (_, element) in entries {
                    arena.tick()?;
                    if !range.contains(element, arena)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Self::Records(fields) => {
                let entries = arena.entries(value)?;
                if entries.iter().any(|(key, _)| arena.text(*key).is_none()) {
                    return Err(CoreError::protocol(
                        "Record membership requires string keys",
                    ));
                }
                if entries.len() != fields.len() {
                    return Ok(false);
                }
                for (key, set) in fields {
                    let Some(element) = arena.select(value, *key)? else {
                        return Ok(false);
                    };
                    arena.tick()?;
                    if !set.contains(element, arena)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
        }
    }
}

fn visit_bindings(
    bindings: &[Binding],
    position: usize,
    ctx: EvalContext<'_>,
    arena: &mut Arena,
    visitor: &mut impl FnMut(EvalContext<'_>, &mut Arena) -> Result<bool, CoreError>,
) -> Result<bool, CoreError> {
    let Some(binding) = bindings.get(position) else {
        return visitor(ctx, arena);
    };
    let values = binding.domain.values(ctx, arena)?;
    let mut locals = ctx.locals.to_vec();
    if binding.slot != locals.len() {
        return Err(CoreError::protocol("Unbound variable slot"));
    }
    for value in values {
        arena.tick()?;
        arena.check_tuple(value, binding.tuple_size)?;
        locals.push(value);
        let keep = visit_bindings(
            bindings,
            position + 1,
            EvalContext {
                locals: &locals,
                ..ctx
            },
            arena,
            visitor,
        )?;
        locals.pop();
        if !keep {
            return Ok(false);
        }
    }
    Ok(true)
}

fn enumerate_functions(
    keys: &[Scalar],
    ranges: &[&[Scalar]],
    arena: &mut Arena,
    output: &mut Vec<Scalar>,
) -> Result<(), CoreError> {
    if ranges.iter().any(|range| range.is_empty()) {
        return Ok(());
    }
    let mut positions = vec![0; keys.len()];
    loop {
        arena.tick()?;
        let mut entries = Vec::with_capacity(keys.len());
        for (index, key) in keys.iter().enumerate() {
            arena.tick()?;
            entries.push((*key, ranges[index][positions[index]]));
        }
        output.push(arena.function(entries)?);
        let mut index = keys.len();
        loop {
            if index == 0 {
                return Ok(());
            }
            index -= 1;
            positions[index] += 1;
            if positions[index] < ranges[index].len() {
                break;
            }
            positions[index] = 0;
        }
    }
}

fn walk_enabled(
    branch: &Branch,
    position: usize,
    ctx: EvalContext<'_>,
    next: &mut [Option<Scalar>],
    arena: &mut Arena,
    visitor: &mut impl FnMut(&[Option<Scalar>], &mut Arena) -> Result<bool, CoreError>,
) -> Result<bool, CoreError> {
    arena.tick()?;
    let Some(step) = branch.steps.get(position) else {
        return visitor(next, arena);
    };
    let context = EvalContext { next, ..ctx };
    match step {
        Step::Guard { expression } => {
            if expression.eval(context, arena)?.boolean()? {
                walk_enabled(branch, position + 1, ctx, next, arena, visitor)
            } else {
                Ok(false)
            }
        }
        Step::Assign { slot, value } => {
            let value = value.eval(context, arena)?;
            let previous = next[*slot];
            if let Some(previous) = previous
                && !arena.equal(previous, value)?
            {
                return Ok(false);
            }
            next[*slot] = Some(value);
            let result = walk_enabled(branch, position + 1, ctx, next, arena, visitor);
            next[*slot] = previous;
            result
        }
        Step::Choose { slot, domain } => {
            if let Some(value) = next[*slot] {
                return if domain.contains(value, context, arena)? {
                    walk_enabled(branch, position + 1, ctx, next, arena, visitor)
                } else {
                    Ok(false)
                };
            }
            for value in domain.values(context, arena)? {
                next[*slot] = Some(value);
                let found = walk_enabled(branch, position + 1, ctx, next, arena, visitor)?;
                next[*slot] = None;
                if found {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Step::Bind {
            slot,
            domain,
            tuple_size,
        } => {
            let values = domain.values(context, arena)?;
            let mut locals = ctx.locals.to_vec();
            if *slot != locals.len() {
                return Err(CoreError::protocol("Unbound action variable"));
            }
            for value in values {
                arena.check_tuple(value, *tuple_size)?;
                locals.push(value);
                let found = walk_enabled(
                    branch,
                    position + 1,
                    EvalContext {
                        locals: &locals,
                        ..ctx
                    },
                    next,
                    arena,
                    visitor,
                )?;
                locals.pop();
                if found {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}
