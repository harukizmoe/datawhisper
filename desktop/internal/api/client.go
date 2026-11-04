// Package api is the desktop app's client of the agent service's UI protocol (docs/refactor/ui-protocol.md):
// typed requests, and conversation subscriptions replicated from a snapshot and Chord delta ops.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client calls one running service. A restarted service listens on a new port: make a new Client.
type Client struct {
	// Base is the service's origin, as http://127.0.0.1:PORT.
	Base  string
	Token string
	// HTTP defaults to a client without a timeout (subscriptions are long-lived; requests take a context).
	HTTP *http.Client
	// IdleTimeout ends a subscription that received nothing, not even a heartbeat comment (sent every 15 s),
	// for this long. Default 45 s.
	IdleTimeout time.Duration
}

// New returns a client of the service on 127.0.0.1:port.
func New(port int, token string) *Client {
	return &Client{Base: fmt.Sprintf("http://127.0.0.1:%d", port), Token: token}
}

// Error is a non-2xx response; Message is the JSON body's "error" when it has one.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("service: %d %s", e.Status, e.Message) }

var (
	// ErrNotFound matches (errors.Is) an Error with status 404, such as an unknown conversation.
	ErrNotFound = errors.New("not found")
	// ErrNoModel matches Submit's 409 "no_model": the conversation has no model and none is available. Send the
	// user to the model settings.
	ErrNoModel = errors.New("no model configured")
	// ErrModelUnavailable matches Submit's 409 "model_unavailable": the conversation's model belongs to a provider
	// that was removed or disabled. Send the user to the model settings, or SetModel.
	ErrModelUnavailable = errors.New("model unavailable")
)

func (e *Error) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Status == http.StatusNotFound
	case ErrNoModel:
		return e.Status == http.StatusConflict && e.Message == "no_model"
	case ErrModelUnavailable:
		return e.Status == http.StatusConflict && e.Message == "model_unavailable"
	}
	return false
}

// Health is GET /v1/health.
type Health struct {
	OK          bool   `json:"ok"`
	Scheduling  string `json:"scheduling"`
	Tasks       int    `json:"tasks"`
	Submissions int    `json:"submissions"`
	ComputePID  *int   `json:"computePid"`
}

// ConversationSummary is one item of GET /v1/conversations.
type ConversationSummary struct {
	ID     int  `json:"id"`
	Root   bool `json:"root"`
	Parent *struct {
		ConversationID int `json:"conversationId"`
		At             int `json:"at"`
	} `json:"parent,omitempty"`
	// LastEntryID is nil while the conversation has no entry.
	LastEntryID *int `json:"lastEntryId"`
	// UpdatedAt is the epoch milliseconds of the newest entry's message; nil when it has none.
	UpdatedAt *int64 `json:"updatedAt"`
}

// SubmitRequest is the body of POST /v1/conversations/:id/submit.
type SubmitRequest struct {
	// RequestID is the idempotency key: a retry with the same key returns the same submission.
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
	// WhenBusy is "steer" (join the running reply) or "followUp" (the default: run next).
	WhenBusy string `json:"whenBusy,omitempty"`
}

// SubmitResponse reports the submission's id and its pi-durable status: queued, placed, done or unanswered.
type SubmitResponse struct {
	SubmissionID int    `json:"submissionId"`
	Status       string `json:"status"`
}

// ModelRef names a model: a provider id and that provider's model id (pi-durable ModelRef).
type ModelRef struct {
	Provider string `json:"provider"`
	ModelID  string `json:"modelId"`
}

// CreateConversationRequest is the optional body of POST /v1/conversations. Without Model the service picks its
// default model (the /v1/models settings). ThinkingLevel is one of off, minimal, low, medium, high, xhigh, max.
type CreateConversationRequest struct {
	Model         *ModelRef `json:"model,omitempty"`
	ThinkingLevel string    `json:"thinkingLevel,omitempty"`
}

// SetModelRequest is the body of PUT /v1/conversations/:id/model; a nil ThinkingLevel clears it (the default).
type SetModelRequest struct {
	Model         ModelRef `json:"model"`
	ThinkingLevel *string  `json:"thinkingLevel"`
}

// AgentModelResponse is a conversation's resolved model (nil when it has none) and effective thinking level.
type AgentModelResponse struct {
	Model         *ModelRef `json:"model"`
	ThinkingLevel string    `json:"thinkingLevel"`
}

// AvailableModel is one item of GET /v1/models/available: a chat model of an enabled provider whose auth is
// complete.
type AvailableModel struct {
	Provider       string   `json:"provider"`
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	ContextWindow  int      `json:"contextWindow"`
	MaxTokens      int      `json:"maxTokens"`
	Reasoning      bool     `json:"reasoning"`
	Vision         bool     `json:"vision"`
	ThinkingLevels []string `json:"thinkingLevels"`
}

// Health reports whether the service answers and what it runs.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var out Health
	err := c.do(ctx, http.MethodGet, "/v1/health", nil, &out)
	return out, err
}

// Conversations lists the ownerless conversations, newest first.
func (c *Client) Conversations(ctx context.Context) ([]ConversationSummary, error) {
	var out struct {
		Conversations []ConversationSummary `json:"conversations"`
	}
	err := c.do(ctx, http.MethodGet, "/v1/conversations", nil, &out)
	return out.Conversations, err
}

// CreateConversation creates an empty conversation and returns its id; the zero request uses the default model.
// An unknown model or an unsupported thinking level is a 400 *Error.
func (c *Client) CreateConversation(ctx context.Context, req CreateConversationRequest) (int, error) {
	var out struct {
		ID int `json:"id"`
	}
	err := c.do(ctx, http.MethodPost, "/v1/conversations", req, &out)
	return out.ID, err
}

// SetModel switches conversation conv to another model and thinking level, from its next model request on.
func (c *Client) SetModel(ctx context.Context, conv string, req SetModelRequest) (AgentModelResponse, error) {
	var out AgentModelResponse
	err := c.do(ctx, http.MethodPut, "/v1/conversations/"+url.PathEscape(conv)+"/model", req, &out)
	return out, err
}

// AvailableModels lists the models a conversation can use now.
func (c *Client) AvailableModels(ctx context.Context) ([]AvailableModel, error) {
	var out struct {
		Models []AvailableModel `json:"models"`
	}
	err := c.do(ctx, http.MethodGet, "/v1/models/available", nil, &out)
	return out.Models, err
}

// Submit admits user input into conversation conv ("root" or a numeric id). ErrNoModel and ErrModelUnavailable
// match its 409s.
func (c *Client) Submit(ctx context.Context, conv string, req SubmitRequest) (SubmitResponse, error) {
	var out SubmitResponse
	err := c.do(ctx, http.MethodPost, "/v1/conversations/"+url.PathEscape(conv)+"/submit", req, &out)
	return out, err
}

// Abort stops the conversation's running reply and withdraws its queued inputs.
func (c *Client) Abort(ctx context.Context, conv string) error {
	return c.do(ctx, http.MethodPost, "/v1/conversations/"+url.PathEscape(conv)+"/abort", nil, nil)
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	req, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if err := responseError(res); err != nil {
		return err
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	return nil
}

// responseError turns a non-2xx response into an *Error, with the JSON body's "error" when there is one.
func responseError(res *http.Response) error {
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	var body struct {
		Error string `json:"error"`
	}
	msg := string(bytes.TrimSpace(b))
	if json.Unmarshal(b, &body) == nil && body.Error != "" {
		msg = body.Error
	}
	return &Error{Status: res.StatusCode, Message: msg}
}
