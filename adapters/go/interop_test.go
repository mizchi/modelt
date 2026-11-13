package modelt_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	modelt "github.com/mizchi/modelt/adapters/go"
)

func assertJSONEqual(t *testing.T, actual, expected any) {
	t.Helper()
	decode := func(input any) any {
		encoded, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		var output any
		// Portable integers remain tagged decimal strings; only small protocol counters are numbers.
		if err := json.Unmarshal(encoded, &output); err != nil {
			t.Fatal(err)
		}
		return output
	}
	if !reflect.DeepEqual(decode(actual), decode(expected)) {
		t.Fatalf("got %+v, want %+v", actual, expected)
	}
}

func TestTSFiniteModelsAndHostTapes(t *testing.T) {
	core := loadCore(t)
	bytes, err := os.ReadFile("../../.artifacts/go/fixtures.json")
	if err != nil {
		t.Fatalf("run just go-test to prepare TS fixtures: %v", err)
	}
	var fixture struct {
		Version    uint32
		WasmSha256 string
		Batches    []struct {
			Name  string
			Model json.RawMessage
			Cases []struct {
				History  modelt.Trace
				Expected modelt.Result
			}
		}
		Host struct {
			Tape     json.RawMessage
			Snapshot modelt.Value
		}
		Candidates []struct {
			Length uint32
			Ranges []modelt.DeletionRange
		}
	}
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	wasm, err := os.ReadFile("../../crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(wasm)
	if fixture.Version != 1 || fixture.WasmSha256 != hex.EncodeToString(digest[:]) {
		t.Fatal("fixture belongs to a different core")
	}
	ctx := context.Background()
	comparisons := 0
	for _, batch := range fixture.Batches {
		t.Run(batch.Name, func(t *testing.T) {
			traces := make([]modelt.Trace, len(batch.Cases))
			for index, entry := range batch.Cases {
				traces[index] = entry.History
			}
			results, err := core.CheckHistories(ctx, batch.Model, traces)
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != len(batch.Cases) {
				t.Fatal("missing result")
			}
			for index, entry := range batch.Cases {
				assertJSONEqual(t, results[index], entry.Expected)
				comparisons++
				position, disposed := 0, 0
				driver := modelt.Driver{
					Reset: func(context.Context) (modelt.Value, error) { position = 0; return entry.History.Initial, nil },
					Step: func(_ context.Context, action modelt.Value) (modelt.Value, error) {
						if position >= len(entry.History.Steps) {
							t.Fatal("unexpected SUT step")
						}
						step := entry.History.Steps[position]
						assertJSONEqual(t, action, step.Action)
						position++
						return step.Observation, nil
					},
					Dispose: func(context.Context) error { disposed++; return nil },
				}
				actions := make([]modelt.Value, len(entry.History.Steps))
				for index, step := range entry.History.Steps {
					actions[index] = step.Action
				}
				result, err := core.CheckFinite(ctx, batch.Model, driver, actions)
				if err != nil {
					t.Fatal(err)
				}
				assertJSONEqual(t, result, entry.Expected)
				if disposed != 1 {
					t.Fatal("finite driver leaked")
				}
				comparisons++
			}
		})
	}
	snapshot, err := core.ReplayHost(ctx, fixture.Host.Tape)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, snapshot, fixture.Host.Snapshot)
	for _, entry := range fixture.Candidates {
		ranges, err := core.DeletionCandidates(ctx, entry.Length)
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, ranges, entry.Ranges)
	}
	if comparisons != 18 {
		t.Fatalf("missing comparisons: %d", comparisons)
	}
	t.Logf("%d full result comparisons, 17 shrink cases, one host snapshot", comparisons)
}
