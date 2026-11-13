package main

import (
	"context"
	"encoding/json"
	"fmt"
	modelt "github.com/mizchi/modelt/adapters/go"
	"io"
	"os"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("pass core Wasm path")
	}
	var input struct {
		Model json.RawMessage `json:"model"`
		Cases []struct {
			History  json.RawMessage `json:"history"`
			MaxNodes uint32          `json:"maxNodes"`
		} `json:"cases"`
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
	core, err := modelt.New(ctx, wasm)
	if err != nil {
		return err
	}
	defer core.Close(ctx)
	model, err := core.LoadModel(ctx, input.Model)
	if err != nil {
		return err
	}
	defer model.Close(ctx)
	results := make([]modelt.ConcurrentResult, 0, len(input.Cases))
	for _, entry := range input.Cases {
		result, err := model.CheckHistoryJSON(ctx, entry.History, entry.MaxNodes)
		if err != nil {
			return err
		}
		results = append(results, result)
	}
	return json.NewEncoder(os.Stdout).Encode(results)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
