package modelt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

func (core *Core) Check(ctx context.Context, model Model, driver Driver, actions []Value) (Result, error) {
	if actions == nil {
		actions = []Value{}
	}
	return core.run(ctx, map[string]any{"kind": "start", "model": model.Name, "actions": actions}, &model, driver)
}

func (core *Core) CheckFinite(ctx context.Context, model json.RawMessage, driver Driver, actions []Value) (Result, error) {
	if actions == nil {
		actions = []Value{}
	}
	return core.run(ctx, map[string]any{"kind": "start-finite", "model": model, "actions": actions}, nil, driver)
}

// Replay executes the stored oracle against a fresh Driver, preserving its expected observations.
func (core *Core) Replay(ctx context.Context, trace Trace, driver Driver) (Result, error) {
	trace = traceArrays(trace)
	return core.run(ctx, map[string]any{"kind": "replay", "trace": trace}, nil, driver)
}

func traceArrays(trace Trace) Trace {
	if trace.Steps == nil {
		trace.Steps = []Step{}
	}
	return trace
}

func (core *Core) run(ctx context.Context, request any, model *Model, driver Driver) (result Result, err error) {
	if !core.mu.TryLock() {
		return Result{}, ErrBusy
	}
	defer core.mu.Unlock()
	var pending uint32
	defer func() {
		cleanup := context.WithoutCancel(ctx)
		if pending != 0 {
			_, cancelErr := core.exchange(cleanup, map[string]any{"kind": "cancel", "id": pending})
			err = errors.Join(err, cancelErr)
		}
		if driver.Dispose != nil {
			err = errors.Join(err, driver.Dispose(cleanup))
		}
	}()
	if driver.Reset == nil || driver.Step == nil {
		return Result{}, fmt.Errorf("modelt: Driver requires Reset and Step")
	}
	if model != nil && (model.Initial == nil || model.Step == nil) {
		return Result{}, fmt.Errorf("modelt: Model requires Initial and Step")
	}
	output, err := core.exchange(ctx, request)
	if err != nil {
		return Result{}, err
	}
	for {
		if output.Kind != "effect" {
			return Result{}, fmt.Errorf("modelt: expected effect, received %s", output.Kind)
		}
		current := output.Effect
		if current.Kind == "done" {
			pending = 0
			return current.Result, nil
		}
		if current.ID == 0 {
			return Result{}, fmt.Errorf("modelt: invalid effect ID")
		}
		pending = current.ID
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		response, err := respond(ctx, current, model, driver)
		if err != nil {
			return Result{}, err
		}
		output, err = core.exchange(ctx, map[string]any{"kind": "resume", "id": pending, "response": response})
		if err != nil {
			return Result{}, err
		}
	}
}

func respond(ctx context.Context, current effect, model *Model, driver Driver) (any, error) {
	switch current.Kind {
	case "model-initial", "model-step":
		if model == nil {
			return nil, fmt.Errorf("modelt: unexpected model callback")
		}
		var transitions []Transition
		var err error
		if current.Kind == "model-initial" {
			transitions, err = model.Initial(ctx)
		} else {
			transitions, err = model.Step(ctx, current.States, current.Action)
		}
		if err != nil {
			return nil, err
		}
		if transitions == nil {
			transitions = []Transition{}
		}
		return map[string]any{"kind": "transitions", "transitions": transitions}, nil
	case "driver-reset", "driver-step":
		var observation Value
		var err error
		if current.Kind == "driver-reset" {
			observation, err = driver.Reset(ctx)
		} else {
			observation, err = driver.Step(ctx, current.Action)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": "observation", "observation": observation}, nil
	default:
		return nil, fmt.Errorf("modelt: unknown effect %s", current.Kind)
	}
}
