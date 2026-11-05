package app

// 技能页：agent 可用的技能（skill.list，内置与用户目录里的），可以按名字、描述与标签过滤；读不了的技能文件
// 列在底部。技能由 agent 按需调用，这里只做浏览。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

type skillsState struct {
	loading     bool
	loaded      bool
	err         string
	query       string
	skills      []service.Skill
	diagnostics []service.SkillDiagnostic
}

// loadSkills 重新读技能目录。
func (a *app) loadSkills() {
	client := a.client
	if client == nil || a.skills.loading {
		return
	}
	a.skills.loading = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		skills, diags, err := client.Skills(ctx)
		a.post(func() {
			s := &a.skills
			s.loading, s.loaded = false, true
			if err != nil {
				s.err = sourceErrorText(err)
				return
			}
			s.err, s.skills, s.diagnostics = "", skills, diags
		})
	}()
}

// skillsPage 画技能页。
func (a *app) skillsPage(c *ui.Context) {
	t := c.Theme()
	s := &a.skills
	a.pageHeader(c, t, icons.Skill, a.tr("skills.title"), func() {
		if s.loading {
			ui.Spinner(c)
		}
		if a.client != nil && ui.Button(c, a.tr("data.refresh")).Clicked() {
			a.loadSkills()
		}
	})
	if a.client == nil {
		ui.Text(c, a.tr("know.unavailable")).TextColor(t.TextMuted).Padding(24, 32)
		return
	}
	if !s.loaded && !s.loading {
		a.loadSkills()
	}
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		ui.Column(c).Padding(16, 24).Gap(12).MaxWidth(900).Children(func() {
			ui.Text(c, a.tr("skills.tip")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.SearchField(c, &s.query).Label(a.tr("skills.search")).Placeholder(a.tr("skills.search"))
			if s.err != "" {
				ui.Text(c, s.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			shown := 0
			q := strings.ToLower(strings.TrimSpace(s.query))
			tok := a.tokens().Tok
			for _, sk := range s.skills {
				if q != "" && !strings.Contains(strings.ToLower(sk.Name+" "+sk.DisplayName+" "+sk.Description+" "+strings.Join(sk.Tags, " ")), q) {
					continue
				}
				shown++
				sk := sk
				ui.Column(c).Gap(6).Padding(12, 14).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Icon(c, icons.Skill).TextColor(t.Accent)
						name := sk.DisplayName
						if name == "" {
							name = sk.Name
						}
						ui.Text(c, name).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(sk.Name)
						if sk.Source != "" {
							ui.Badge(c, sk.Source)
						}
					})
					if sk.Description != "" {
						ui.Text(c, sk.Description).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).MaxLines(4)
					}
					ui.Row(c).Gap(6).AlignItems(ui.Center).Wrap().Children(func() {
						for _, tag := range sk.Tags {
							ui.Badge(c, tag)
						}
						var meta []string
						if n := len(sk.AllowedTools); n > 0 {
							meta = append(meta, a.tr("skills.tools", "count", strconv.Itoa(n)))
						}
						if sk.ResourceCount > 0 {
							meta = append(meta, a.tr("skills.resources", "count", strconv.Itoa(sk.ResourceCount)))
						}
						if len(meta) > 0 {
							ui.Text(c, strings.Join(meta, " · ")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
						}
					})
				})
			}
			if s.loaded && shown == 0 {
				ui.Text(c, a.tr("skills.none")).TextColor(t.TextMuted)
			}
			if len(s.diagnostics) > 0 {
				ui.Text(c, a.tr("skills.problems")).FontSize(a.fs(textCaption)).TextColor(t.Warning)
				for _, d := range s.diagnostics {
					a.buffer(ui.Text(c, d.Path+": "+d.Error)).TextColor(t.TextMuted).Selectable()
				}
			}
		})
	})
}
