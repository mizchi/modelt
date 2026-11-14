use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum Value {
    Null,
    Bool(bool),
    Int(String),
    String(String),
    Bytes(String),
    List(Vec<Value>),
    Record(Vec<(String, Value)>),
    Set(Vec<Value>),
    Map(Vec<(Value, Value)>),
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValueVisitor;
        impl<'de> serde::de::Visitor<'de> for ValueVisitor {
            type Value = Value;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a tagged portable value")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Value, M::Error> {
                let mut kind: Option<String> = None;
                let mut payload: Option<serde_json::Value> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "type" if kind.is_none() => kind = Some(map.next_value()?),
                        "value" if payload.is_none() => payload = Some(map.next_value()?),
                        _ => {
                            return Err(serde::de::Error::custom(
                                "Duplicate or unknown value field",
                            ));
                        }
                    }
                }
                let kind = kind.ok_or_else(|| serde::de::Error::missing_field("type"))?;
                if kind == "null" {
                    return if payload.is_none() {
                        Ok(Value::Null)
                    } else {
                        Err(serde::de::Error::custom("Null has no payload"))
                    };
                }
                let payload = payload.ok_or_else(|| serde::de::Error::missing_field("value"))?;
                match kind.as_str() {
                    "bool" => serde_json::from_value(payload).map(Value::Bool),
                    "int" => serde_json::from_value(payload).map(Value::Int),
                    "string" => serde_json::from_value(payload).map(Value::String),
                    "bytes" => serde_json::from_value(payload).map(Value::Bytes),
                    "list" => serde_json::from_value(payload).map(Value::List),
                    "set" => serde_json::from_value(payload).map(Value::Set),
                    "record" => serde_json::from_value(payload).map(Value::Record),
                    "map" => serde_json::from_value(payload).map(Value::Map),
                    _ => return Err(serde::de::Error::custom("Unknown value kind")),
                }
                .map_err(serde::de::Error::custom)
            }
        }
        deserializer.deserialize_map(ValueVisitor)
    }
}

#[derive(Debug)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
}
impl CoreError {
    pub fn protocol(message: &str) -> Self {
        Self {
            code: "protocol",
            message: message.into(),
        }
    }
    fn value(message: &str) -> Self {
        Self {
            code: "value",
            message: message.into(),
        }
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}

impl Value {
    pub fn normalize(self) -> Result<Self, CoreError> {
        match self {
            Self::Int(value) => {
                let digits = value.strip_prefix('-').unwrap_or(&value);
                if value != "0"
                    && (digits.is_empty()
                        || digits.starts_with('0')
                        || !digits.bytes().all(|byte| byte.is_ascii_digit()))
                {
                    return Err(CoreError::value("Noncanonical integer"));
                }
                Ok(Self::Int(value))
            }
            Self::Bytes(value) => {
                if !value.len().is_multiple_of(2)
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(CoreError::value("Invalid lowercase hex bytes"));
                }
                Ok(Self::Bytes(value))
            }
            Self::List(values) => Ok(Self::List(
                values
                    .into_iter()
                    .map(Self::normalize)
                    .collect::<Result<_, _>>()?,
            )),
            Self::Set(values) => {
                let mut entries = BTreeMap::new();
                for value in values {
                    let value = value.normalize()?;
                    entries.insert(
                        serde_json::to_string(&value).expect("serializable value"),
                        value,
                    );
                }
                Ok(Self::Set(entries.into_values().collect()))
            }
            Self::Record(fields) => {
                let mut entries = BTreeMap::new();
                for (name, value) in fields {
                    if entries.insert(name, value.normalize()?).is_some() {
                        return Err(CoreError::value("Duplicate record field"));
                    }
                }
                Ok(Self::Record(entries.into_iter().collect()))
            }
            Self::Map(values) => {
                let mut entries = BTreeMap::new();
                for (key, value) in values {
                    let key = key.normalize()?;
                    let encoded = serde_json::to_string(&key).expect("serializable value");
                    if entries.insert(encoded, (key, value.normalize()?)).is_some() {
                        return Err(CoreError::value("Duplicate map key"));
                    }
                }
                Ok(Self::Map(entries.into_values().collect()))
            }
            value => Ok(value),
        }
    }
}
