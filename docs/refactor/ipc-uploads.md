# 上传通道：JSONL 里不放文件字节（P6.1）

状态：已实现。实现：`server/src/ipc/sources.ts`（`source.upload.begin` / `source.open`）。
约束：界面（Go）与 agent 服务（Bun）是同一台机器上的两个进程，JSONL 只传 JSON。

## 1. 目录约定

- staging：`<DW_DATA_DIR>/uploads/incoming/<uploadId>`
- 正式副本：`<DW_DATA_DIR>/uploads/<uploadId><ext>`
- `<uploadId>` 由**服务端**生成，32 位小写十六进制；客户端从不提供路径。

## 2. 协议（两段式）

1. 界面 → `source.upload.begin`：

   ```json
   {"conversationId": 1, "filename": "sales.xlsx", "size": 1234567}
   ```

   返回 `{"uploadId":"…32 hex…","path":"/data/uploads/incoming/…","maxBytes":536870912,
   "filename":"sales.xlsx","expiresAt":"2026-01-01T00:15:00.000Z"}`。
   `begin` 已完成：会话存在、扩展名 ∈ {.csv,.xlsx,.xls,.pdf}、`size` 为正且 ≤ `maxBytes`
   （默认 512 MiB）。服务端只创建 `incoming/` 目录，**不创建** staging 文件本身。
2. 界面把文件写到 `path`：必须是普通文件，字节数恰好等于声明的 `size`；
   不要创建目录，不要写入符号链接，不要重命名/移动 `path`。写完关闭文件句柄。
3. 界面 → `source.open`：`{"conversationId": 1, "uploadId": "…", "name": "可选显示名"}`。
   服务端在进程内认领票据，然后：`lstat` 必须是普通文件（`isFile()` 且非符号链接）→
   `realpath(path)` 必须仍在 `incoming/` 内 → 实际大小 == 声明大小且 > 0 →
   扩展名再次按票据里的 `filename` 校验 → 用服务端生成的文件名 `rename` 进 `uploads/` →
   调 compute `upload.prepare` 得到 descriptor → `source.open` → 写入会话文档。
   返回 `{source: {id, name, kind, active, open, tables}, sources, configId?}`。
4. 票据 15 分钟过期（`uploadTtlMs`），每次 `begin` 会顺带清理过期 staging 文件；
   进程重启后旧票据失效，界面需要重新 `begin`。

## 3. 拒绝原因（`error.data.reason`，`code` 为 -32602）

| reason | 触发 |
|---|---|
| `unsupported_format` | 扩展名不在白名单 |
| `empty_file` | `size` 为 0 |
| `file_too_large` | 声明或实际大小超过 `maxBytes` |
| `upload_missing` | staging 文件不存在 |
| `upload_not_file` | 不是普通文件，或符号链接 |
| `upload_outside_root` | `realpath` 不在 `incoming/` 内 |
| `upload_size_mismatch` | 实际字节数与声明不一致 |
| `unknown_upload` / `upload_expired` | 票据不存在 / 已过期 |

## 4. 安全边界

- 路径穿越：`uploadId` 只做 `^[a-f0-9]{32}$` 校验，`path` 全由服务端拼出；客户端传来的
  `filename` 只用作显示名与扩展名，永不参与路径拼接（`source.remove` 也只删服务端记录的路径）。
- 符号链接：`lstat` 拒绝；`realpath` 再做一次根内包含检查，防父目录被替换。
- 大小：`begin` 先按声明拒绝，`open` 再按实际 `stat.size` 拒绝，无法用「先声明小、写大」绕过。
- 清理：校验失败立即删 staging；`upload.prepare`/`source.open` 失败删除正式副本；
  `source.remove` 删除上传副本；工作目录里的用户文件一律不删。
- 不做分块、不做 base64：大文件（含大 Excel/PDF）都走本机文件交接。

## 5. 两侧实现清单

Go：`begin` 成功后用 `os.OpenFile(path, O_WRONLY|O_CREATE|O_EXCL, 0o600)` 写入并关闭；
写失败或用户取消时删除文件、不调 `open`（票据自然过期）；`source.open` 成功后才刷新来源列表，
失败按上表展示原因。
Bun：`source.upload.begin` + `source.open` 已实现；`upload.prepare` 失败会把错误原文
（不含凭据）作为 -32000 返回，`data.reason` 取 compute 的 `data.kind`（如 `open_failed`）。

## 6. 未包含

- 进度通知：大工作簿解析在 `source.open` 调用内同步完成，暂不复用 jobs 的进度通道。
- 断点续传与并发同名文件：上传 id 唯一，天然隔离；同名只影响显示名。
