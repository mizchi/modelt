package modelt

import (
	"context"
	"encoding/json"
)

// ModelHandle binds an indexed model to its owning Core. Close releases it.
// Handles cannot be transferred between instances; Core.Close also frees them.
type ModelHandle struct {
	core *Core
	id   uint32
}

func (core *Core) LoadModel(ctx context.Context, model json.RawMessage) (*ModelHandle, error) {
	output, err := core.request(ctx, map[string]any{"kind": "load-model", "model": model}, "loaded")
	if err != nil {
		return nil, err
	}
	return &ModelHandle{core: core, id: output.Handle}, nil
}

func (model *ModelHandle) Close(ctx context.Context) error {
	_, err := model.core.request(ctx, map[string]any{"kind": "release-model", "handle": model.id}, "released")
	return err
}

func (model *ModelHandle) CheckHistories(ctx context.Context, traces []Trace) ([]Result, error) {
	normalized := make([]Trace, len(traces))
	for index, trace := range traces {
		normalized[index] = traceArrays(trace)
	}
	output, err := model.core.request(ctx, map[string]any{"kind": "check-loaded", "handle": model.id, "traces": normalized}, "results")
	return output.Results, err
}

func (model *ModelHandle) CheckHistory(ctx context.Context, history ConcurrentHistory, maxNodes uint32) (ConcurrentResult, error) {
	if history.Events == nil {
		history.Events = []HistoryEvent{}
	}
	output, err := model.core.request(ctx, map[string]any{"kind": "check-history", "handle": model.id, "history": history, "maxNodes": maxNodes}, "history")
	return output.Result, err
}

// CheckHistoryJSON preserves the original wire fields and Unicode escapes for strict core validation.
// Use this when reading saved histories instead of decoding unknown fields away with encoding/json.
func (model *ModelHandle) CheckHistoryJSON(ctx context.Context, history json.RawMessage, maxNodes uint32) (ConcurrentResult, error) {
	output, err := model.core.request(ctx, map[string]any{"kind": "check-history", "handle": model.id, "history": history, "maxNodes": maxNodes}, "history")
	return output.Result, err
}

func (model *ModelHandle) Check(ctx context.Context, driver Driver, actions []Value) (Result, error) {
	if actions == nil {
		actions = []Value{}
	}
	return model.core.run(ctx, map[string]any{"kind": "start-loaded", "handle": model.id, "actions": actions}, nil, driver)
}
