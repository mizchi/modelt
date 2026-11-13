package modelt_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"

	modelt "github.com/mizchi/modelt/adapters/go"
)

func loadCore(t *testing.T) *modelt.Core {
	t.Helper()
	wasm, err := os.ReadFile("../../crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm")
	if err != nil {
		t.Fatal(err)
	}
	core, err := modelt.New(context.Background(), wasm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := core.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return core
}

func value(t *testing.T, input any) modelt.Value {
	t.Helper()
	result, err := modelt.ValueOf(input)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func counterModel(t *testing.T) modelt.Model {
	return modelt.Model{
		Name: "durability",
		Initial: func(context.Context) ([]modelt.Transition, error) {
			return []modelt.Transition{{Key: "0,0", State: value(t, []any{0, 0}), Observation: value(t, 0)}}, nil
		},
		Step: func(_ context.Context, states []modelt.State, action modelt.Value) ([]modelt.Transition, error) {
			var transitions []modelt.Transition
			for _, state := range states {
				var encoded struct{ Value []struct{ Value string } }
				if err := json.Unmarshal(state.State, &encoded); err != nil {
					return nil, err
				}
				var current, stored int
				if _, err := fmt.Sscan(encoded.Value[0].Value, &current); err != nil {
					return nil, err
				}
				if _, err := fmt.Sscan(encoded.Value[1].Value, &stored); err != nil {
					return nil, err
				}
				switch string(action) {
				case string(value(t, "add")):
					current++
					stored = current
				case string(value(t, "crash")):
					current = 0
				case string(value(t, "restart")):
					current = stored
				default:
					continue
				}
				transitions = append(transitions, modelt.Transition{Key: fmt.Sprintf("%d,%d", current, stored), State: value(t, []any{current, stored}), Observation: value(t, current)})
			}
			return transitions, nil
		},
	}
}

func counterDriver(t *testing.T, persist bool, disposed *int) modelt.Driver {
	var memory, disk int
	return modelt.Driver{
		Reset: func(context.Context) (modelt.Value, error) { memory, disk = 0, 0; return value(t, memory), nil },
		Step: func(_ context.Context, action modelt.Value) (modelt.Value, error) {
			switch string(action) {
			case string(value(t, "add")):
				memory++
				if persist {
					disk = memory
				}
			case string(value(t, "crash")):
				memory = 0
			case string(value(t, "restart")):
				memory = disk
			default:
				return nil, errors.New("unknown action")
			}
			return value(t, memory), nil
		},
		Dispose: func(context.Context) error { *disposed++; return nil },
	}
}

func TestConformanceAndSavedOracle(t *testing.T) {
	core := loadCore(t)
	ctx := context.Background()
	actions := []modelt.Value{value(t, "add"), value(t, "crash"), value(t, "restart")}
	for _, persist := range []bool{true, false} {
		disposed := 0
		result, err := core.Check(ctx, counterModel(t), counterDriver(t, persist, &disposed), actions)
		if err != nil {
			t.Fatal(err)
		}
		status := "matched"
		if !persist {
			status = "mismatch"
		}
		if result.Status != status || result.CheckedSteps != 3 || disposed != 1 {
			t.Fatalf("unexpected result %+v, disposed %d", result, disposed)
		}
	}
	disposed := 0
	oracle, err := core.Check(ctx, counterModel(t), counterDriver(t, true, &disposed), actions)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(oracle.Trace)
	if err != nil {
		t.Fatal(err)
	}
	var saved modelt.Trace
	if err := json.Unmarshal(encoded, &saved); err != nil {
		t.Fatal(err)
	}
	broken, err := core.Replay(ctx, saved, counterDriver(t, false, &disposed))
	if err != nil {
		t.Fatal(err)
	}
	if broken.Status != "mismatch" || broken.CheckedSteps != 3 || !reflect.DeepEqual(broken.Expected, []modelt.Value{value(t, 1)}) {
		t.Fatalf("unexpected replay %+v", broken)
	}
}
