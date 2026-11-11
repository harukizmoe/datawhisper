package app

// 磨砂玻璃：输入区浮在消息文字之上时，卡片背后的内容要被模糊后透出来（参考 Tern），而不是被一块实色挡住。
// 靠 MyGo 着色器读窗口已经画好的背景（backdropSample）。没有 GPU 加速（虚拟机、测试）时着色器会逐像素在
// CPU 上跑，框架建议不画，所以退回成近乎不透明的纯色。

import (
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/shader"
)

var frostShader = shader.MustCompile(`package main

var Tint vec4

func Fragment(dst vec4, pos vec2) vec4 {
	b := backdropSample(pos)
	return mix(b, vec4(Tint.rgb, 1), Tint.a)
}
`)

const (
	frostBlur  = 14   // 背景模糊的标准差（DIP）
	frostAlpha = 0.62 // 磨砂层的不透明度：越小透出的文字越清楚
)

// frosted 给元素铺一层磨砂玻璃底：背后的内容模糊后与 tint 混合。radius 要与元素自己的圆角一致。
func frosted(el ui.Element, tint ui.Color, radius float32) ui.Element {
	return el.Draw(func(p *ui.Painter, r ui.Rect) {
		if !p.Accelerated() {
			p.Fill(r, tint.Alpha(0.94), radius)
			return
		}
		frostShader.Draw(p, r, shader.Options{
			BackdropBlur: frostBlur,
			Uniforms:     map[string]any{"Tint": tint.Alpha(frostAlpha)},
			Radius:       radius,
		})
	})
}
