use crate::safety::Scalar;
use crate::{CoreError, Value};
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Cell {
    String(String),
    Set(Vec<Scalar>),
    Function(Vec<(Scalar, Scalar)>),
}

pub(crate) struct Arena {
    cells: Vec<Cell>,
    depths: Vec<u8>,
    index: HashMap<Cell, u32>,
    data: HashMap<Value, Scalar>,
    pub work: u32,
    maximum: u32,
}

impl Arena {
    pub fn new(maximum: u32) -> Self {
        Self {
            cells: vec![],
            depths: vec![],
            index: HashMap::new(),
            data: HashMap::new(),
            work: 0,
            maximum,
        }
    }
    pub fn tick(&mut self) -> Result<(), CoreError> {
        if self.work == self.maximum {
            return Err(CoreError {
                code: "budget",
                message: "Safety work budget exhausted".into(),
            });
        }
        self.work += 1;
        Ok(())
    }
    fn cell(&self, value: Scalar) -> Result<&Cell, CoreError> {
        match value {
            Scalar::Ref(index) => self
                .cells
                .get(index as usize)
                .ok_or_else(|| CoreError::protocol("Invalid interned value")),
            _ => Err(CoreError::protocol("Expected a collection or string")),
        }
    }
    fn intern(&mut self, cell: Cell) -> Result<Scalar, CoreError> {
        if let Some(index) = self.index.get(&cell) {
            return Ok(Scalar::Ref(*index));
        }
        let depth = |value: &Scalar| match value {
            Scalar::Ref(index) => self.depths[*index as usize],
            _ => 0,
        };
        let depth = match &cell {
            Cell::String(_) => 0,
            Cell::Set(values) => 1 + values.iter().map(depth).max().unwrap_or(0),
            Cell::Function(values) => {
                1 + values
                    .iter()
                    .flat_map(|(key, value)| [key, value])
                    .map(depth)
                    .max()
                    .unwrap_or(0)
            }
        };
        if depth > 64 {
            return Err(CoreError::protocol("TLA value nesting exceeds 64"));
        }
        self.tick()?;
        let index = u32::try_from(self.cells.len())
            .map_err(|_| CoreError::protocol("Value store exhausted"))?;
        self.index.insert(cell.clone(), index);
        self.cells.push(cell);
        self.depths.push(depth);
        Ok(Scalar::Ref(index))
    }
    pub fn string(&mut self, value: String) -> Result<Scalar, CoreError> {
        self.intern(Cell::String(value))
    }
    pub fn data(&mut self, value: &Value) -> Result<Scalar, CoreError> {
        if let Some(result) = self.data.get(value) {
            return Ok(*result);
        }
        let result = match value {
            Value::Bool(_) | Value::Int(_) => Scalar::parse(value)?,
            Value::String(value) => self.string(value.clone())?,
            Value::List(values) => {
                let values = values
                    .iter()
                    .map(|value| self.data(value))
                    .collect::<Result<Vec<_>, _>>()?;
                self.tuple(values)?
            }
            Value::Set(values) => {
                let values = values
                    .iter()
                    .map(|value| self.data(value))
                    .collect::<Result<Vec<_>, _>>()?;
                self.set(values)?
            }
            Value::Record(values) => {
                let mut entries = vec![];
                for (name, value) in values {
                    let name = self.string(name.clone())?;
                    let value = self.data(value)?;
                    entries.push((name, value));
                }
                self.function(entries)?
            }
            Value::Map(values) => {
                let mut entries = vec![];
                for (key, value) in values {
                    let key = self.data(key)?;
                    let value = self.data(value)?;
                    entries.push((key, value));
                }
                self.function(entries)?
            }
            _ => return Err(CoreError::protocol("Unsupported TLA data value")),
        };
        self.data.insert(value.clone(), result);
        Ok(result)
    }
    fn rank(&self, value: Scalar) -> u8 {
        match value {
            Scalar::Bool(_) => 0,
            Scalar::Int(_) => 1,
            Scalar::Ref(index) => match self.cells.get(index as usize) {
                Some(Cell::String(_)) => 2,
                Some(Cell::Set(_)) => 3,
                _ => 4,
            },
        }
    }
    fn total(&self, left: Scalar, right: Scalar) -> Ordering {
        let rank = self.rank(left).cmp(&self.rank(right));
        if rank != Ordering::Equal {
            return rank;
        }
        match (left, right) {
            (Scalar::Bool(left), Scalar::Bool(right)) => left.cmp(&right),
            (Scalar::Int(left), Scalar::Int(right)) => left.cmp(&right),
            _ => match (self.cell(left), self.cell(right)) {
                (Ok(Cell::String(left)), Ok(Cell::String(right))) => {
                    left.encode_utf16().cmp(right.encode_utf16())
                }
                (Ok(Cell::Set(left)), Ok(Cell::Set(right))) => left
                    .len()
                    .cmp(&right.len())
                    .then_with(|| self.compare_lists(left, right)),
                (Ok(Cell::Function(left)), Ok(Cell::Function(right))) => {
                    let size = left.len().cmp(&right.len());
                    if size != Ordering::Equal {
                        return size;
                    }
                    for ((left_key, _), (right_key, _)) in left.iter().zip(right) {
                        let comparison = self.total(*left_key, *right_key);
                        if comparison != Ordering::Equal {
                            return comparison;
                        }
                    }
                    for ((_, left_value), (_, right_value)) in left.iter().zip(right) {
                        let comparison = self.total(*left_value, *right_value);
                        if comparison != Ordering::Equal {
                            return comparison;
                        }
                    }
                    Ordering::Equal
                }
                _ => Ordering::Equal,
            },
        }
    }
    fn compare_lists(&self, left: &[Scalar], right: &[Scalar]) -> Ordering {
        for (left, right) in left.iter().zip(right) {
            let result = self.total(*left, *right);
            if result != Ordering::Equal {
                return result;
            }
        }
        left.len().cmp(&right.len())
    }
    pub fn comparable(&self, left: Scalar, right: Scalar) -> Result<(), CoreError> {
        if self.rank(left) != self.rank(right) {
            return Err(CoreError::protocol("Incomparable TLA values"));
        }
        let pairs: Vec<(Scalar, Scalar)> = match (self.cell(left), self.cell(right)) {
            (Ok(Cell::Set(left)), Ok(Cell::Set(right))) if left.len() == right.len() => {
                left.iter().copied().zip(right.iter().copied()).collect()
            }
            (Ok(Cell::Function(left)), Ok(Cell::Function(right))) if left.len() == right.len() => {
                left.iter()
                    .zip(right)
                    .map(|(left, right)| (left.0, right.0))
                    .chain(
                        left.iter()
                            .zip(right)
                            .map(|(left, right)| (left.1, right.1)),
                    )
                    .collect()
            }
            _ => vec![],
        };
        for (left, right) in pairs {
            self.comparable(left, right)?;
            if self.total(left, right) != Ordering::Equal {
                break;
            }
        }
        Ok(())
    }
    pub fn equal(&self, left: Scalar, right: Scalar) -> Result<bool, CoreError> {
        if left == right {
            return Ok(true);
        }
        if self.rank(left) != self.rank(right) {
            return Err(CoreError::protocol("Incomparable TLA values"));
        }
        match (self.cell(left), self.cell(right)) {
            (Ok(Cell::Function(left)), Ok(Cell::Function(right))) => {
                if left.len() != right.len() {
                    return Ok(false);
                }
                for (left, right) in left.iter().zip(right) {
                    if !self.equal(left.0, right.0)? {
                        return Ok(false);
                    }
                }
                for (left, right) in left.iter().zip(right) {
                    if !self.equal(left.1, right.1)? {
                        return Ok(false);
                    }
                }
            }
            (Ok(Cell::Set(left)), Ok(Cell::Set(right))) => {
                if left.len() != right.len() {
                    return Ok(false);
                }
                for (left, right) in left.iter().zip(right) {
                    if !self.equal(*left, *right)? {
                        return Ok(false);
                    }
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
    pub fn set(&mut self, mut values: Vec<Scalar>) -> Result<Scalar, CoreError> {
        values = self.ordered(values)?;
        self.intern(Cell::Set(values))
    }
    pub fn ordered(&self, mut values: Vec<Scalar>) -> Result<Vec<Scalar>, CoreError> {
        values.sort_by(|left, right| self.total(*left, *right));
        for pair in values.windows(2) {
            self.comparable(pair[0], pair[1])?;
        }
        values.dedup();
        Ok(values)
    }
    pub fn tuple(&mut self, values: Vec<Scalar>) -> Result<Scalar, CoreError> {
        self.function(
            values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    Ok((
                        Scalar::Int(
                            i32::try_from(index + 1)
                                .map_err(|_| CoreError::protocol("Sequence too long"))?,
                        ),
                        value,
                    ))
                })
                .collect::<Result<_, CoreError>>()?,
        )
    }
    pub fn function(&mut self, mut values: Vec<(Scalar, Scalar)>) -> Result<Scalar, CoreError> {
        values.sort_by(|left, right| self.total(left.0, right.0));
        for pair in values.windows(2) {
            self.comparable(pair[0].0, pair[1].0)?;
            if pair[0].0 == pair[1].0 {
                return Err(CoreError::protocol("Duplicate function key"));
            }
        }
        self.intern(Cell::Function(values))
    }
    pub fn members(&self, value: Scalar) -> Result<Vec<Scalar>, CoreError> {
        match self.cell(value)? {
            Cell::Set(values) => Ok(values.clone()),
            _ => Err(CoreError::protocol("Expected a finite set")),
        }
    }
    pub fn contains(&self, value: Scalar, set: Scalar) -> Result<bool, CoreError> {
        let Cell::Set(values) = self.cell(set)? else {
            return Err(CoreError::protocol("Membership requires a finite set"));
        };
        for candidate in values {
            if self.equal(value, *candidate)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn select(&self, function: Scalar, key: Scalar) -> Result<Option<Scalar>, CoreError> {
        let Cell::Function(values) = self.cell(function)? else {
            return Err(CoreError::protocol("Expected a function"));
        };
        Ok(values
            .iter()
            .find(|entry| entry.0 == key)
            .map(|entry| entry.1))
    }
    pub fn at(&self, function: Scalar, key: Scalar) -> Result<Scalar, CoreError> {
        self.select(function, key)?
            .ok_or_else(|| CoreError::protocol("Function argument is outside its domain"))
    }
    pub fn domain(&mut self, function: Scalar) -> Result<Scalar, CoreError> {
        let Cell::Function(values) = self.cell(function)? else {
            return Err(CoreError::protocol("DOMAIN requires a function"));
        };
        self.set(values.iter().map(|entry| entry.0).collect())
    }
    pub fn entries(&self, function: Scalar) -> Result<Vec<(Scalar, Scalar)>, CoreError> {
        match self.cell(function)? {
            Cell::Function(values) => Ok(values.clone()),
            _ => Err(CoreError::protocol("Expected a function")),
        }
    }
    pub fn check_tuple(&self, value: Scalar, size: Option<usize>) -> Result<(), CoreError> {
        if let Some(size) = size
            && self.sequence(value)?.len() != size
        {
            return Err(CoreError::protocol(
                "Bound tuple pattern has the wrong length",
            ));
        }
        Ok(())
    }
    pub fn sequence(&self, value: Scalar) -> Result<Vec<Scalar>, CoreError> {
        let values = self.entries(value)?;
        if !values
            .iter()
            .enumerate()
            .all(|(index, entry)| entry.0 == Scalar::Int((index + 1) as i32))
        {
            return Err(CoreError::protocol("Expected a sequence"));
        }
        Ok(values.into_iter().map(|entry| entry.1).collect())
    }
    pub fn replace(
        &mut self,
        function: Scalar,
        path: &[Scalar],
        value: Scalar,
    ) -> Result<Scalar, CoreError> {
        let Some((first, rest)) = path.split_first() else {
            return Ok(value);
        };
        let mut entries = self.entries(function)?;
        if let Some(entry) = entries.iter_mut().find(|entry| entry.0 == *first) {
            entry.1 = self.replace(entry.1, rest, value)?;
        }
        self.function(entries)
    }
    pub fn path(&self, mut function: Scalar, path: &[Scalar]) -> Result<Option<Scalar>, CoreError> {
        for key in path {
            let Some(value) = self.select(function, *key)? else {
                return Ok(None);
            };
            function = value;
        }
        Ok(Some(function))
    }
    pub fn portable(&self, value: Scalar) -> Result<Value, CoreError> {
        Ok(match value {
            Scalar::Int(value) => Value::Int(value.to_string()),
            Scalar::Bool(value) => Value::Bool(value),
            _ => match self.cell(value)? {
                Cell::String(value) => Value::String(value.clone()),
                Cell::Set(values) => Value::Set(
                    values
                        .iter()
                        .map(|value| self.portable(*value))
                        .collect::<Result<_, _>>()?,
                )
                .normalize()?,
                Cell::Function(values) => {
                    if values
                        .iter()
                        .enumerate()
                        .all(|(index, entry)| entry.0 == Scalar::Int((index + 1) as i32))
                    {
                        Value::List(
                            values
                                .iter()
                                .map(|entry| self.portable(entry.1))
                                .collect::<Result<_, _>>()?,
                        )
                    } else if values
                        .iter()
                        .all(|entry| matches!(self.cell(entry.0), Ok(Cell::String(_))))
                    {
                        Value::Record(
                            values
                                .iter()
                                .map(|entry| {
                                    let Cell::String(name) = self.cell(entry.0)? else {
                                        unreachable!()
                                    };
                                    Ok((name.clone(), self.portable(entry.1)?))
                                })
                                .collect::<Result<_, CoreError>>()?,
                        )
                        .normalize()?
                    } else {
                        Value::Map(
                            values
                                .iter()
                                .map(|entry| Ok((self.portable(entry.0)?, self.portable(entry.1)?)))
                                .collect::<Result<_, CoreError>>()?,
                        )
                        .normalize()?
                    }
                }
            },
        })
    }
}
