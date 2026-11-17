# 留言板数据结构（message-board/1）

`留言板.html` 的页面结构、样式与渲染脚本都不需要 agent 关心；agent 只需读写其中这一段：

```html
<script type="application/json" id="mb-data">
{ ...这里是一整个 JSON... }
</script>
```

`scripts/board.js` 负责解析、修改、原子写回（临时文件 + rename），并给 `</script>` 做转义。正常情况永远走脚本；只有排查渲染问题或没有 Node 时才手工改。

## 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema` | string | 固定 `"message-board/1"`，渲染脚本据此判断兼容性 |
| `project` | object | `name` 项目名、`file` 文件名、`root` 项目根、`created` / `updated`（脚本自动维护） |
| `goal` | object | 最终目标，见下 |
| `lock` | object | 工作锁的**展示镜像**（真身在同目录 `.留言板.lock`） |
| `agents` | array | 参与协作的 agent |
| `wall` | array | 展示墙：用户指定要贴的成果卡片（`id/title/body/image/addedBy/addedAt`），agent 只在用户明确要求时增删 |
| `reports` | array | 汇报时间线，按写入顺序追加 |
| `activity` | array | 操作流水（join/claim/release/takeover…），脚本只保留最近 400 条 |

## goal

```json
{
  "title": "上线一个可用 7 天的本地天气看板",
  "detail": "验收：手机端可用、离线可开、数据每天自动更新",
  "milestones": [
    { "id": "m1", "text": "搭出页面骨架", "state": "done" },
    { "id": "m2", "text": "接入天气数据源", "state": "doing" },
    { "id": "m3", "text": "部署上线", "state": "todo" }
  ],
  "updatedAt": "2026-11-10T09:40:00+08:00",
  "updatedBy": "lumi"
}
```

- `state` 只有 `done` / `doing` / `todo` 三种；进度条与百分比按 `done` 计数。
- `title` 必须可验收，不要写口号；`detail` 放验收标准或边界。
- `updatedBy` 是 agent id，可为空字符串（`init` 时）。

## agents

```json
{
  "id": "lumi",
  "name": "小鹿",
  "emoji": "🦌",
  "color": "#7c9e6f",
  "role": "前端",
  "model": "deepseek-flash",
  "state": "working",
  "task": "把 7 天天气渲染成卡片列表",
  "since": "2026-11-10T09:50:00+08:00",
  "joinedAt": "2026-11-10T09:40:00+08:00",
  "lastSeen": "2026-11-10T09:55:00+08:00",
  "reports": 3,
  "note": ""
}
```

- `id` 全局唯一，2–24 位小写字母/数字/`-`/`_`；脚本默认生成 `a-1f2c` 形式。
- `name` 唯一（大小写不敏感），脚本在重名时自动加序号。
- `model` 该 agent 运行的模型名（如 `deepseek-flash` / `qwen3.8-27b`），注册时用 `join --model` 声明；
  缺省时页面显示「模型未标注」，可用 `model --as <id> --set "…"` 补。
- `state`：`working`（持有锁）/ `resting`（休息）/ `waiting`（等条件）/ `offline`（已离开）。
- `task` 只在工作中非空；`since` 是本轮开始时间；`reports` 由脚本按汇报数回填。

## lock

```json
{ "agentId": "lumi", "task": "把 7 天天气渲染成卡片列表",
  "since": "2026-11-10T09:50:00+08:00", "heartbeat": "2026-11-10T09:55:00+08:00" }
```

- 这是页面上的展示镜像；**互斥判定以同目录的 `.留言板.lock` 为准**（含 `host`、`pid`、`token`）。
- 空闲时 `agentId` 为 `null`，其余为空。
- 心跳超过 20 分钟即视为疑似崩溃，页面会显示黄色/红色警告，允许 `claim --takeover`。

## reports

```json
{
  "id": "r-0003",
  "agentId": "lumi",
  "kind": "result",
  "time": "2026-11-10T09:58:00+08:00",
  "title": "首页骨架跑通，本地预览无报错",
  "shortGoal": "搭出首页骨架并跑通本地预览",
  "attempts": ["单文件 HTML + 内联 CSS 起骨架", "grid 三栏，窄屏降为单列"],
  "results": ["本地双击打开正常，控制台 0 报错", "390px 窄屏不横向溢出"],
  "codes": ["scripts/build.py:42 入口函数", "results/table.md 产出"],
  "images": [{ "src": "assets/board/home.png", "caption": "首页骨架预览" }],
  "next": "接入天气数据源，先用假数据占位",
  "tags": ["前端", "骨架"]
}
```

- `kind`：`start` 开工、`progress` 进展、`result` 结果、`blocked` 受阻、`handoff` 交接。
- `id` 递增 `r-0001`，用于引用；不要复用旧 id。
- `images[].src` 优先级：相对路径（推荐，页面按 HTML 所在目录解析）> `file:///` 绝对地址 > `https://` > `data:` 内联（体积大，少用）。
- 图片放 `assets/board/`，文件名用英文或数字，避免空格与 `#`。
- `attempts` / `results` 允许为空，但一条 `result` 汇报至少要有其一。
- `codes`：可选的「代码位置 / 复测入口」列表（脚本:行号、产出文件、复现命令）。页面渲染成与「取得的结果」并列的独立区块，不计入成果条目；缺省时不显示。

## 不变量（`validate` 检查）

1. JSON 可解析，`schema` 为 `message-board/1`。
2. `agents[].id` 与 `reports[].id` 各自唯一。
3. 每条汇报的 `agentId` 必须存在于 `agents`。
4. `images[].src` 为相对路径时文件必须存在。
5. 工作锁持有者必须存在于 `agents`；页面 `lock` 与 `.留言板.lock` 不一致时报警（任一写命令会修正）。
6. `state === "working"` 的 agent 应当对应非空 `lock.agentId`。

## 手工编辑清单

1. 只改 `<script type="application/json" id="mb-data">` 与 `</script>` 之间的内容。
2. 保持 JSON 合法：用双引号，末尾不加逗号，中文直接写（文件是 UTF-8，无 BOM）。
3. 不要写 `</script>` 字面量（会被当成标签结束）；脚本写入时会转义成 `<\/script>`。
4. 改完运行 `node board.js validate`，再在浏览器里刷新看渲染。
5. 页面渲染脚本不认识的多余字段不会导致报错，但别改字段名——该字段会直接被忽略。
