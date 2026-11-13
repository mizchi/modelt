// Package counter is an evaluation SUT. It never reads a model or an oracle.
package counter

import "fmt"

type Action struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Amount int64  `json:"amount"`
	Index  int    `json:"index"`
}

type Observation struct {
	Running bool
	Value   int64
}

type request struct {
	id     string
	amount int64
}

type Counter struct {
	fault        string
	running      bool
	value        int64
	durableValue int64
	seen         map[string]bool
	durableSeen  map[string]bool
	pending      []request
	attempts     map[string]int
}

func New(fault string) (*Counter, error) {
	switch fault {
	case "none", "persistence", "deduplication", "late-retry", "fifo-only", "drop-ignored":
		counter := &Counter{fault: fault}
		counter.Reset()
		return counter, nil
	default:
		return nil, fmt.Errorf("unknown counter fault %q", fault)
	}
}

func (counter *Counter) observe() Observation {
	if !counter.running {
		return Observation{Running: false, Value: 0}
	}
	return Observation{Running: true, Value: counter.value}
}

func (counter *Counter) Reset() Observation {
	counter.running = true
	counter.value, counter.durableValue = 0, 0
	counter.seen, counter.durableSeen = map[string]bool{}, map[string]bool{}
	counter.pending = nil
	counter.attempts = map[string]int{}
	return counter.observe()
}

func copySeen(input map[string]bool) map[string]bool {
	result := make(map[string]bool, len(input))
	for id, seen := range input {
		result[id] = seen
	}
	return result
}

func (counter *Counter) apply(input request) {
	if !counter.running || counter.fault != "deduplication" && counter.seen[input.id] {
		return
	}
	counter.value += input.amount
	counter.seen[input.id] = true
	if counter.fault != "persistence" {
		counter.durableValue = counter.value
		counter.durableSeen = copySeen(counter.seen)
	}
}

func (counter *Counter) Step(action Action) (Observation, error) {
	switch action.Type {
	case "add":
		counter.attempts[action.ID]++
		id := action.ID
		if counter.fault == "late-retry" && counter.attempts[id] == 3 {
			id += ":third-attempt"
		}
		counter.apply(request{id, action.Amount})
	case "send":
		counter.pending = append(counter.pending, request{action.ID, action.Amount})
	case "deliver", "drop":
		if action.Type == "drop" && counter.fault == "drop-ignored" {
			return counter.observe(), nil
		}
		index := action.Index
		if action.Type == "deliver" && counter.fault == "fifo-only" {
			index = 0
		}
		if index >= 0 && index < len(counter.pending) {
			input := counter.pending[index]
			counter.pending = append(counter.pending[:index], counter.pending[index+1:]...)
			if action.Type == "deliver" {
				counter.apply(input)
			}
		}
	case "crash":
		counter.running = false
		counter.value = 0
		counter.seen = map[string]bool{}
	case "restart":
		if !counter.running {
			counter.running = true
			counter.value = counter.durableValue
			counter.seen = copySeen(counter.durableSeen)
		}
	default:
		return Observation{}, fmt.Errorf("unknown counter action %q", action.Type)
	}
	return counter.observe(), nil
}
