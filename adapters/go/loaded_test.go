package modelt_test

import (
	"context"
	"encoding/json"
	modelt "github.com/mizchi/modelt/adapters/go"
	"testing"
)

func TestLoadedModelLifetimeAndPendingHistory(t *testing.T) {
	core := loadCore(t)
	ctx := context.Background()
	artifact := json.RawMessage(`{"format":"modelt.finite-model","version":1,"name":"register","initial":[{"key":"0","observation":{"type":"int","value":"0"}}],"states":[{"key":"0","violations":[],"transitions":[{"action":{"type":"string","value":"write"},"target":"1","observation":{"type":"string","value":"ok"}},{"action":{"type":"string","value":"read"},"target":"0","observation":{"type":"int","value":"0"}}]},{"key":"1","violations":[],"transitions":[{"action":{"type":"string","value":"read"},"target":"1","observation":{"type":"int","value":"1"}},{"action":{"type":"string","value":"write"},"target":"1","observation":{"type":"string","value":"ok"}}]}]}`)
	handle, err := core.LoadModel(ctx, artifact)
	if err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []string{"unknown", "cancel", "fail"} {
		history := modelt.ConcurrentHistory{Format: "modelt.concurrent-history", Version: 1, Model: "register", Initial: value(t, 0), Events: []modelt.HistoryEvent{
			{Kind: "invoke", ID: "w", Action: value(t, "write")}, {Kind: outcome, ID: "w"},
			{Kind: "invoke", ID: "r", Action: value(t, "read")}, {Kind: "return", ID: "r", Observation: value(t, 1)},
		}}
		result, err := handle.CheckHistory(ctx, history, 100)
		if err != nil {
			t.Fatal(err)
		}
		expected := "linearizable"
		if outcome == "fail" {
			expected = "not-linearizable"
		}
		if result.Status != expected {
			t.Fatalf("%s: %+v", outcome, result)
		}
	}
	trace := modelt.Trace{Format: "modelt.portable-trace", Version: 1, Model: "register", Initial: value(t, 0)}
	original, err := core.CheckHistories(ctx, artifact, []modelt.Trace{trace})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := handle.CheckHistories(ctx, []modelt.Trace{trace})
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, prepared, original)
	if err := handle.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.CheckHistories(ctx, []modelt.Trace{trace}); err == nil {
		t.Fatal("released handle accepted")
	}
}
