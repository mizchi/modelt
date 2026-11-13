package main

import (
	"context"
	"encoding/json"
	"fmt"
	modelt "github.com/mizchi/modelt/adapters/go"
	"io"
	"os"
	"reflect"
	"time"
)

type profile struct {
	Mode    string    `json:"mode"`
	Batch   int       `json:"batch"`
	Samples []float64 `json:"samples"`
}

func milliseconds(start time.Time) float64 { return float64(time.Since(start).Nanoseconds()) / 1e6 }
func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("pass core Wasm path")
	}
	var input struct {
		Model json.RawMessage `json:"model"`
		Trace modelt.Trace    `json:"trace"`
	}
	bytes, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(bytes, &input); err != nil {
		return err
	}
	wasm, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	ctx := context.Background()
	started := time.Now()
	core, err := modelt.New(ctx, wasm)
	if err != nil {
		return err
	}
	defer core.Close(ctx)
	startup := milliseconds(started)
	loads := []float64{}
	for index := 0; index < 12; index++ {
		started = time.Now()
		model, err := core.LoadModel(ctx, input.Model)
		if err != nil {
			return err
		}
		elapsed := milliseconds(started)
		if err := model.Close(ctx); err != nil {
			return err
		}
		if index >= 3 {
			loads = append(loads, elapsed)
		}
	}
	loaded, err := core.LoadModel(ctx, input.Model)
	if err != nil {
		return err
	}
	defer loaded.Close(ctx)
	profiles := []profile{}
	var reference modelt.Result
	for _, batch := range []int{1, 16, 64} {
		traces := make([]modelt.Trace, batch)
		for index := range traces {
			traces[index] = input.Trace
		}
		wire := profile{Mode: "wire", Batch: batch, Samples: []float64{}}
		reused := profile{Mode: "loaded", Batch: batch, Samples: []float64{}}
		for sample := -3; sample < 9; sample++ {
			modes := []string{"wire", "loaded"}
			if sample%2 != 0 {
				modes = []string{"loaded", "wire"}
			}
			for _, mode := range modes {
				started = time.Now()
				var results []modelt.Result
				if mode == "wire" {
					results, err = core.CheckHistories(ctx, input.Model, traces)
				} else {
					results, err = loaded.CheckHistories(ctx, traces)
				}
				elapsed := milliseconds(started)
				if err != nil {
					return err
				}
				if len(results) != batch {
					return fmt.Errorf("missing results")
				}
				for _, result := range results {
					if result.Status != "matched" || !reflect.DeepEqual(result.Trace, input.Trace) {
						return fmt.Errorf("benchmark result changed")
					}
				}
				reference = results[0]
				if sample >= 0 {
					if mode == "wire" {
						wire.Samples = append(wire.Samples, elapsed)
					} else {
						reused.Samples = append(reused.Samples, elapsed)
					}
				}
			}
		}
		profiles = append(profiles, wire, reused)
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"startupMs": startup, "loadSamples": loads, "profiles": profiles, "reference": reference})
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
