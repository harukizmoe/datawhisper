# Git 工作流

`main` 的历史必须保持干净：**禁止直接在 `main` 上修改或提交**。

- 所有改动（含文档、测试、版本号）都从最新的 `main` 新建分支，例如 `feat/canvas-minimal`、`fix/table-name-injection`。
- 推送分支后在 GitHub 开 Pull Request；合并只使用 **squash merge**，保持线性历史。
- 分支保护要求：PR、线性历史、CI 检查通过、`strict` 分支更新；不允许强推或删除 `main`。
- 提交信息用中文，写清「做了什么 + 证据」。
- 子代理不提交、不切换分支、不 pop/drop stash；由整合者检查后统一提交。
- 发布也走 PR：版本号与 `CHANGELOG.md` 在分支上改完，合并后再打 tag。
