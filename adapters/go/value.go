package modelt

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"unicode/utf8"
)

// ValueOf encodes nil, bool, Unicode strings, Go integers, big.Int, []byte,
// slices, arrays and maps with string keys. Floats and structs are rejected.
// Use a raw Value for portable sets/maps. Canonicalize validates and normalizes it.
func ValueOf(input any) (Value, error) {
	// encoding/json detects cycles before the recursive tagged conversion.
	if _, err := json.Marshal(input); err != nil {
		return nil, err
	}
	encoded, err := encodeValue(reflect.ValueOf(input))
	if err != nil {
		return nil, err
	}
	return json.Marshal(encoded)
}

type taggedValue struct {
	Type  string `json:"type"`
	Value any    `json:"value,omitempty"`
}

func encodeValue(input reflect.Value) (any, error) {
	if !input.IsValid() {
		return taggedValue{Type: "null"}, nil
	}
	if input.Kind() == reflect.Interface {
		return encodeValue(input.Elem())
	}
	if input.CanInterface() {
		switch value := input.Interface().(type) {
		case json.RawMessage:
			if !utf8.Valid(value) || !json.Valid(value) {
				return nil, fmt.Errorf("modelt: invalid raw portable JSON")
			}
			return value, nil
		case big.Int:
			return taggedValue{Type: "int", Value: value.String()}, nil
		case *big.Int:
			if value == nil {
				return nil, fmt.Errorf("modelt: nil big.Int")
			}
			return taggedValue{Type: "int", Value: value.String()}, nil
		case []byte:
			return taggedValue{Type: "bytes", Value: hex.EncodeToString(value)}, nil
		}
	}
	switch input.Kind() {
	case reflect.Bool:
		return taggedValue{Type: "bool", Value: input.Bool()}, nil
	case reflect.String:
		if !utf8.ValidString(input.String()) {
			return nil, fmt.Errorf("modelt: invalid Unicode string")
		}
		return taggedValue{Type: "string", Value: input.String()}, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return taggedValue{Type: "int", Value: strconv.FormatInt(input.Int(), 10)}, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return taggedValue{Type: "int", Value: strconv.FormatUint(input.Uint(), 10)}, nil
	case reflect.Slice, reflect.Array:
		values := make([]any, input.Len())
		for index := range values {
			value, err := encodeValue(input.Index(index))
			if err != nil {
				return nil, err
			}
			values[index] = value
		}
		return taggedValue{Type: "list", Value: values}, nil
	case reflect.Map:
		if input.Type().Key().Kind() != reflect.String {
			return nil, fmt.Errorf("modelt: record keys must be strings")
		}
		keys := input.MapKeys()
		sort.Slice(keys, func(left, right int) bool { return keys[left].String() < keys[right].String() })
		fields := make([][2]any, 0, len(keys))
		for _, key := range keys {
			if !utf8.ValidString(key.String()) {
				return nil, fmt.Errorf("modelt: invalid Unicode record key")
			}
			value, err := encodeValue(input.MapIndex(key))
			if err != nil {
				return nil, err
			}
			fields = append(fields, [2]any{key.String(), value})
		}
		return taggedValue{Type: "record", Value: fields}, nil
	default:
		return nil, fmt.Errorf("modelt: unsupported Go value %s", input.Type())
	}
}
