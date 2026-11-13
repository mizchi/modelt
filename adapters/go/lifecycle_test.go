package modelt_test

import (
	"context"
	"errors"
	"testing"

	modelt "github.com/mizchi/modelt/adapters/go"
)

func TestHistoryCandidatesAndInvalidActions(t *testing.T) {
	core := loadCore(t)
	model := modelt.Model{
		Name: "branches",
		Initial: func(context.Context) ([]modelt.Transition, error) {
			return []modelt.Transition{
				{Key: "left", State: value(t, "left"), Observation: value(t, 0)},
				{Key: "right", State: value(t, "right"), Observation: value(t, 0)},
			}, nil
		},
		Step: func(_ context.Context, states []modelt.State, action modelt.Value) ([]modelt.Transition, error) {
			if string(action) != string(value(t, "next")) {
				return nil, nil
			}
			transitions := make([]modelt.Transition, 0, len(states))
			for _, state := range states {
				observation := 1
				if state.Key == "right" {
					observation = 2
				}
				transitions = append(transitions, modelt.Transition{Key: state.Key, State: state.State, Observation: value(t, observation)})
			}
			return transitions, nil
		},
	}
	current := 0
	driver := modelt.Driver{
		Reset: func(context.Context) (modelt.Value, error) { current = 0; return value(t, current), nil },
		Step:  func(context.Context, modelt.Value) (modelt.Value, error) { current++; return value(t, current), nil },
	}
	result, err := core.Check(context.Background(), model, driver, []modelt.Value{value(t, "next"), value(t, "next")})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "mismatch" || result.CheckedSteps != 2 {
		t.Fatalf("inconsistent history accepted: %+v", result)
	}
	result, err = core.Check(context.Background(), model, driver, []modelt.Value{value(t, "unknown")})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "invalid" || current != 0 {
		t.Fatalf("invalid action executed: %+v, current %d", result, current)
	}
	model.Initial = func(context.Context) ([]modelt.Transition, error) { return nil, nil }
	resets := 0
	driver.Reset = func(context.Context) (modelt.Value, error) {
		resets++
		return value(t, 7), nil
	}
	result, err = core.Check(context.Background(), model, driver, nil)
	if err != nil || result.Status != "invalid" || result.CheckedSteps != 0 || resets != 1 || string(result.Actual) != string(value(t, 7)) {
		t.Fatalf("empty model passed: %+v, %v", result, err)
	}
}

func TestCallbackFailuresCancelAndDispose(t *testing.T) {
	core := loadCore(t)
	failure := errors.New("SUT failure")
	disposeFailure := errors.New("cleanup failure")
	for _, location := range []string{"initial", "model-step", "reset", "driver-step", "invalid-value", "cancel"} {
		t.Run(location, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			model := counterModel(t)
			disposed := 0
			driver := counterDriver(t, true, &disposed)
			switch location {
			case "initial":
				model.Initial = func(context.Context) ([]modelt.Transition, error) { return nil, failure }
			case "model-step":
				model.Step = func(context.Context, []modelt.State, modelt.Value) ([]modelt.Transition, error) { return nil, failure }
			case "reset":
				driver.Reset = func(context.Context) (modelt.Value, error) { return nil, failure }
			case "driver-step":
				driver.Step = func(context.Context, modelt.Value) (modelt.Value, error) { return nil, failure }
			case "invalid-value":
				driver.Step = func(context.Context, modelt.Value) (modelt.Value, error) {
					return modelt.Value(`{"type":"int","value":"01"}`), nil
				}
			case "cancel":
				driver.Step = func(context.Context, modelt.Value) (modelt.Value, error) { cancel(); return value(t, 1), nil }
			}
			driver.Dispose = func(cleanup context.Context) error {
				if err := cleanup.Err(); err != nil {
					t.Errorf("cleanup context cancelled: %v", err)
				}
				disposed++
				return disposeFailure
			}
			_, err := core.Check(ctx, model, driver, []modelt.Value{value(t, "add")})
			if err == nil || !errors.Is(err, disposeFailure) || disposed != 1 {
				t.Fatalf("lost error/cleanup: %v, %d", err, disposed)
			}
			if location == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation: %v", err)
			}
			if location != "cancel" && location != "invalid-value" && !errors.Is(err, failure) {
				t.Fatalf("lost callback error: %v", err)
			}
			result, err := core.Check(context.Background(), counterModel(t), counterDriver(t, true, &disposed), nil)
			if err != nil || result.Status != "matched" {
				t.Fatalf("session leaked after failure: %+v, %v", result, err)
			}
		})
	}
}

func TestPanicStillDisposesAndCancels(t *testing.T) {
	core := loadCore(t)
	disposed := 0
	driver := counterDriver(t, true, &disposed)
	driver.Step = func(context.Context, modelt.Value) (modelt.Value, error) { panic("SUT panic") }
	func() {
		defer func() {
			if recovered := recover(); recovered != "SUT panic" {
				t.Errorf("unexpected panic %v", recovered)
			}
		}()
		_, _ = core.Check(context.Background(), counterModel(t), driver, []modelt.Value{value(t, "add")})
	}()
	if disposed != 1 {
		t.Fatal("panic skipped cleanup")
	}
	result, err := core.Check(context.Background(), counterModel(t), counterDriver(t, true, &disposed), nil)
	if err != nil || result.Status != "matched" {
		t.Fatalf("panic leaked session: %+v %v", result, err)
	}
}

func TestConcurrentAndReentrantUseIsRejected(t *testing.T) {
	core := loadCore(t)
	disposed := 0
	driver := counterDriver(t, true, &disposed)
	entered, release := make(chan struct{}), make(chan struct{})
	driver.Reset = func(ctx context.Context) (modelt.Value, error) {
		if _, err := core.Canonicalize(ctx, value(t, 0)); !errors.Is(err, modelt.ErrBusy) {
			t.Errorf("reentry: %v", err)
		}
		close(entered)
		<-release
		return value(t, 0), nil
	}
	done := make(chan error, 1)
	go func() { _, err := core.Check(context.Background(), counterModel(t), driver, nil); done <- err }()
	<-entered
	if err := core.Close(context.Background()); !errors.Is(err, modelt.ErrBusy) {
		t.Errorf("close during session: %v", err)
	}
	if _, err := core.Check(context.Background(), counterModel(t), modelt.Driver{}, nil); !errors.Is(err, modelt.ErrBusy) {
		t.Errorf("concurrent start: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if disposed != 1 {
		t.Fatal("concurrent run skipped cleanup")
	}
}

func TestInvalidModulesAndClosedRuntime(t *testing.T) {
	for _, wasm := range [][]byte{nil, {0, 97, 115, 109, 1, 0, 0, 0}} {
		if core, err := modelt.New(context.Background(), wasm); err == nil {
			_ = core.Close(context.Background())
			t.Fatal("non-core module accepted")
		}
	}
	core := loadCore(t)
	if err := core.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := core.Canonicalize(context.Background(), value(t, 0)); err == nil {
		t.Fatal("closed runtime accepted operation")
	}
}

func TestMalformedArtifactsAndEmptyReplay(t *testing.T) {
	core := loadCore(t)
	ctx := context.Background()
	if _, err := core.CheckHistories(ctx, modelt.Value(`{"format":"modelt.finite-model","version":2}`), nil); err == nil {
		t.Fatal("malformed model accepted")
	}
	disposed := 0
	trace := modelt.Trace{Format: "modelt.portable-trace", Version: 1, Model: "empty", Initial: value(t, 0)}
	result, err := core.Replay(ctx, trace, counterDriver(t, true, &disposed))
	if err != nil || result.Status != "matched" || disposed != 1 {
		t.Fatalf("empty replay: %+v %v", result, err)
	}
	trace.Version = 2
	if _, err := core.Replay(ctx, trace, counterDriver(t, true, &disposed)); err == nil {
		t.Fatal("unsupported trace accepted")
	}
	if disposed != 2 {
		t.Fatal("malformed trace skipped cleanup")
	}
	trace.Version = 1
	if _, err := core.Replay(ctx, trace, counterDriver(t, true, &disposed)); err != nil {
		t.Fatalf("malformed trace leaked session: %v", err)
	}
}

func TestInvalidUnicodeDoesNotCollapseModelKeys(t *testing.T) {
	core := loadCore(t)
	for _, location := range []string{"name", "key", "trace"} {
		disposed := 0
		model := counterModel(t)
		switch location {
		case "name":
			model.Name = string([]byte{255})
		case "key":
			model.Initial = func(context.Context) ([]modelt.Transition, error) {
				return []modelt.Transition{{Key: string([]byte{255}), State: value(t, 0), Observation: value(t, 0)}}, nil
			}
		}
		var err error
		if location == "trace" {
			_, err = core.Replay(context.Background(), modelt.Trace{Format: "modelt.portable-trace", Version: 1, Model: string([]byte{255}), Initial: value(t, 0)}, counterDriver(t, true, &disposed))
		} else {
			_, err = core.Check(context.Background(), model, counterDriver(t, true, &disposed), nil)
		}
		if err == nil || disposed != 1 {
			t.Fatalf("invalid Unicode %s was accepted or leaked: %v %d", location, err, disposed)
		}
	}
}
