#!/usr/bin/env node
/**
 * 留言板 board.js —— 多 agent 串行协作看板的读写工具
 *
 * 设计：
 *   - 数据以 JSON 形式内嵌在「留言板.html」的 <script id="mb-data"> 中，页面打开即在本地渲染。
 *   - 本脚本负责读取/修改该 JSON：原子写（临时文件 + rename）、进程写锁、工作锁（串行）。
 *   - 工作锁同时落一个旁路文件 .留言板.lock，供并发 claim 判定；页面里的 lock 字段是它的展示镜像。
 *
 * 退出码：0 = 成功；1 = 参数/文件错误；2 = 工作锁被他人占用（应等待，不要开工）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const BOARD_NAMES = ["留言板.html", "message-board.html"];
const DATA_ID = "mb-data";
const PLACEHOLDER = "/*__MB_DATA__*/null";
const LOCK_NAME = ".留言板.lock";
const WLOCK_NAME = ".留言板.write.lock";
const STALE_MS = 20 * 60 * 1000;   // 心跳超过 20 分钟视为疑似崩溃
const SCHEMA = "message-board/1";
const TEMPLATE = path.join(__dirname, "..", "assets", "board-template.html");

const KINDS = ["start", "progress", "result", "blocked", "handoff"];

/* ------------------------------------------------------------------ 基础 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

function fail(msg) {
  process.stderr.write("✖ " + msg + "\n");
  process.exit(1);
}

class BusyError extends Error {
  constructor(msg) {
    super(msg);
    this.code = "BUSY";
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  const multi = new Set(["attempt", "result", "tag", "milestone", "milestone-done",
    "milestone-doing", "image", "caption", "code", "add", "remove"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let key = a.slice(2);
    let val = true;
    const eq = key.indexOf("=");
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { val = argv[++i]; }
    if (!(key in out)) out[key] = multi.has(key) ? [val] : val;
    else if (Array.isArray(out[key])) out[key].push(val);
    else out[key] = multi.has(key) ? [out[key], val] : val;
  }
  return out;
}

function bool(v) {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  return !/^(false|0|no|off)$/i.test(String(v));
}

/* ------------------------------------------------------- 定位与读写留言板 */

function findBoard(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.MB_BOARD) return path.resolve(process.env.MB_BOARD);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    for (const n of BOARD_NAMES) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(process.cwd(), BOARD_NAMES[0]);
}

function extractBlock(raw) {
  const i = raw.indexOf('id="' + DATA_ID + '"');
  if (i < 0) throw new Error('找不到数据块 <script id="' + DATA_ID + '">，文件可能被重写坏');
  const gt = raw.indexOf(">", i);
  if (gt < 0) throw new Error("数据块开始标签不完整");
  const end = raw.indexOf("</script>", gt);
  if (end < 0) throw new Error("数据块缺少 </script>");
  return { start: gt + 1, end, text: raw.slice(gt + 1, end) };
}

function readData(file) {
  const raw = fs.readFileSync(file, "utf8");
  const blk = extractBlock(raw);
  let data;
  try {
    data = JSON.parse(blk.text.trim());
  } catch (e) {
    throw new Error("留言板内嵌 JSON 解析失败：" + e.message + "（可运行 validate 或在浏览器控制台查看）");
  }
  if (!data || typeof data !== "object") throw new Error("留言板数据为空");
  data.agents = data.agents || [];
  data.reports = data.reports || [];
  data.activity = data.activity || [];
  data.goal = data.goal || { title: "", detail: "", milestones: [] };
  data.lock = data.lock || { agentId: null };
  data.project = data.project || {};
  return { data, raw };
}

async function writeData(file, data, raw) {
  const src = raw || fs.readFileSync(file, "utf8");
  const blk = extractBlock(src);
  data.project = data.project || {};
  data.project.updated = nowIso();
  if (data.activity && data.activity.length > 400) data.activity = data.activity.slice(-400);
  let json = JSON.stringify(data, null, 2).replace(/<\/(script)/gi, "<\\/$1");
  const next = src.slice(0, blk.start) + "\n" + json + "\n" + src.slice(blk.end);
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, next, "utf8");
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(80 + i * 60);
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw new Error("写入留言板失败：" + (lastErr && lastErr.message));
}

/** 进程级写锁：串行化所有 read-modify-write，避免两个 agent 互相覆盖。 */
async function withWriteLock(file, fn) {
  const lockFile = path.join(path.dirname(file), WLOCK_NAME);
  const token = crypto.randomBytes(6).toString("hex");
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, time: nowIso() }));
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 15000) { fs.unlinkSync(lockFile); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error("等待写锁超时（另一个进程正在写入留言板）");
      await sleep(70);
    }
  }
}

/* --------------------------------------------------------------- 工作锁 */

const lockFileOf = (file) => path.join(path.dirname(file), LOCK_NAME);

function readWorkLock(file) {
  try { return JSON.parse(fs.readFileSync(lockFileOf(file), "utf8")); } catch { return null; }
}

function writeWorkLock(file, obj) {
  fs.writeFileSync(lockFileOf(file), JSON.stringify(obj, null, 2), "utf8");
}

function lockAgeMs(lock) {
  const t = Date.parse((lock && (lock.heartbeat || lock.since)) || 0);
  return Date.now() - (isNaN(t) ? 0 : t);
}

/* ------------------------------------------------------------- 数据辅助 */

const NAME_POOL = [
  ["小鹿", "🦌", "#7c9e6f"], ["青柠", "🍋", "#8fae3a"], ["墨竹", "🎋", "#3f7d4e"],
  ["松果", "🌰", "#a16207"], ["白鸽", "🕊️", "#4b7ecb"], ["海盐", "🧂", "#5b8ca8"],
  ["橘子", "🍊", "#c2410c"], ["雪豹", "🐆", "#7a4f9e"], ["芦苇", "🌾", "#b8863b"],
  ["山雀", "🐦", "#0f766e"], ["风铃", "🎐", "#9d3f6b"], ["栗子", "🌰", "#8a5a2b"],
  ["苏打", "🥤", "#2f7d8f"], ["柚木", "🪵", "#8a6a30"], ["云杉", "🌲", "#2f6b40"],
  ["灯笼", "🏮", "#b03030"], ["苔藓", "🪨", "#5f7a52"], ["陶土", "🏺", "#a05a35"],
  ["玻璃", "🫧", "#4a8ca0"], ["琥珀", "🟠", "#b47a1e"], ["海豚", "🐬", "#3b7bb5"],
  ["猫头鹰", "🦉", "#6b5b3a"], ["狐狸", "🦊", "#c25a2c"], ["企鹅", "🐧", "#34548a"],
];

function agentOf(data, id) {
  return (data.agents || []).find((a) => a.id === id) || null;
}

function mustAgent(data, id) {
  if (!id) fail("缺少 --as <agent-id>（先用 join 获取 id，或 board.js show 查看现有 agent）");
  const a = agentOf(data, id);
  if (!a) fail("未注册的 agent: " + id + "。首次参与请先：board.js join --name \"你的昵称\"");
  return a;
}

function uniqueName(data, want) {
  const used = new Set((data.agents || []).map((a) => String(a.name || "").toLowerCase()));
  if (want && !used.has(String(want).toLowerCase())) return want;
  if (want) {
    for (let i = 2; i < 200; i++) {
      const c = want + i;
      if (!used.has(c.toLowerCase())) return c;
    }
  }
  for (const [n] of NAME_POOL) if (!used.has(n.toLowerCase())) return n;
  for (let i = 2; i < 500; i++) {
    const c = "分身上路" + i;
    if (!used.has(c.toLowerCase())) return c;
  }
  return "agent-" + crypto.randomBytes(2).toString("hex");
}

function paletteFor(name) {
  const base = String(name).replace(/\d+$/, "");
  const hit = NAME_POOL.find((n) => n[0] === base);
  if (hit) return { emoji: hit[1], color: hit[2] };
  const PAL = ["#c2410c", "#3f7d4e", "#4b7ecb", "#8a6a30", "#7a4f9e", "#0f766e", "#a16207", "#9d3f6b"];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return { emoji: "🤖", color: PAL[h % PAL.length] };
}

function newAgentId(data) {
  const used = new Set((data.agents || []).map((a) => a.id));
  for (;;) {
    const id = "a-" + crypto.randomBytes(2).toString("hex");
    if (!used.has(id)) return id;
  }
}

function pushActivity(data, agentId, event, text) {
  data.activity.push({ time: nowIso(), agentId: agentId || "", event, text: text || "" });
}

function syncLockMirror(data, lock) {
  data.lock = lock
    ? { agentId: lock.agentId, task: lock.task || "", since: lock.since || null, heartbeat: lock.heartbeat || null }
    : { agentId: null, task: "", since: null, heartbeat: null };
}

function reportCount(data, agentId) {
  return (data.reports || []).filter((r) => r.agentId === agentId).length;
}

function nextReportId(data) {
  let max = 0;
  for (const r of data.reports || []) {
    const m = /^r-(\d+)$/.exec(r.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "r-" + String(max + 1).padStart(4, "0");
}

function blankData(file, projectName) {
  const dir = path.dirname(file);
  return {
    schema: SCHEMA,
    project: {
      name: projectName || path.basename(dir) || "项目",
      file: path.basename(file),
      root: dir,
      created: nowIso(),
      updated: nowIso(),
    },
    goal: { title: "", detail: "", milestones: [], updatedAt: nowIso(), updatedBy: "" },
    lock: { agentId: null, task: "", since: null, heartbeat: null },
    agents: [],
    reports: [],
    wall: [],
    activity: [],
  };
}

function normalizeImage(p, boardFile) {
  if (!p) return "";
  if (/^(data:|https?:)/i.test(p)) return p;
  const boardDir = path.dirname(boardFile);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(boardDir, p);
  if (path.isAbsolute(p)) {
    if (!fs.existsSync(abs)) process.stderr.write("⚠ 图片不存在：" + p + "\n");
    const rel = path.relative(boardDir, abs);
    if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
    return "file:///" + abs.split(path.sep).join("/");
  }
  if (!fs.existsSync(abs)) {
    const alt = path.resolve(p);
    if (fs.existsSync(alt)) {
      const rel = path.relative(boardDir, alt);
      if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
      return "file:///" + alt.split(path.sep).join("/");
    }
    process.stderr.write("⚠ 图片不存在（已按原样写入）：" + p + "\n");
  }
  return p.split(path.sep).join("/");
}

function collectImages(argv, boardFile) {
  const imgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image") {
      let v = argv[++i] || "";
      let cap = "";
      const sep = v.indexOf("::");
      if (sep > 0) { cap = v.slice(sep + 2); v = v.slice(0, sep); }
      if (!v) continue;
      if (/^data:/i.test(v) && v.length > 2.5 * 1024 * 1024) {
        process.stderr.write("⚠ 内联图片约 " + Math.round(v.length / 1024 / 1024) + "MB，页面会变慢，建议改存相对路径\n");
      }
      imgs.push({ src: normalizeImage(v, boardFile), caption: cap });
    } else if (argv[i] === "--caption" && imgs.length) {
      imgs[imgs.length - 1].caption = argv[++i] || "";
    }
  }
  return imgs;
}

/* ---------------------------------------------------------------- 命令 */

const HELP = `留言板 board.js —— 多 agent 串行协作看板

  用法: node board.js <命令> [选项]

  命令:
    init       创建 留言板.html（已存在则复用）；--goal 写入项目最终目标
    join       注册为新的 agent，分配唯一 id 与昵称;  --name 昵称 [--id 指定id] [--role 角色]
    show       查看目标 / agent 状态 / 工作锁 / 最近汇报（--json 输出原始 JSON）
    claim      抢占工作锁开工;  --as <id> --task "本次短期目标" [--takeover --reason "…"]
    wait       等锁释放后自动 claim;  --as <id> [--timeout 秒] [--interval 秒]
    heartbeat  续约工作锁（长任务时定期调用）
    release    结束工作、释放锁;  --as <id> [--summary "…"]
    report     写一条汇报;  --as <id> --title "…" [--kind start|progress|result|blocked|handoff]
                   [--goal "短期目标"] [--attempt "试过什么"]... [--result "得到什么"]...
                   [--image 图片路径或dataURI[::图注]]... [--next "下一步"] [--tag 标签]...
                   [--code "代码位置/复测入口（脚本:行号 或 复现命令）"]...
    wall       展示墙：只按用户明确指令贴/换内容;  --add "标题::说明::图片" [--remove <id>] [--list]
    goal       维护最终目标;  --set "目标" [--detail "验收标准"] [--milestone "里程碑"]
                   [--milestone-done <序号>] [--milestone-doing <序号>]
    state      改自己的状态;  --as <id> --state resting|waiting|working|offline [--note "…"]
    meta       记录自己运行的 harness / 模型;  --as <id> --harness "dsh" --model "deepseek-flash"
    model      只改模型（meta 的简写）;  --as <id> --set "deepseek-flash"
    leave      离开项目（状态置为 offline 并释放锁）;  --as <id>
    validate   校验数据完整性（JSON、id 唯一、汇报归属、图片存在）
    open       用默认浏览器打开留言板
    path       打印留言板绝对路径

  全局选项:
    --board <路径>   指定留言板文件（默认从当前目录向上查找 留言板.html）
    --json           机器可读输出（show/join/claim 等）
`;

const list = (v) => (v === undefined || v === null ? [] : [].concat(v).filter((x) => x !== "" && x !== true).map((x) => String(x)));

/* ------------------------------------------------------------ 目标区维护 */

function setMilestone(mss, which, state) {
  for (const v of [].concat(which)) {
    const s = String(v).trim();
    const m = /^\d+$/.test(s) ? mss[Number(s) - 1] : mss.find((x) => x.text === s || x.id === s);
    if (!m) fail("找不到里程碑：" + s + "（现有：" + mss.map((x, i) => i + 1 + "." + x.text).join(" / ") + "）");
    m.state = state;
  }
}

function applyGoal(data, args, actor) {
  let changed = false;
  const titleArg = args.goal !== undefined ? args.goal : args.set;
  if (titleArg !== undefined && titleArg !== true) {
    data.goal.title = String(titleArg);
    changed = true;
  }
  if (args.detail !== undefined && args.detail !== true) {
    data.goal.detail = String(args.detail);
    changed = true;
  }
  const mss = (data.goal.milestones = data.goal.milestones || []);
  for (const v of list(args.milestone)) {
    if (!mss.some((m) => m.text === v)) {
      mss.push({ id: "m" + (mss.length + 1), text: v, state: "todo" });
      changed = true;
    }
  }
  if (args["milestone-done"] !== undefined) { setMilestone(mss, args["milestone-done"], "done"); changed = true; }
  if (args["milestone-doing"] !== undefined) { setMilestone(mss, args["milestone-doing"], "doing"); changed = true; }
  if (changed) {
    data.goal.updatedAt = nowIso();
    data.goal.updatedBy = actor || "";
  }
  return changed;
}

/* ------------------------------------------------------------------ init */

async function cmdInit(file, args) {
  const existed = fs.existsSync(file);
  if (!existed) {
    if (!fs.existsSync(TEMPLATE)) fail("找不到模板：" + TEMPLATE);
    const tpl = fs.readFileSync(TEMPLATE, "utf8");
    if (tpl.indexOf(PLACEHOLDER) < 0) fail("模板缺少数据占位符：" + PLACEHOLDER);
    const data = blankData(file, args.project || args.name);
    if (args.goal || args.detail || args.milestone) applyGoal(data, args, "");
    data.project.created = nowIso();
    pushActivity(data, "", "init", "创建留言板");
    const json = JSON.stringify(data, null, 2).replace(/<\/(script)/gi, "<\\/$1");
    const out = tpl.replace(PLACEHOLDER, () => "\n" + json + "\n");
    await withWriteLock(file, async () => {
      fs.writeFileSync(file, out, "utf8");
    }).catch((e) => fail(e.message));
    process.stdout.write(
      "✔ 已创建留言板：" + file + "\n" +
      "  项目：" + data.project.name + "\n" +
      (data.goal.title ? "  目标：" + data.goal.title + "\n" : "  ⚠ 目标为空：请向用户确认项目最终目标，再运行 goal --set \"…\"\n") +
      "  下一步：board.js join --name \"你的昵称\"\n"
    );
    return;
  }

  // 已存在：只在给了目标相关参数时更新
  const touched = ["goal", "detail", "milestone", "milestone-done", "milestone-doing"].some((k) => args[k] !== undefined);
  if (touched) {
    await withWriteLock(file, async () => {
      const { data, raw } = readData(file);
      if (applyGoal(data, args, args.by || "")) {
        pushActivity(data, args.by || "", "goal", "更新项目目标");
      }
      await writeData(file, data, raw);
    });
  }
  const { data } = readData(file);
  process.stdout.write(
    "ℹ 留言板已存在，直接复用：" + file + "\n" +
    "  项目：" + (data.project.name || "?") + "\n" +
    "  目标：" + (data.goal.title || "（未填写）") + "\n" +
    "  agent：" + data.agents.length + " 位 · 汇报：" + data.reports.length + " 条\n"
  );
}

/* ------------------------------------------------------------------ join */

async function cmdJoin(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file + "\n  先运行 board.js init --goal \"项目最终目标\"");
  const out = await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const wantId = args.id && args.id !== true ? String(args.id) : "";
    if (wantId) {
      const exist = agentOf(data, wantId);
      if (exist) {
        if (args.model && args.model !== true) exist.model = String(args.model);
        if (args.harness && args.harness !== true) exist.harness = String(args.harness);
        exist.lastSeen = nowIso();
        pushActivity(data, exist.id, "join", exist.name + " 重新上线");
        await writeData(file, data, raw);
        return { resumed: true, agent: exist };
      }
      if (!/^[a-z0-9][a-z0-9_-]{1,23}$/.test(wantId)) {
        fail("--id 只能用 2-24 位小写字母/数字/-/_，例如 a-1f2c 或 lumi");
      }
    }
    const wantName = args.name && args.name !== true ? String(args.name).trim() : "";
    const name = uniqueName(data, wantName);
    const pal = paletteFor(name);
    const agent = {
      id: wantId || newAgentId(data),
      name,
      emoji: pal.emoji,
      color: pal.color,
      role: args.role && args.role !== true ? String(args.role) : "",
      harness: args.harness && args.harness !== true ? String(args.harness) : "",
      model: args.model && args.model !== true ? String(args.model) : "",
      state: "resting",
      task: "",
      since: null,
      joinedAt: nowIso(),
      lastSeen: nowIso(),
      reports: 0,
      note: "",
    };
    data.agents.push(agent);
    pushActivity(data, agent.id, "join", name + " 加入项目");
    await writeData(file, data, raw);
    return { agent, renamed: wantName && name !== wantName };
  });
  const a = out.agent;
  if (bool(args.json)) {
    process.stdout.write(JSON.stringify({ ok: true, board: file, agent: a }, null, 2) + "\n");
    return;
  }
  if (out.resumed) {
    process.stdout.write("✔ 已恢复身份：" + a.name + "（" + a.id + "）\n  留言板：" + file + "\n");
    return;
  }
  process.stdout.write(
    "✔ 注册成功，你的 agent 身份：\n" +
    "  id   : " + a.id + "\n" +
    "  昵称 : " + a.emoji + " " + a.name + (out.renamed ? "（你想要的昵称已被占用，自动改名）" : "") + "\n" +
    "  环境 : " + (a.harness || "（未标注，可用 meta --harness 补）") + "\n" +
    "  模型 : " + (a.model || "（未标注，可用 meta --model 补）") + "\n" +
    "  状态 : 休息中（开工前必须 claim）\n" +
    "  留言板：" + file + "\n" +
    "  下一步：board.js claim --as " + a.id + " --task \"本次短期目标\"\n"
  );
}

/* ------------------------------------------------------------------ show */

function stateMark(s) {
  return { working: "●", resting: "○", waiting: "◔", offline: "✕" }[s] || "○";
}
function stateText(s) {
  return { working: "工作中", resting: "休息中", waiting: "等待中", offline: "已离开" }[s] || s;
}
function kindMark(k) {
  return { start: "▶", progress: "✦", result: "★", blocked: "▲", handoff: "⇄" }[k] || "✦";
}

function showText(data, file) {
  const L = [];
  const g = data.goal || {};
  const ms = g.milestones || [];
  const done = ms.filter((m) => m.state === "done").length;
  L.push("📋 " + (data.project.name || "项目") + " 留言板");
  L.push("   文件: " + file);
  L.push("   更新: " + (data.project.updated || "-"));
  L.push("");
  L.push("🎯 最终目标: " + (g.title || "（未填写，需要先向用户确认）"));
  if (g.detail) L.push("   " + String(g.detail).split("\n").join("\n   "));
  if (ms.length) {
    L.push("   里程碑 " + done + "/" + ms.length + ": " + ms.map((m, i) => {
      const mk = m.state === "done" ? "✓" : m.state === "doing" ? "◐" : "○";
      return mk + (i + 1) + "." + m.text;
    }).join("  "));
  }
  L.push("");
  const lock = readWorkLock(file);
  const mirror = data.lock || {};
  if (mirror.agentId) {
    const a = agentOf(data, mirror.agentId);
    const stale = lockAgeMs(lock || mirror) > STALE_MS;
    L.push("🔒 工作锁: " + (stale ? "心跳超时，疑似崩溃 " : "占用中 ") +
      (a ? a.name : mirror.agentId) + "（" + mirror.agentId + "）");
    L.push("   任务: " + (mirror.task || "（未填写）"));
    L.push("   开始: " + (mirror.since || "-") + (stale ? "  最后心跳: " + (mirror.heartbeat || "-") : ""));
    if (stale) L.push("   → 确认对方已停止后：claim --as <你的id> --takeover --reason \"…\"");
  } else {
    L.push("🔒 工作锁: 空闲（可以 claim 开工）");
  }
  L.push("");
  L.push("👥 Agents（" + data.agents.length + "）");
  if (!data.agents.length) L.push("   （暂无，运行 join 注册）");
  const order = { working: 0, waiting: 1, resting: 2, offline: 3 };
  data.agents
    .slice()
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9))
    .forEach((a) => {
      L.push("   " + stateMark(a.state) + " " + (a.id + "        ").slice(0, 9) + " " +
        (a.emoji ? a.emoji + " " : "") + a.name + "  [" + stateText(a.state) + "]  汇报 " + (a.reports || 0) + " 条" +
        "  · " + (a.harness || "harness未标注") + " · " + (a.model || "模型未标注") +
        (a.task ? "  任务: " + a.task : ""));
    });
  L.push("");
  L.push("📝 汇报（" + data.reports.length + " 条，最近 6 条）");
  const reps = data.reports.slice(-6).reverse();
  if (!reps.length) L.push("   （暂无）");
  for (const r of reps) {
    const a = agentOf(data, r.agentId) || { name: r.agentId };
    L.push("   " + r.id + " " + kindMark(r.kind) + " " + (r.time || "").slice(5, 16).replace("T", " ") +
      "  " + a.name + "  " + r.title + (r.images && r.images.length ? "  [" + r.images.length + " 图]" : ""));
  }
  L.push("");
  L.push("命令: claim / report / release · 页面: board.js open");
  return L.join("\n");
}

async function cmdShow(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file + "\n  先运行 init --goal \"项目最终目标\"");
  const { data } = readData(file);
  if (bool(args.json)) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  process.stdout.write(showText(data, file) + "\n");
}

/* ----------------------------------------------------------------- claim */

function minsText(ms) {
  const m = ms / 60000;
  return m < 1 ? '不到 1 分钟' : Math.round(m) + ' 分钟';
}

function busyText(data, lock) {
  const holder = agentOf(data, lock.agentId);
  return (
    "工作锁被占用：当前由 " + (holder ? holder.name : lock.agentId) + "（" + lock.agentId + "）工作，" +
    "已 " + minsText(lockAgeMs(lock)) + "\n" +
    "  任务: " + (lock.task || "（未填写）") + "\n" +
    "  → 现在不要修改项目文件，也不要抢锁。\n" +
    "  → 可先做不冲突的准备工作（读代码、查资料、规划），或等待：\n" +
    "    node board.js wait --as <你的id> --timeout 300\n" +
    "  → 若对方已确认停止（心跳超时），可 claim --takeover --reason \"…\" 接管。"
  );
}

function staleText(data, lock) {
  const holder = agentOf(data, lock.agentId);
  return (
    "工作锁疑似残留：" + (holder ? holder.name : lock.agentId) + "（" + lock.agentId + "）最后心跳 " +
    lock.heartbeat + "，已 " + minsText(lockAgeMs(lock)) + "无更新\n" +
    "  → 先用 board.js show 核对，或询问用户对方是否仍在运行；\n" +
    "  → 确认已停止后：node board.js claim --as <你的id> --takeover --reason \"接管原因\""
  );
}

async function cmdClaim(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file + "\n  先运行 board.js init --goal \"项目最终目标\"");
  const id = args.as || args.id;
  const res = await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const me = mustAgent(data, id);
    const task = args.task && args.task !== true ? String(args.task) : "";
    if (!task && !args.quiet) process.stderr.write("⚠ 建议用 --task 写清本次短期目标，其他 agent 与用户靠它判断你在做什么\n");
    const cur = readWorkLock(file);
    if (cur && cur.agentId !== id) {
      const stale = lockAgeMs(cur) > STALE_MS;
      if (!stale) throw new BusyError(busyText(data, cur));
      if (!bool(args.takeover)) throw new BusyError(staleText(data, cur));
      if (!args.reason) throw new BusyError("接管别人的锁必须写 --reason \"为什么确认对方已停止\"");
      const prev = agentOf(data, cur.agentId);
      if (prev) {
        prev.state = "waiting";
        prev.task = "";
        prev.note = "工作锁已被 " + me.name + " 接管";
      }
      pushActivity(data, id, "takeover", "接管 " + cur.agentId + " 的锁：" + args.reason);
    }
    const since = cur && cur.agentId === id ? cur.since || nowIso() : nowIso();
    const lock = {
      agentId: id,
      name: me.name,
      task,
      since,
      heartbeat: nowIso(),
      host: os.hostname(),
      pid: process.pid,
    };
    writeWorkLock(file, lock);
    me.state = "working";
    me.task = task;
    me.since = since;
    me.lastSeen = nowIso();
    syncLockMirror(data, lock);
    pushActivity(data, id, "claim", me.name + " 开工：" + (task || "（未填写任务）"));
    await writeData(file, data, raw);
    return { agent: me, lock };
  });
  if (bool(args.json)) {
    process.stdout.write(JSON.stringify({ ok: true, board: file, agent: res.agent, lock: res.lock }, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    "✔ 已获得工作锁，可以开工\n" +
    "  agent: " + res.agent.name + "（" + res.agent.id + "）\n" +
    "  任务 : " + (res.lock.task || "（未填写）") + "\n" +
    "  开始 : " + res.lock.since + "\n" +
    "  收尾 : node board.js report --as " + res.agent.id + " --kind result --title \"…\" … && node board.js release --as " + res.agent.id + "\n"
  );
}

/* ------------------------------------------------------------------ wait */

async function cmdWait(file, args) {
  const id = args.as || args.id;
  const timeout = Math.max(5, Number(args.timeout || 300)) * 1000;
  const interval = Math.max(3, Number(args.interval || 10)) * 1000;
  const start = Date.now();
  for (;;) {
    try {
      await cmdClaim(file, { as: id, task: args.task, json: args.json, quiet: true });
      return;
    } catch (e) {
      if (e.code !== "BUSY") throw e;
      const left = Math.round((timeout - (Date.now() - start)) / 1000);
      if (left <= 0) {
        throw new BusyError(
          String(e.message).split("\n").slice(0, 3).join("\n") +
          "\n  → 等待超时（" + Math.round(timeout / 1000) + " 秒）。本轮不要开工，向用户说明正在等待即可。"
        );
      }
      process.stderr.write("… 锁仍被占用，剩余 " + left + " 秒，" + Math.round(interval / 1000) + " 秒后重试\n");
      await sleep(interval);
    }
  }
}

/* ------------------------------------------------------------- heartbeat */

async function cmdHeartbeat(file, args) {
  const id = args.as || args.id;
  const ok = await withWriteLock(file, async () => {
    const cur = readWorkLock(file);
    const { data, raw } = readData(file);
    const me = mustAgent(data, id);
    if (!cur || cur.agentId !== id) return false;
    cur.heartbeat = nowIso();
    writeWorkLock(file, cur);
    me.lastSeen = nowIso();
    me.state = "working";
    syncLockMirror(data, cur);
    await writeData(file, data, raw);
    return true;
  });
  if (!ok) {
    process.stderr.write("⚠ 你当前不持有工作锁，未续约（用 show 查看持有者）\n");
    return;
  }
  process.stdout.write("✔ 已续约：" + nowIso() + "\n");
}

/* --------------------------------------------------------------- release */

function appendReport(data, opt) {
  const rep = {
    id: nextReportId(data),
    agentId: opt.agentId,
    kind: opt.kind || "progress",
    time: nowIso(),
    title: opt.title || "（未命名汇报）",
    shortGoal: opt.shortGoal || "",
    attempts: list(opt.attempts),
    results: list(opt.results),
    images: opt.images || [],
    codes: list(opt.codes),
    next: opt.next || "",
    tags: list(opt.tags),
  };
  data.reports.push(rep);
  const a = agentOf(data, opt.agentId);
  if (a) {
    a.reports = reportCount(data, opt.agentId);
    a.lastSeen = nowIso();
  }
  return rep;
}

async function cmdRelease(file, args) {
  const id = args.as || args.id;
  const res = await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const me = mustAgent(data, id);
    const cur = readWorkLock(file);
    const owned = !!cur && cur.agentId === id;
    if (cur && !owned && !bool(args.force)) {
      throw new BusyError(
        "锁当前由 " + cur.agentId + " 持有，你不是持有者，拒绝释放。\n" +
        "  → 正常情况下用 --as 你自己的 id；确需清理残留锁用 release --as " + cur.agentId + " --force"
      );
    }
    if (owned) {
      try { fs.unlinkSync(lockFileOf(file)); } catch {}
    }
    const summary = args.summary && args.summary !== true ? String(args.summary) : "";
    if (summary) {
      appendReport(data, {
        agentId: id,
        kind: "result",
        title: summary,
        shortGoal: args.task && args.task !== true ? String(args.task) : me.task,
        results: list(args.result),
        next: args.next && args.next !== true ? String(args.next) : "",
        images: collectImages(process.argv.slice(2), file),
      });
    }
    me.state = args.state && args.state !== true ? String(args.state) : "resting";
    if (!["resting", "waiting", "offline"].includes(me.state)) me.state = "resting";
    me.task = "";
    me.lastSeen = nowIso();
    syncLockMirror(data, null);
    pushActivity(data, id, "release", me.name + " 收工" + (summary ? "：" + summary : ""));
    await writeData(file, data, raw);
    return { agent: me, summary };
  });
  process.stdout.write(
    "✔ 已释放工作锁，状态：" + stateText(res.agent.state) + "\n" +
    (res.summary ? "  已附带结果汇报：" + res.summary + "\n" : "  提醒：若还没写本条汇报，用 report --kind result 补上\n") +
    "  留言板：" + file + "\n"
  );
}

/* ---------------------------------------------------------------- report */

async function cmdReport(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file);
  const id = args.as || args.id;
  const kind = args.kind && args.kind !== true ? String(args.kind) : "progress";
  if (!KINDS.includes(kind)) fail("--kind 只能是：" + KINDS.join(" | "));
  const images = collectImages(process.argv.slice(2), file);
  const res = await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    mustAgent(data, id);
    const cur = readWorkLock(file);
    if (!cur || cur.agentId !== id) {
      process.stderr.write("⚠ 你当前未持有工作锁；汇报仍会写入，但请确认没有和其他 agent 并发操作\n");
    }
    const rep = appendReport(data, {
      agentId: id,
      kind,
      title: args.title && args.title !== true ? String(args.title) : "",
      shortGoal: args.goal && args.goal !== true ? String(args.goal) : "",
      attempts: args.attempt,
      results: args.result,
      images,
      codes: args.code,
      next: args.next && args.next !== true ? String(args.next) : "",
      tags: args.tag,
    });
    pushActivity(data, id, "report", rep.id + " " + rep.title);
    await writeData(file, data, raw);
    return rep;
  });
  process.stdout.write(
    "✔ 汇报已写入 " + res.id + "（" + kindMark(kind) + " " + kind + "）\n" +
    "  标题 : " + res.title + "\n" +
    "  图片 : " + (res.images.length ? res.images.length + " 张" : "无") + "\n" +
    "  入口 : " + ((res.codes || []).length ? res.codes.length + " 条代码位置" : "无") + "\n" +
    "  留言板：" + file + "\n"
  );
}

/* ------------------------------------------------------------------ wall */

function nextWallId(data) {
  let max = 0;
  for (const w of data.wall || []) {
    const m = /^w-(\d+)$/.exec(w.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "w-" + String(max + 1).padStart(4, "0");
}

async function cmdWall(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file);
  const adds = list(args.add);
  const removes = list(args.remove);
  const listOnly = bool(args.list) || (!adds.length && !removes.length);
  const msgs = [];
  await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    data.wall = data.wall || [];
    if (listOnly) return;
    for (const spec of removes) {
      const i = data.wall.findIndex((w) => w.id === spec || w.title === spec);
      if (i < 0) fail("展示墙上没有：" + spec + "（用 wall --list 查看）");
      msgs.push("已换下：" + data.wall[i].title + "（" + data.wall[i].id + "）");
      data.wall.splice(i, 1);
    }
    for (const spec of adds) {
      const parts = String(spec).split("::");
      const title = (parts[0] || "").trim();
      if (!title) fail('--add 需要「标题::说明::图片」格式，标题不能为空');
      const item = {
        id: nextWallId(data),
        title,
        body: (parts[1] || "").trim(),
        image: (parts[2] || "").trim() ? normalizeImage((parts[2] || "").trim(), file) : "",
        addedBy: args.as || args.id || "",
        addedAt: nowIso(),
      };
      data.wall.push(item);
      msgs.push("已贴入：" + item.title + "（" + item.id + "）");
    }
    pushActivity(data, args.as || "", "wall", msgs.join(" / "));
    await writeData(file, data, raw);
  });
  if (listOnly) {
    const { data } = readData(file);
    const ws = data.wall || [];
    process.stdout.write("展示墙（" + ws.length + " 项；只按用户明确指令增删）\n");
    for (const w of ws) {
      process.stdout.write("  " + w.id + "  " + w.title + (w.body ? "  — " + w.body : "") +
        (w.image ? "  [" + w.image + "]" : "") + "\n");
    }
    return;
  }
  process.stdout.write(msgs.join("\n") + "\n  留言板：" + file + "\n");
}

/* ------------------------------------------------------------------ goal */

async function cmdGoal(file, args) {
  if (!fs.existsSync(file)) fail("还没有留言板：" + file);
  await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const actor = args.as || "";
    if (!applyGoal(data, args, actor)) {
      fail("没有可更新的内容。用法：goal --set \"最终目标\" [--detail \"…\"] [--milestone \"…\"] [--milestone-done 1]");
    }
    pushActivity(data, actor, "goal", "更新目标/里程碑");
    await writeData(file, data, raw);
  });
  const { data } = readData(file);
  process.stdout.write(
    "✔ 目标已更新\n" +
    "  目标：" + (data.goal.title || "（空）") + "\n" +
    (data.goal.detail ? "  说明：" + data.goal.detail + "\n" : "") +
    (data.goal.milestones.length
      ? "  里程碑：" + data.goal.milestones.map((m, i) => (m.state === "done" ? "✓" : m.state === "doing" ? "◐" : "○") + (i + 1) + "." + m.text).join("  ") + "\n"
      : "") +
    "  留言板：" + file + "\n"
  );
}

/* ----------------------------------------------------------------- state */

async function cmdState(file, args) {
  const id = args.as || args.id;
  const st = args.state && args.state !== true ? String(args.state) : "";
  if (!["working", "resting", "waiting", "offline"].includes(st)) fail("--state 只能是 working|resting|waiting|offline");
  await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const me = mustAgent(data, id);
    me.state = st;
    me.lastSeen = nowIso();
    if (args.note) me.note = String(args.note);
    if (st !== "working") {
      const cur = readWorkLock(file);
      if (cur && cur.agentId === id) {
        try { fs.unlinkSync(lockFileOf(file)); } catch {}
        syncLockMirror(data, null);
      }
    }
    pushActivity(data, id, "state", me.name + " → " + stateText(st) + (args.note ? "：" + args.note : ""));
    await writeData(file, data, raw);
  });
  process.stdout.write("✔ 状态已更新为 " + stateText(st) + "\n");
}

/* ------------------------------------------------------- meta (harness/model) */

async function setAgentMeta(file, id, patch) {
  let me = null;
  await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    me = mustAgent(data, id);
    const bits = [];
    if (patch.harness) { me.harness = patch.harness; bits.push("harness=" + patch.harness); }
    if (patch.model) { me.model = patch.model; bits.push("model=" + patch.model); }
    me.lastSeen = nowIso();
    pushActivity(data, id, "meta", (me.name || id) + " " + bits.join(" "));
    await writeData(file, data, raw);
  });
  return me;
}

async function cmdMeta(file, args) {
  const id = args.as || args.id;
  const harness = args.harness && args.harness !== true ? String(args.harness).trim() : "";
  const model = args.model && args.model !== true ? String(args.model).trim() : "";
  if (!harness && !model) {
    fail('用法：board.js meta --as <id> --harness "dsh" --model "deepseek-flash"（两个至少给一个）');
  }
  const me = await setAgentMeta(file, id, { harness, model });
  process.stdout.write(
    "✔ 已记录：" + (me.name || id) + "\n" +
    "  harness : " + (me.harness || "（未标注）") + "\n" +
    "  模型    : " + (me.model || "（未标注）") + "\n"
  );
}

async function cmdModel(file, args) {
  const id = args.as || args.id;
  const model = args.set && args.set !== true ? String(args.set).trim() : "";
  if (!model) fail('用法：board.js model --as <id> --set "模型名"（= meta --model）');
  await setAgentMeta(file, id, { model });
  process.stdout.write("✔ 模型已记录：" + model + "\n");
}

/* ----------------------------------------------------------------- leave */

async function cmdLeave(file, args) {
  const id = args.as || args.id;
  await withWriteLock(file, async () => {
    const { data, raw } = readData(file);
    const me = mustAgent(data, id);
    const cur = readWorkLock(file);
    if (cur && cur.agentId === id) {
      try { fs.unlinkSync(lockFileOf(file)); } catch {}
      syncLockMirror(data, null);
    }
    me.state = "offline";
    me.task = "";
    me.lastSeen = nowIso();
    me.note = "已离开";
    pushActivity(data, id, "leave", me.name + " 离开项目");
    await writeData(file, data, raw);
  });
  process.stdout.write("✔ " + id + " 已标记离开（记录保留在留言板）\n");
}

/* -------------------------------------------------------------- validate */

async function cmdValidate(file) {
  if (!fs.existsSync(file)) fail("留言板不存在：" + file);
  const errs = [];
  const warns = [];
  let data;
  try {
    data = readData(file).data;
  } catch (e) {
    fail(e.message);
  }
  if (data.schema !== SCHEMA) warns.push("schema=" + data.schema + "（当前 " + SCHEMA + "）");
  if (!data.goal.title) warns.push("目标为空：goal --set \"…\" 才能让所有 agent 朝同一目标努力");
  const ids = new Set();
  for (const a of data.agents) {
    if (!a.id) { errs.push("agent 缺 id：" + JSON.stringify(a).slice(0, 60)); continue; }
    if (ids.has(a.id)) errs.push("agent id 重复：" + a.id);
    ids.add(a.id);
    if (!a.name) warns.push("agent 缺昵称：" + a.id);
    if (!["working", "resting", "waiting", "offline"].includes(a.state)) warns.push("状态非法：" + a.id + "=" + a.state);
    if (a.state === "working" && !data.lock.agentId) warns.push(a.id + " 标为工作中但锁字段为空");
  }
  const rids = new Set();
  for (const r of data.reports) {
    if (!r.id) errs.push("汇报缺 id：" + r.title);
    if (rids.has(r.id)) errs.push("汇报 id 重复：" + r.id);
    rids.add(r.id);
    if (!ids.has(r.agentId)) errs.push("汇报 " + r.id + " 指向不存在的 agent：" + r.agentId);
    if (!KINDS.includes(r.kind)) warns.push("汇报类型未知：" + r.id + "=" + r.kind);
    for (const im of r.images || []) {
      const src = typeof im === "string" ? im : im.src;
      if (!src || /^(data:|https?:|file:)/i.test(src)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), src))) warns.push("图片缺失：" + src + "（" + r.id + "）");
    }
  }
  const wids = new Set();
  for (const w of data.wall || []) {
    if (!w.id) errs.push("展示墙条目缺 id：" + w.title);
    if (wids.has(w.id)) errs.push("展示墙 id 重复：" + w.id);
    wids.add(w.id);
    if (w.image && !/^(data:|https?:|file:)/i.test(w.image) &&
        !fs.existsSync(path.resolve(path.dirname(file), w.image))) warns.push("展示墙图片缺失：" + w.image);
  }
  const lock = readWorkLock(file);
  if (lock) {
    if (!ids.has(lock.agentId)) errs.push("工作锁持有者不存在：" + lock.agentId);
    if (lockAgeMs(lock) > STALE_MS) warns.push("工作锁心跳超时（最后 " + lock.heartbeat + "），可能残留，需要 --takeover 接管");
    if (data.lock && data.lock.agentId !== lock.agentId) warns.push("页面 lock 与锁文件不一致，运行任一写命令即可修正");
  } else if (data.lock && data.lock.agentId) {
    errs.push("页面显示 " + data.lock.agentId + " 工作中，但锁文件不存在（不一致）");
  }
  process.stdout.write(
    "留言板：" + file + "\n" +
    "  agents " + data.agents.length + " · reports " + data.reports.length +
    " · wall " + (data.wall || []).length + " · schema " + data.schema + "\n" +
    (errs.length ? "❌ 错误 " + errs.length + "：\n" + errs.map((x) => "  - " + x).join("\n") + "\n" : "✔ 无错误\n") +
    (warns.length ? "⚠ 警告 " + warns.length + "：\n" + warns.map((x) => "  - " + x).join("\n") + "\n" : "✔ 无警告\n")
  );
  if (errs.length) process.exit(1);
}

/* ------------------------------------------------------------------ open */

async function cmdOpen(file) {
  if (!fs.existsSync(file)) fail("留言板不存在：" + file + "（先 init）");
  const { spawn } = require("child_process");
  const opts = { detached: true, stdio: "ignore" };
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", file], opts).unref();
    else if (process.platform === "darwin") spawn("open", [file], opts).unref();
    else spawn("xdg-open", [file], opts).unref();
  } catch (e) {
    fail("打开浏览器失败：" + e.message);
  }
  process.stdout.write("✔ 已请求浏览器打开：" + file + "\n");
}

/* ------------------------------------------------------------------ main */

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }

  const file = findBoard(args.board && args.board !== true ? String(args.board) : "");

  switch (cmd) {
    case "init": return cmdInit(file, args);
    case "join": return cmdJoin(file, args);
    case "show":
    case "list":
    case "status": return cmdShow(file, args);
    case "claim": return cmdClaim(file, args);
    case "wait": return cmdWait(file, args);
    case "heartbeat": return cmdHeartbeat(file, args);
    case "release": return cmdRelease(file, args);
    case "report": return cmdReport(file, args);
    case "wall": return cmdWall(file, args);
    case "goal": return cmdGoal(file, args);
    case "state": return cmdState(file, args);
    case "meta": return cmdMeta(file, args);
    case "model": return cmdModel(file, args);
    case "leave": return cmdLeave(file, args);
    case "validate": return cmdValidate(file);
    case "open": return cmdOpen(file);
    case "path":
      process.stdout.write(file + "\n");
      return;
    default:
      fail("未知命令：" + cmd + "（用 help 查看）");
  }
}

main().catch((e) => {
  if (e.code === "BUSY") {
    process.stderr.write("🔒 " + e.message + "\n");
    process.exit(2);
  }
  process.stderr.write("✖ " + (e && e.message ? e.message : String(e)) + "\n");
  process.exit(1);
});
