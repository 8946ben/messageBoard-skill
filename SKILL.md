---
name: agent-message-board
description: 多 agent 留言板协作。仅当用户明确说“使用留言板开发 / 用留言板 / 留言板协作 / 在留言板里登记”等时启用：在项目根目录维护单文件「留言板.html」，让多个 agent 对齐同一个最终目标、各自注册唯一身份、按串行工作锁（工作中/休息中）轮流干活，并以图文汇报短期目标、尝试与结果。普通开发任务、单 agent 自己干活、只问进度、只讨论或优化本 skill 时不触发，也不要主动创建留言板。
---

# 多 agent 留言板（agent-message-board）

用一个自包含的静态页面 `留言板.html` 作为项目里所有 agent 的协作中枢：页面给用户看，内嵌 JSON 给 agent 读写，读写一律通过本 skill 的 `scripts/board.js` 完成，避免多人同时改 HTML 改坏数据。

页面有四个区域，对应四种协作事实：

1. **GOAL 区**：项目的最终目标、验收标准与里程碑。所有 agent 先读它，再决定自己该干什么。
2. **Agent 工作状态区**：有哪些 agent、各自此刻在不在工作、正在做什么。**同一时刻只允许一个 agent 持有工作锁**，其他人看到「工作中」就停下等待。
3. **展示墙**：只在用户明确要求时增删的固定展板（见「5.1 展示墙」）。它不是汇报区，内容由用户决定。
4. **汇报区**：图文并茂的工作汇报，一条汇报包含短期目标、做出的尝试、取得的结果、代码位置/复测入口、下一步；顶部有搜索框和日历，可按关键词与日期查历史汇报。

## 触发规则

- 用户说「使用留言板开发」「用留言板」「留言板协作」「在留言板上登记一下」「用多 agent 留言板」时，本 skill 对本轮任务全程生效，直到任务结束。
- 用户没有这类说法时，不要创建留言板、不要往留言板写汇报，也不要主动建议（除非用户问到多 agent 协作怎么做）。
- 用户只是追问「现在谁在工作 / 进展如何」而留言板已存在时，可以只读，不用注册、不用抢锁。

## 前置条件

- 需要 Node.js（`node -v` 可用，≥ 16）。脚本零依赖，跨平台。
- 脚本路径：本 skill 实体目录下的 `scripts/board.js`（macOS / Linux 一般是
  `~/.agents/skills/agent-message-board/scripts/board.js`，Windows 是
  `%USERPROFILE%\.agents\skills\agent-message-board\scripts\board.js`）。
  加载 skill 时若给出了 base directory，就以它为根解析，不要假设当前工作目录。
- 留言板固定叫 `留言板.html`，位于**项目根目录**（即用户当前强调的项目目录）。脚本会从当前目录向上查找已有的留言板，找不到就在当前目录创建。

## 标准工作流（每个 agent 每轮都照这个走）

### 1. 读板

```powershell
node "<skill>/scripts/board.js" show
```

先把三件事看清楚：**最终目标是什么**、**已经有哪些 agent**、**现在有没有人持有工作锁**。目标区是所有人的方向，动手前必须能用自己的话说清「我这轮做的事如何推进这个目标」；对不上就先跟用户确认，不要闷头做。

### 2. 注册（第一次参与时）

```powershell
node "<skill>\scripts\board.js" join --name 小鹿 --role 前端 --harness dsh --model deepseek-flash
```

- 脚本分配**全局唯一**的 `id`（形如 `a-1f2c`）并检查昵称唯一；昵称被占用会自动改成 `小鹿2`，并在输出里告诉你。
- 想固定 id 便于后续复用：`--id lumi`（2–24 位小写字母/数字/`-`/`_`，重复即报错）。
- 已有 id 再次 `join --id <你的id>` 就是恢复身份，不会重复注册。
- 昵称要有辨识度，别用「agent」「助手」这类通用名。注册后把自己的 `id` 记牢，本轮所有命令都要带 `--as <id>`。
- **用 `--harness` 和 `--model` 声明自己跑在什么 harness、什么模型上**（如 `--harness dsh --model deepseek-flash`，
  或 `--harness codex --model gpt-5.1`）。页面会在每张 agent 卡上显示「昵称 + 角色 + harness · 模型」，
  方便用户和别的 agent 判断「这条结论是谁、用什么环境/模型跑出来的」。已经注册过但没写的，用
  `board.js meta --as <你的id> --harness "dsh" --model "…"` 补上（`model --set` 只改模型）。

### 3. 抢锁（唯一的开工许可）

```powershell
node "<skill>\scripts\board.js" claim --as <id> --task "本轮短期目标一句话"
```

- 成功：状态变「工作中」，页面锁条变橙色，其他 agent 会看到。
- 失败（**退出码 2**）：别人正在工作。此时**绝对不要**动项目文件、不要跑构建、不要改同一个页面。按下面二选一：
  - 向用户报告「X 正在工作，我先等待」，本轮结束；或
  - 用 `wait` 在后台等锁：`node "<skill>\scripts\board.js" wait --as <id> --timeout 600`（超时仍返回 2，同样只能等）。
- `--task` 必写：它既是给用户看的进度，也是别人判断你是不是在做同一件事的依据。
- 只在拿到锁之后才修改项目文件；读文件、查资料、写方案这类不冲突的准备工作可以在等待时做。

### 4. 干活 + 续约

- 长任务（超过约 10 分钟）每做一段就续约一次，避免别人把你看成崩溃残留：
  `node "<skill>\scripts\board.js" heartbeat --as <id>`
- 关键节点（跑通、改方案、遇阻）就写一条 `progress`/`blocked` 汇报，不用等全部做完。
- 不要每条命令都写汇报，一个有意义阶段一条即可。

### 5. 汇报（图文并茂）

```powershell
node "<skill>\scripts\board.js" report --as <id> --kind result `
  --title "首页骨架跑通，本地预览无报错" `
  --goal "搭出首页骨架并跑通本地预览" `
  --attempt "单文件 HTML + 内联 CSS 起骨架" `
  --attempt "grid 三栏，窄屏降为单列" `
  --result "本地双击打开正常，控制台 0 报错" `
  --result "390px 窄屏不横向溢出" `
  --image "assets/board/home.png::首页骨架预览" `
  --code "scripts/build_index.py:42 build_index() 入口" `
  --code "results/table.md 产物；复跑: python scripts/09_make_table.py" `
  --tag 前端 --next "接入天气数据源，先用假数据占位"
```

汇报质量要求：

- `--title` 写结论，不写「更新进展」；一眼能看出这轮发生了什么。
- `--goal` 是**本轮**短期目标，与最终目标区分开。
- `--attempt` 写真实做过的尝试，**包括失败的**；`--result` 写可验证的结果（数字、报错、通过范围）。
- `--code` 写**代码位置 / 复测入口**（脚本:行号、产物文件、复现命令）。它渲染成与「取得的结果」**并列**的独立区块，不要塞进 `--result` 当成果——成果是结论，入口是让别人能跑出来的路径。
- 有画面就配图：截图存到项目里的 `assets/board/`，用**相对路径**引用（跨机器可移植）；单张建议 < 1.5 MB，超过就先压缩或截关键区域；不要贴整屏源码或长日志。多张图用多个 `--image`，图注用 `::` 分隔。
- `--kind blocked` 用于卡住：写清卡在哪、需要谁/什么才能继续。
- `--next` 留给接手的人，让下一个 agent 不用重新摸索。
- 一次工作有多个成果时，写**一条**汇报、内部分多段（`--result` 多条），不要拆成一堆汇报。
- 不要把密码、token、内网地址、用户隐私写进留言板——这个文件是给用户长期打开的。

### 5.1 展示墙（只在用户明确要求时动）

页面「Agent 工作状态」下面有一块**展示墙**，放用户在对话里指定要贴的成果：

```powershell
node "<skill>\scripts\board.js" wall --add "标题::一句话说明::assets/board/x.png"   # 贴上一项
node "<skill>\scripts\board.js" wall --remove w-0001                        # 换下一项
node "<skill>\scripts\board.js" wall --list                                  # 看现在贴着什么
```

- 只有用户明确说「把 X 贴到展示墙 / 换下来」时才动；不要自己把成果往上贴。
- 展示墙不是汇报区：它是用户的固定展板，内容由用户决定，agent 只负责执行增删。

### 6. 收工（必须释放锁）

```powershell
node "<skill>\scripts\board.js" release --as <id> --summary "本轮结论一句话"
```

- 状态回到「休息中」，锁条变绿，下一个 agent 才能开工。
- 中途被打断、任务失败也要 `release`；确实崩了没释放，见下文「异常处理」。
- 收工前自检：页面打开无报错、锁已空、你这条汇报能让别人看懂。

## 串行协作规则（最重要）

- **同一时刻一个项目只允许一个 agent 持有工作锁**。没有锁就改文件，等于和别人互相覆盖。
- 看到「工作中」不要抢、不要 `--takeover`、不要「我就改一个小地方」。等，或者去做不需要写文件的准备。
- 不要手工删 `.留言板.lock`；锁由脚本管理，异常时才按下面流程接管。
- 汇报写入本身允许在无锁时发生（例如交接说明），但**任何对项目产物的修改**都必须在持锁期间。

## 目标区维护

- 只在两种情况改目标：用户明确给了新目标/新验收标准；或用户确认要调整范围。
- 目标要能验收：写清「做成什么样算完成」，不要写口号。
- 里程碑随进展更新：

```powershell
node "<skill>\scripts\board.js" goal --set "上线一个可用 7 天的本地天气看板" --detail "验收：手机端可用、离线可开、数据每天更新"
node "<skill>\scripts\board.js" goal --milestone "搭出页面骨架" --milestone "接入天气数据源" --milestone "部署上线"
node "<skill>\scripts\board.js" goal --milestone-done 1 --as <id>
```

- 里程碑序号就是 `show` 里显示的序号；不确定就先 `show` 看一眼。

## 异常处理

| 现象 | 处理 |
| --- | --- |
| `claim` 退出码 2 | 别人在忙：等待或向用户报告，不要开工 |
| 锁的心跳超过 20 分钟 | 先 `show` 核对任务与时间，再问用户「对方是否已停止」；确认后 `claim --as <id> --takeover --reason "…"` |
| 自己崩溃后回来，锁还在自己名下 | `claim --as <id>` 会沿用原锁；收工照常 `release` |
| 只想清理残留锁 | `release --as <锁持有者id> --force`，随后在汇报里说明接管原因 |
| `validate` 报错 | 按提示修数据（重复 id、汇报挂到不存在的 agent、图片缺失）；修完再 `validate` |
| 页面打开一片空白/报「数据解析失败」 | JSON 被改坏：用 `validate` 定位，从 `report`/`goal` 重新写入该字段，不要整页重写 |
| 找不到 Node | 降级方案：只改 `<script id="mb-data">` 里的 JSON，保持结构不变，改完用浏览器打开确认能渲染 |

## 手工编辑的边界

- 优先用脚本。脚本保证：唯一 id、锁的原子性、JSON 合法、`</script>` 转义、原子写（临时文件 + rename）。
- 必须手工改时，只改 `mb-data` 数据块内的 JSON，不要动页面结构、样式和渲染脚本；改完跑 `validate` 并在浏览器里看一眼。
- 不要删除别的 agent 的记录来「保持整洁」；历史汇报是协作证据。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `init --goal "…" [--detail "…"] [--milestone "…"]` | 创建（或复用）留言板，写入最终目标 |
| `join --name 昵称 [--id 固定id] [--role 角色] [--harness 环境] [--model 模型]` | 注册 / 恢复身份，分配唯一 id |
| `meta --as <id> --harness "dsh" --model "…"` | 记录 / 更新自己的 harness 与模型（可只给一个） |
| `model --as <id> --set "…"` | 只改模型（= `meta --model`） |
| `show [--json]` | 读目标、agent 状态、锁、最近汇报 |
| `claim --as <id> --task "…" [--takeover --reason "…"]` | 抢工作锁开工（退出码 2 = 有人在忙） |
| `wait --as <id> [--timeout 600] [--interval 10]` | 等锁释放并自动 claim |
| `heartbeat --as <id>` | 续约，防止被当成崩溃残留 |
| `report --as <id> --kind start\|progress\|result\|blocked\|handoff --title "…" …` | 写一条图文汇报 |
| `wall --add "标题::说明::图片"` / `wall --remove <id>` / `wall --list` | 展示墙增删（仅按用户明确指令） |
| `release --as <id> [--summary "…"] [--result "…"]` | 收工、释放锁、状态回「休息中」（带 `--summary` 会顺带写一条结果汇报） |
| `goal --set/--detail/--milestone/--milestone-done/--milestone-doing` | 维护目标与里程碑 |
| `state --as <id> --state working\|resting\|waiting\|offline` | 单独改状态（不常用） |
| `leave --as <id>` | 标记离开项目，保留记录 |
| `validate` | 校验数据完整性，页面异常时先跑它 |
| `open` | 用默认浏览器打开留言板 |
| `path` | 打印留言板绝对路径 |

## 收尾汇报给用户

- 给出留言板路径（可点击），例如 `D:\proj\留言板.html`；需要时 `open` 打开。
- 一句话说明：当前目标、谁在工作、你这条汇报的结论、下一步。
- 用户没要求时不要反复贴页面全文或整段 JSON。

## 数据结构

字段含义、默认值与手改注意事项见 [references/board-schema.md](references/board-schema.md)；只有需要手工改 JSON 或排查页面渲染问题时再读。
