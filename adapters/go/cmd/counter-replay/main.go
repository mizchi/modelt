package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"

	modelt "github.com/mizchi/modelt/adapters/go"
	"github.com/mizchi/modelt/adapters/go/internal/counter"
)

type oracleCase struct {
	ID     string       `json:"id"`
	Seed   *int64       `json:"seed,omitempty"`
	Oracle modelt.Trace `json:"oracle"`
}
type suite struct {
	Format  string          `json:"format"`
	Version uint32          `json:"version"`
	Model   json.RawMessage `json:"model"`
	Faults  []string        `json:"faults"`
	Cases   []oracleCase    `json:"cases"`
}
type calls struct {
	Resets int `json:"resets"`
	Steps  int `json:"steps"`
}
type execution struct {
	CaseID      string        `json:"caseId"`
	Fault       string        `json:"fault"`
	Finite      modelt.Result `json:"finite"`
	Replay      modelt.Result `json:"replay"`
	FiniteCalls calls         `json:"finiteCalls"`
	ReplayCalls calls         `json:"replayCalls"`
}

func nativeValue(input modelt.Value) (any, error) {
	var tagged struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(input, &tagged); err != nil {
		return nil, err
	}
	switch tagged.Type {
	case "string":
		var result string
		err := json.Unmarshal(tagged.Value, &result)
		return result, err
	case "int":
		var decimal string
		if err := json.Unmarshal(tagged.Value, &decimal); err != nil {
			return nil, err
		}
		return strconv.ParseInt(decimal, 10, 64)
	case "record":
		var fields [][2]json.RawMessage
		if err := json.Unmarshal(tagged.Value, &fields); err != nil {
			return nil, err
		}
		result := map[string]any{}
		for _, field := range fields {
			var name string
			if err := json.Unmarshal(field[0], &name); err != nil {
				return nil, err
			}
			value, err := nativeValue(field[1])
			if err != nil {
				return nil, err
			}
			result[name] = value
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unsupported counter action value %s", tagged.Type)
	}
}

func driver(fault string, counts *calls) (modelt.Driver, error) {
	sut, err := counter.New(fault)
	if err != nil {
		return modelt.Driver{}, err
	}
	observe := func(observation counter.Observation) (modelt.Value, error) {
		return modelt.ValueOf(map[string]any{"running": observation.Running, "value": observation.Value})
	}
	return modelt.Driver{
		Reset: func(ctx context.Context) (modelt.Value, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			counts.Resets++
			return observe(sut.Reset())
		},
		Step: func(ctx context.Context, input modelt.Value) (modelt.Value, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			native, err := nativeValue(input)
			if err != nil {
				return nil, err
			}
			encoded, err := json.Marshal(native)
			if err != nil {
				return nil, err
			}
			var action counter.Action
			decoder := json.NewDecoder(bytes.NewReader(encoded))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&action); err != nil {
				return nil, err
			}
			counts.Steps++
			observation, err := sut.Step(action)
			if err != nil {
				return nil, err
			}
			return observe(observation)
		},
	}, nil
}

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("pass the shared core Wasm path")
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var bundle suite
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&bundle); err != nil {
		return err
	}
	if bundle.Format != "modelt.oracle-suite" || bundle.Version != 1 || len(bundle.Cases) == 0 || len(bundle.Faults) == 0 {
		return fmt.Errorf("invalid oracle suite")
	}
	wasm, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	ctx := context.Background()
	core, err := modelt.New(ctx, wasm)
	if err != nil {
		return err
	}
	defer core.Close(ctx)
	traces := make([]modelt.Trace, len(bundle.Cases))
	for index, entry := range bundle.Cases {
		traces[index] = entry.Oracle
	}
	validated, err := core.CheckHistories(ctx, bundle.Model, traces)
	if err != nil {
		return err
	}
	for _, result := range validated {
		if result.Status != "matched" {
			return fmt.Errorf("oracle differs from finite model")
		}
	}
	rows := make([]execution, 0, len(bundle.Cases)*len(bundle.Faults))
	for _, entry := range bundle.Cases {
		for _, fault := range bundle.Faults {
			row := execution{CaseID: entry.ID, Fault: fault}
			finiteDriver, err := driver(fault, &row.FiniteCalls)
			if err != nil {
				return err
			}
			actions := make([]modelt.Value, len(entry.Oracle.Steps))
			for index, step := range entry.Oracle.Steps {
				actions[index] = step.Action
			}
			row.Finite, err = core.CheckFinite(ctx, bundle.Model, finiteDriver, actions)
			if err != nil {
				return err
			}
			replayDriver, err := driver(fault, &row.ReplayCalls)
			if err != nil {
				return err
			}
			row.Replay, err = core.Replay(ctx, entry.Oracle, replayDriver)
			if err != nil {
				return err
			}
			rows = append(rows, row)
		}
	}
	return json.NewEncoder(os.Stdout).Encode(rows)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
