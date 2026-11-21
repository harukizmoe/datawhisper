# DataWhisper

本地单用户桌面数据分析应用：对话产生数据源、分析、图表与画布；agent 与用户共同操作同一份会话文档。

## Language

**画布（Canvas）**:
会话内的一张可编辑矢量图，由 agent 或用户创建并交替修改。
_Avoid_: 白板、图板、draw.io 文件

**画布文档（Canvas document）**:
画布的唯一持久形态，包含节点、连线与版本号；界面和 agent 都只通过操作修改它。
_Avoid_: XML、drawio、画布 JSON（对用户说话时）

**节点（Node）**:
画布上的一个图形元素（矩形、圆角框、椭圆、菱形、文本、备注、容器）。
_Avoid_: 形状、图元、cell

**连线（Edge）**:
两个节点之间的有向或无向连接，可带标签与路由方式。
_Avoid_: 箭头、边、link

**画布操作（Canvas operation）**:
对画布文档的一次原子修改；一次提交可以包含一批操作，任一无效则整批不生效。
_Avoid_: patch、diff、命令

**版本号（Revision）**:
画布文档的单调递增版本，用于检测并发修改；提交时携带基准版本。
_Avoid_: 快照、revision number、版本历史

**画布模板（Canvas template）**:
预置的节点/连线布局，可按名称套用并填入内容（如商业模式画布、SWOT）。
_Avoid_: 主题、皮肤、样式

**画布卡片（Canvas card）**:
对话流中指向某张画布的入口，显示标题与缩略图，点击打开画布。
_Avoid_: 预览图、缩略图卡片
