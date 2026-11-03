package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// client talks to the spike4 Hono server.
type client struct {
	base  string
	token string
}

// event is one SSE event of /subscribe: "snapshot" carries View, "ops" carries Ops.
type event struct {
	Name string
	Seq  int               `json:"seq"`
	View any               `json:"view"`
	Ops  []json.RawMessage `json:"ops"`
}

func (cl client) submit(ctx context.Context, requestID, text string) (int, error) {
	body, _ := json.Marshal(map[string]string{"requestId": requestID, "text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cl.base+"/v1/conversations/root/submit", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+cl.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	var out struct {
		SubmissionID int    `json:"submissionId"`
		Error        string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return 0, err
	}
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("submit: %s %s", res.Status, out.Error)
	}
	return out.SubmissionID, nil
}

// subscribe streams /subscribe events to onEvent until ctx ends or the stream closes.
func (cl client) subscribe(ctx context.Context, onEvent func(event)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cl.base+"/v1/conversations/root/subscribe", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cl.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("subscribe: %s", res.Status)
	}
	return readSSE(res.Body, onEvent)
}

// readSSE parses an SSE stream of `event:` + `data:` lines.
func readSSE(r io.Reader, onEvent func(event)) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	var name, data string
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimPrefix(line[len("data:"):], " ")
		case line == "":
			if data != "" {
				ev := event{Name: name}
				if err := json.Unmarshal([]byte(data), &ev); err != nil {
					return fmt.Errorf("event %s: %w", name, err)
				}
				onEvent(ev)
			}
			name, data = "", ""
		}
	}
	return scanner.Err()
}
