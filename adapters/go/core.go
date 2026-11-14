package modelt

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sync"
	"unicode/utf8"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Core owns one Wasm instance. Operations reject concurrent or reentrant use.
// Separate instances may run concurrently. Close releases all runtime resources.
type Core struct {
	mu      sync.Mutex
	runtime wazero.Runtime
	module  api.Module
	memory  api.Memory
}

// New loads ABI v1 bytes without WASI, host imports, CGO or subprocesses.
// No deadline is added. Cancelling a Wasm call closes that instance.
func New(ctx context.Context, wasm []byte) (*Core, error) {
	runtime := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithCloseOnContextDone(true))
	module, err := runtime.Instantiate(ctx, wasm)
	if err != nil {
		_ = runtime.Close(context.WithoutCancel(ctx))
		return nil, err
	}
	core := &Core{runtime: runtime, module: module, memory: module.ExportedMemory("memory")}
	for name, signature := range map[string][2]int{
		"modelt_abi_version": {0, 1}, "modelt_input_resize": {1, 1},
		"modelt_dispatch": {0, 0}, "modelt_output_ptr": {0, 1}, "modelt_output_len": {0, 1},
	} {
		function := module.ExportedFunction(name)
		if function == nil || len(function.Definition().ParamTypes()) != signature[0] || len(function.Definition().ResultTypes()) != signature[1] {
			_ = core.Close(context.WithoutCancel(ctx))
			return nil, fmt.Errorf("modelt: invalid ABI export %s", name)
		}
		for _, kind := range append(append([]api.ValueType{}, function.Definition().ParamTypes()...), function.Definition().ResultTypes()...) {
			if kind != api.ValueTypeI32 {
				_ = core.Close(context.WithoutCancel(ctx))
				return nil, fmt.Errorf("modelt: non-i32 ABI export %s", name)
			}
		}
	}
	version, err := core.call(ctx, "modelt_abi_version")
	if err != nil || version != 1 || core.memory == nil {
		_ = core.Close(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("modelt: unsupported Wasm ABI")
	}
	return core, nil
}

func (core *Core) Close(ctx context.Context) error {
	if !core.mu.TryLock() {
		return ErrBusy
	}
	defer core.mu.Unlock()
	return core.runtime.Close(ctx)
}

type effect struct {
	Kind   string  `json:"kind"`
	ID     uint32  `json:"id"`
	States []State `json:"states"`
	Action Value   `json:"action"`
	Result Result  `json:"result"`
}

type message struct {
	Kind     string           `json:"kind"`
	Code     string           `json:"code"`
	Message  string           `json:"message"`
	Value    Value            `json:"value"`
	Effect   effect           `json:"effect"`
	Results  []Result         `json:"results"`
	Ranges   []DeletionRange  `json:"ranges"`
	Snapshot Value            `json:"snapshot"`
	Handle   uint32           `json:"handle"`
	Result   ConcurrentResult `json:"result"`
}

func (core *Core) call(ctx context.Context, name string, arguments ...uint64) (uint32, error) {
	results, err := core.module.ExportedFunction(name).Call(ctx, arguments...)
	if err != nil {
		return 0, err
	}
	if len(results) == 0 {
		return 0, nil
	}
	return uint32(results[0]), nil
}

func (core *Core) exchange(ctx context.Context, request any) (message, error) {
	if err := ctx.Err(); err != nil {
		return message{}, err
	}
	if err := wireStrings(reflect.ValueOf(request)); err != nil {
		return message{}, err
	}
	input, err := json.Marshal(struct {
		Version uint32 `json:"version"`
		Request any    `json:"request"`
	}{1, request})
	if err != nil {
		return message{}, err
	}
	if uint64(len(input)) > math.MaxUint32 {
		return message{}, fmt.Errorf("modelt: command exceeds ABI length")
	}
	pointer, err := core.call(ctx, "modelt_input_resize", uint64(len(input)))
	if err != nil {
		return message{}, err
	}
	if !core.memory.Write(pointer, input) {
		return message{}, fmt.Errorf("modelt: input outside Wasm memory")
	}
	if _, err := core.call(ctx, "modelt_dispatch"); err != nil {
		return message{}, err
	}
	pointer, err = core.call(ctx, "modelt_output_ptr")
	if err != nil {
		return message{}, err
	}
	length, err := core.call(ctx, "modelt_output_len")
	if err != nil {
		return message{}, err
	}
	output, ok := core.memory.Read(pointer, length)
	if !ok {
		return message{}, fmt.Errorf("modelt: output outside Wasm memory")
	}
	var result message
	if err := json.Unmarshal(append([]byte(nil), output...), &result); err != nil {
		return message{}, err
	}
	if result.Kind == "error" {
		return message{}, &CoreError{Code: result.Code, Message: result.Message}
	}
	return result, nil
}

// encoding/json replaces invalid UTF-8. Reject it before encoding keys or observations.
func wireStrings(input reflect.Value) error {
	if !input.IsValid() {
		return nil
	}
	switch input.Kind() {
	case reflect.String:
		if !utf8.ValidString(input.String()) {
			return &CoreError{Code: "protocol", Message: "Invalid Unicode string"}
		}
	case reflect.Interface, reflect.Pointer:
		if !input.IsNil() {
			return wireStrings(input.Elem())
		}
	case reflect.Slice:
		if input.Type().Elem().Kind() == reflect.Uint8 {
			if !utf8.Valid(input.Bytes()) {
				return &CoreError{Code: "protocol", Message: "Invalid UTF-8 JSON"}
			}
			return nil
		}
		fallthrough
	case reflect.Array:
		for index := 0; index < input.Len(); index++ {
			if err := wireStrings(input.Index(index)); err != nil {
				return err
			}
		}
	case reflect.Struct:
		for index := 0; index < input.NumField(); index++ {
			if err := wireStrings(input.Field(index)); err != nil {
				return err
			}
		}
	case reflect.Map:
		entries := input.MapRange()
		for entries.Next() {
			if err := wireStrings(entries.Key()); err != nil {
				return err
			}
			if err := wireStrings(entries.Value()); err != nil {
				return err
			}
		}
	}
	return nil
}

func (core *Core) request(ctx context.Context, request any, expected string) (message, error) {
	if !core.mu.TryLock() {
		return message{}, ErrBusy
	}
	defer core.mu.Unlock()
	result, err := core.exchange(ctx, request)
	if err != nil {
		return message{}, err
	}
	if result.Kind != expected {
		return message{}, fmt.Errorf("modelt: expected %s, received %s", expected, result.Kind)
	}
	return result, nil
}

func (core *Core) Canonicalize(ctx context.Context, value Value) (Value, error) {
	result, err := core.request(ctx, map[string]any{"kind": "canonicalize", "value": value}, "value")
	return result.Value, err
}

// CheckHistories checks recorded observations against a finite model, without executing a SUT.
// model is the complete tagged finite-model artifact, validated by the shared core.
func (core *Core) CheckHistories(ctx context.Context, model json.RawMessage, traces []Trace) ([]Result, error) {
	normalized := make([]Trace, len(traces))
	for index, trace := range traces {
		normalized[index] = traceArrays(trace)
	}
	result, err := core.request(ctx, map[string]any{"kind": "check-finite", "model": model, "traces": normalized}, "results")
	return result.Results, err
}

func (core *Core) DeletionCandidates(ctx context.Context, length uint32) ([]DeletionRange, error) {
	result, err := core.request(ctx, map[string]any{"kind": "shrink-candidates", "length": length}, "candidates")
	return result.Ranges, err
}

// ReplayHost verifies a recorded HostTape; it does not instrument Go I/O.
func (core *Core) ReplayHost(ctx context.Context, tape json.RawMessage) (Value, error) {
	result, err := core.request(ctx, map[string]any{"kind": "replay-host", "tape": tape}, "host")
	return result.Snapshot, err
}
