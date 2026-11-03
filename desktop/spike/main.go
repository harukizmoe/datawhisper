// Desktop spike: a MyGo native window that subscribes to the spike4 Hono server, sends prompts,
// renders the streaming assistant reply with ui/markdown, and shows a Plotly chart in a ui.WebView.
//
//	SPIKE_URL=http://127.0.0.1:47811 SPIKE_TOKEN=... go run . [-prompt "..."]... [-capture DIR]
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

type chat struct {
	win    *mygo.Window
	cl     client
	conv   conversation
	rows   []message
	status string
	input  string
	list   ui.ListState
	md     markdown.Options
	chart  *mygo.WebView
}

func (app *chat) view(c *ui.Context) {
	t := c.Theme()
	app.list.Key = func(i int) any { return app.rows[i].key }
	app.list.FollowEnd = true
	ui.Column(c).Fill().Children(func() {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Padding(8, 16).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, "DataWhisper spike").Bold()
			ui.Spacer(c)
			ui.Text(c, app.status).TextColor(t.TextMuted)
		})
		ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() {
			ui.Column(c).Grow(1).Children(func() {
				ui.List(c, &app.list, len(app.rows), func(i int) {
					app.message(c, app.rows[i])
				}).Grow(1).Padding(16, 20).Gap(12).Justify(ui.End)
				ui.Row(c).Gap(8).Padding(12, 20).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
					in := ui.TextInput(c, &app.input).Placeholder("Message").Grow(1).AutoFocus()
					if (ui.PrimaryButton(c, "Send").Disabled(strings.TrimSpace(app.input) == "").Clicked() || in.Submitted()) && strings.TrimSpace(app.input) != "" {
						app.send(strings.TrimSpace(app.input))
						app.input = ""
					}
				})
			})
			ui.Column(c).Width(460).Padding(12).Gap(8).BorderWidth(0, 0, 0, 1).BorderColor(t.Border).Children(func() {
				ui.Text(c, "Plotly (ui.WebView)").Bold()
				if app.chart != nil {
					ui.WebView(c, app.chart).Grow(1).Radius(8).Border(1, t.Border)
				} else {
					ui.Text(c, "no web view").TextColor(t.TextMuted)
				}
			})
		})
	})
}

func (app *chat) message(c *ui.Context, m message) {
	t := c.Theme()
	switch m.role {
	case "user":
		ui.Row(c).Children(func() {
			ui.Spacer(c)
			ui.Text(c, m.text).Selectable().Padding(8, 12).Radius(14).Background(t.Surface).MaxWidth(520)
		})
	case "tool":
		ui.Text(c, m.text).FontSize(12).TextColor(t.TextMuted)
	default:
		ui.Column(c).MaxWidth(760).Children(func() {
			if m.done {
				markdown.View(c, m.text, &app.md)
			} else {
				markdown.Stream(c, m.text, &app.md)
			}
		})
	}
}

// onEvent folds a server event into the replica and rebuilds the rows. Runs on the main thread.
func (app *chat) onEvent(ev event) {
	if err := app.conv.apply(ev); err != nil {
		app.status = "error: " + err.Error()
		return
	}
	app.rows = app.conv.messages()
	app.status = fmt.Sprintf("seq %d", app.conv.seq)
}

func (app *chat) send(text string) {
	requestID := fmt.Sprintf("ui-%d", time.Now().UnixNano())
	go func() {
		id, err := app.cl.submit(context.Background(), requestID, text)
		app.win.Update(func() {
			if err != nil {
				app.status = "submit failed: " + err.Error()
			} else {
				app.status = fmt.Sprintf("submitted %d", id)
			}
		})
	}()
}

// follow subscribes, and resubscribes after a drop: each subscription starts from a fresh snapshot.
func (app *chat) follow() {
	for {
		err := app.cl.subscribe(context.Background(), func(ev event) {
			app.win.Update(func() { app.onEvent(ev) })
		})
		app.win.Update(func() { app.status = fmt.Sprintf("reconnecting (%v)", err) })
		time.Sleep(time.Second)
	}
}

// capture saves what the window renders (Window.CapturePage: the native UI, with a hole where the web view
// is) every 500ms for 15s, then the web view's page (WebView.CapturePage), and quits. Neither needs the
// window to have the focus, unlike a compositor screenshot.
func (app *chat) capture(dir string) {
	for i := 1; i <= 30; i++ {
		time.Sleep(500 * time.Millisecond)
		png, err := app.win.CapturePage()
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, fmt.Sprintf("window-%02d.png", i)), png, 0o644)
		}
		if err != nil {
			log.Printf("capture window: %v", err)
		}
	}
	if app.chart != nil {
		png, err := app.chart.CapturePage()
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, "webview.png"), png, 0o644)
		}
		if err != nil {
			log.Printf("capture web view: %v", err)
		}
	}
	log.Printf("capture: wrote %s", dir)
	mygo.App.Quit()
}

type prompts []string

func (p *prompts) String() string     { return strings.Join(*p, ";") }
func (p *prompts) Set(v string) error { *p = append(*p, v); return nil }

func main() {
	var auto prompts
	flag.Var(&auto, "prompt", "prompt to send once connected (repeatable; queued as follow-ups)")
	captureDir := flag.String("capture", "", "save the window's own frames every 500ms for 15s and the web view's page into this directory, then quit")
	flag.Parse()
	app := &chat{cl: client{base: os.Getenv("SPIKE_URL"), token: os.Getenv("SPIKE_TOKEN")}}
	if app.cl.base == "" || app.cl.token == "" {
		log.Fatal("SPIKE_URL and SPIKE_TOKEN are required")
	}
	mygo.App.WhenReady(func() {
		app.win = mygo.NewWindow(mygo.WindowOptions{
			Title:   "DataWhisper spike",
			Width:   1280,
			Height:  800,
			Content: ui.View(app.view),
		})
		chart, err := app.win.NewWebView(mygo.WebViewOptions{
			URL:  app.cl.base + "/chart.html?token=" + app.cl.token,
			Page: mygo.PageOptions{Untrusted: true},
		})
		if err != nil {
			app.status = "web view: " + err.Error()
		}
		app.chart = chart
		app.win.Invalidate()
		go app.follow()
		go func() {
			for _, p := range auto {
				app.send(p)
				time.Sleep(200 * time.Millisecond)
			}
		}()
		if *captureDir != "" {
			go app.capture(*captureDir)
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
