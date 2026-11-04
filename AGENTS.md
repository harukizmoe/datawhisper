# 仓库约定

## 代码注释使用中文

所有代码注释与文档注释一律使用中文，包括：

- Python 的 `#` 注释与 docstring；
- TypeScript/JavaScript 的 `//`、`/* */`、JSDoc/TSDoc；
- Go 的 `//`、`/* */`；
- SQL、Shell、YAML、JSON5（含注释的配置）里的注释。

规则细则：

1. **只改注释，不改行为**。标识符、字符串字面量、日志文案、用户可见文案、错误消息、测试断言都保持原样；注释翻译不得顺带重构代码。
2. **提示词与 golden 数据不算注释**。例如 `server/src/agent/prompt-text/*.txt`、`server/test/golden/*.json`、`server/test/fixtures/**` 属于被测数据，内容必须与旧实现逐字一致，不得翻译。
3. 术语保留英文原词（如 `snapshot`、`ops`、`requestId`、`hook`），必要时中英并列，例如「增量（ops）」。
4. 旧 Python 模块（`agent/`、`api/`、`LLM/` 等）在 P10 删除前不单独做注释翻译；模块被迁移到 `server/`、`compute/` 时，新代码直接按中文注释书写。
5. 注释解释「为什么」，复述代码在做什么的注释直接删掉。

## 提交

- 子代理不提交、不切换分支、不 pop/drop stash；由整合者检查后统一提交。
- 分支 `refactor/pi-durable` 上进行重构，`main` 保持 `87489fb` 不变。
