// Package modelt connects Go models and implementations to modelt's portable Wasm core.
package modelt

import (
	"context"
	"encoding/json"
	"errors"
)

// Value is a tagged portable value, not ordinary JSON. Integers have decimal string payloads.
// Treat values and callback inputs as immutable snapshots. ValueOf encodes Go values.
type Value = json.RawMessage

type State struct {
	Key   string `json:"key"`
	State Value  `json:"state"`
}

type Transition struct {
	Key         string `json:"key"`
	State       Value  `json:"state"`
	Observation Value  `json:"observation"`
}

// Model returns all allowed candidates. Keys must preserve future behavior and observations.
// Empty transition slices mean an action is impossible, rather than a failed check.
type Model struct {
	Name    string
	Initial func(context.Context) ([]Transition, error)
	Step    func(context.Context, []State, Value) ([]Transition, error)
}

// Driver owns SUT execution and scheduling. Callbacks must honor context cancellation.
// Dispose is optional and runs once after an accepted check, including failures.
type Driver struct {
	Reset   func(context.Context) (Value, error)
	Step    func(context.Context, Value) (Value, error)
	Dispose func(context.Context) error
}

type Step struct {
	Action      Value `json:"action"`
	Observation Value `json:"observation"`
}

type Trace struct {
	Format  string `json:"format"`
	Version uint32 `json:"version"`
	Model   string `json:"model"`
	Initial Value  `json:"initial"`
	Steps   []Step `json:"steps"`
}

// Result distinguishes matched, mismatch and invalid. Only matched is success.
type Result struct {
	Status       string  `json:"status"`
	CheckedSteps uint32  `json:"checkedSteps"`
	Actual       Value   `json:"actual"`
	Expected     []Value `json:"expected"`
	Trace        Trace   `json:"trace"`
}

type DeletionRange struct {
	Start uint32 `json:"start"`
	Count uint32 `json:"count"`
}

// CoreError is a value or protocol rejection from the shared core.
type CoreError struct {
	Code    string
	Message string
}

func (err *CoreError) Error() string { return err.Code + ": " + err.Message }

// ErrBusy means this instance already has an active operation. Use one Core per worker.
var ErrBusy = errors.New("modelt: core is busy")
