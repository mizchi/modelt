package modelt_test

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"testing"

	modelt "github.com/mizchi/modelt/adapters/go"
)

func TestSharedPortableValues(t *testing.T) {
	core := loadCore(t)
	bytes, err := os.ReadFile("../../fixtures/portable-values.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Valid []struct {
			Name      string
			Input     modelt.Value
			Canonical string
		}
		Invalid []struct {
			Name  string
			Input modelt.Value
			JSON  string
		}
	}
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, entry := range fixture.Valid {
		t.Run(entry.Name, func(t *testing.T) {
			actual, err := core.Canonicalize(context.Background(), entry.Input)
			if err != nil {
				t.Fatal(err)
			}
			if string(actual) != entry.Canonical {
				t.Fatalf("got %s, want %s", actual, entry.Canonical)
			}
		})
	}
	for _, entry := range fixture.Invalid {
		t.Run(entry.Name, func(t *testing.T) {
			input := entry.Input
			if entry.JSON != "" {
				input = modelt.Value(entry.JSON)
			}
			if _, err := core.Canonicalize(context.Background(), input); err == nil {
				t.Fatal("invalid value accepted")
			}
		})
	}
}

func TestGoValueEncoding(t *testing.T) {
	large, ok := new(big.Int).SetString("9007199254740993123456789", 10)
	if !ok {
		t.Fatal("invalid test integer")
	}
	for _, entry := range []struct {
		Input    any
		Expected string
	}{
		{nil, `{"type":"null"}`},
		{false, `{"type":"bool","value":false}`},
		{"", `{"type":"string","value":""}`},
		{int64(-2), `{"type":"int","value":"-2"}`},
		{uint64(18446744073709551615), `{"type":"int","value":"18446744073709551615"}`},
		{large, `{"type":"int","value":"9007199254740993123456789"}`},
		{[]byte{}, `{"type":"bytes","value":""}`},
		{[]byte{0, 255}, `{"type":"bytes","value":"00ff"}`},
		{[]any{}, `{"type":"list","value":[]}`},
		{map[string]any{}, `{"type":"record","value":[]}`},
		{map[string]any{"😀": false, "\ue000": 2}, `{"type":"record","value":[["",{"type":"int","value":"2"}],["😀",{"type":"bool","value":false}]]}`},
	} {
		actual, err := modelt.ValueOf(entry.Input)
		if err != nil {
			t.Fatal(err)
		}
		if string(actual) != entry.Expected {
			t.Fatalf("got %s, want %s", actual, entry.Expected)
		}
	}
	cycle := map[string]any{}
	cycle["self"] = cycle
	for _, input := range []any{1.5, string([]byte{255}), map[string]any{string([]byte{255}): 1}, map[int]int{1: 2}, struct{ Field int }{1}, (*big.Int)(nil), cycle} {
		if _, err := modelt.ValueOf(input); err == nil {
			t.Fatalf("unsupported input accepted: %T", input)
		}
	}
}
