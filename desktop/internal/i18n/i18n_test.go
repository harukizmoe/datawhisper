package i18n

import (
	"regexp"
	"strings"
	"testing"
)

// TestResourcesAgree 核对两份资源：中文不能有英文里没有的键（那是拼错了），占位符必须两边一致，
// 否则替换会漏掉一处。代码用到的键是否齐全由 internal/app 的测试核对。
func TestResourcesAgree(t *testing.T) {
	for key := range zhMessages {
		if _, ok := enMessages[key]; !ok {
			t.Errorf("%q is only in the Chinese resources", key)
		}
	}
	placeholder := regexp.MustCompile(`\{[a-z]+\}`)
	for key, en := range enMessages {
		zh := zhMessages[key]
		if zh == "" {
			continue
		}
		if got, want := placeholder.FindAllString(zh, -1), placeholder.FindAllString(en, -1); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%q: Chinese placeholders %v, English %v", key, got, want)
		}
	}
}

func TestTFallsBackAndReplaces(t *testing.T) {
	if got := T(ZH, "no.such.key"); got != "no.such.key" {
		t.Errorf("a missing key gave %q", got)
	}
	for key := range enMessages {
		if T(System, key) != enMessages[key] {
			t.Errorf("System did not fall back to English for %q", key)
		}
		break
	}
	if !Valid(System) || !Valid(EN) || !Valid(ZH) || Valid("fr") {
		t.Error("Valid")
	}
	if !Has(EN, Keys()[0]) {
		t.Error("Has/Keys disagree")
	}
}

func TestResolve(t *testing.T) {
	cases := []struct {
		pref      string
		preferred []string
		want      string
	}{
		{EN, []string{"zh-CN"}, EN},
		{ZH, []string{"en-US"}, ZH},
		{System, []string{"zh-CN"}, ZH},
		// 我们只有简体中文：繁体中文的读者此时退回英文，而不是看到半对的简体。
		{System, []string{"zh-TW"}, EN},
		{System, []string{"en-GB"}, EN},
		{System, []string{"fr-FR"}, EN},
		{System, nil, EN},
	}
	for _, c := range cases {
		if got := Resolve(c.pref, c.preferred); got != c.want {
			t.Errorf("Resolve(%q, %v) = %q, want %q", c.pref, c.preferred, got, c.want)
		}
	}
	if got := Label(ZH); got == "" || got == ZH {
		t.Errorf("Label(zh-Hans) = %q", got)
	}
}
