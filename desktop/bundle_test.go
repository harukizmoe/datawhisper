package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// writeExecutable 在 path 写一个可执行的空文件（Windows 上没有可执行位）。
func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestBundledInSideBySide 覆盖 Linux 与 Windows 的布局：bin/ 就在可执行文件旁边。
func TestBundledInSideBySide(t *testing.T) {
	app := t.TempDir()
	server := filepath.Join(app, "bin", exeName(runtime.GOOS, "datawhisper-server"))
	compute := filepath.Join(app, "bin", exeName(runtime.GOOS, "datawhisper-compute"))
	writeExecutable(t, server)
	writeExecutable(t, compute)

	got, ok := bundledIn(app, runtime.GOOS)
	if !ok {
		t.Fatal("bundledIn found no bundled service next to the executable")
	}
	if got.root != app || got.service != server || got.compute != compute {
		t.Fatalf("bundledIn = %+v, want root %q service %q compute %q", got, app, server, compute)
	}
}

// TestBundledInMacOSResources 覆盖 macOS 应用包：可执行文件在 Contents/MacOS，资源在 Contents/Resources。
func TestBundledInMacOSResources(t *testing.T) {
	app := t.TempDir()
	macos := filepath.Join(app, "Contents", "MacOS")
	resources := filepath.Join(app, "Contents", "Resources")
	if err := os.MkdirAll(macos, 0o755); err != nil {
		t.Fatal(err)
	}
	server := filepath.Join(resources, "bin", "datawhisper-server")
	compute := filepath.Join(resources, "bin", "datawhisper-compute")
	writeExecutable(t, server)
	writeExecutable(t, compute)

	got, ok := bundledIn(macos, "darwin")
	if !ok {
		t.Fatal("bundledIn found no bundled service in Contents/Resources")
	}
	if got.root != resources || got.service != server || got.compute != compute {
		t.Fatalf("bundledIn = %+v, want root %q service %q compute %q", got, resources, server, compute)
	}
}

// TestBundledInNeedsTheService 说明只有 compute 时不进入打包模式。
func TestBundledInNeedsTheService(t *testing.T) {
	app := t.TempDir()
	writeExecutable(t, filepath.Join(app, "bin", exeName(runtime.GOOS, "datawhisper-compute")))
	if got, ok := bundledIn(app, runtime.GOOS); ok {
		t.Fatalf("bundledIn = %+v, want no bundled service", got)
	}
}

// TestBundledInIgnoresNonExecutable 说明没有可执行位的同名文件不会被当成随包服务（Windows 没有可执行位）。
func TestBundledInIgnoresNonExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no executable bit")
	}
	app := t.TempDir()
	server := filepath.Join(app, "bin", "datawhisper-server")
	if err := os.MkdirAll(filepath.Dir(server), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(server, []byte("not executable\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, ok := bundledIn(app, runtime.GOOS); ok {
		t.Fatalf("bundledIn = %+v, want no bundled service", got)
	}
}

// TestExeName 说明 Windows 的 .exe 后缀。
func TestExeName(t *testing.T) {
	if got := exeName("windows", "datawhisper-server"); got != "datawhisper-server.exe" {
		t.Fatalf("exeName(windows) = %q", got)
	}
	if got := exeName("linux", "datawhisper-server"); got != "datawhisper-server" {
		t.Fatalf("exeName(linux) = %q", got)
	}
}
