# dsh-whale-persona

DSH（DeepSeek Harness）的**人格与记忆插件（通用技术版）**。

它把「角色设定 + 长期人格沉淀 + 跨会话记忆」拼成一段 system prompt 注入当前会话，
并提供 4 个工具让模型自己读写这本账。插件本身**不带任何具体人设或记忆内容**——
你要给的角色卡、要记的事，都由你自己填。

---

## 目录结构

```
dsh-whale-persona/
├── package.json        # 插件清单（dsh.bundle / dsh.client 在这里声明）
├── cordis.patch.yml    # bundle patch：把自己插进 web profile
├── README.md
└── lib/
    ├── index.mjs       # host 侧：提示词段 + 4 个工具 + settings
    └── client.js       # 浏览器侧：对话输入栏的开关按钮
```

运行时**数据目录**（默认 `~/.dsh/persona-data/`，第一次写入时自动创建）：

```
~/.dsh/persona-data/
├── shared-memory.json   # 记忆账本：{ version, items: [...], tiers?: {...} }
└── persona/
    ├── current.md       # 长期人格沉淀（可选，手写或脚本生成）
    └── ledger.json      # 人格账本：whale_grow 自动维护
```

---

## 安装

1. 把整个 `dsh-whale-persona/` 目录放进 web profile 的 `node_modules/`：

   ```
   <DSH_HOME>/profiles/web-desktop/node_modules/dsh-whale-persona/
   ```

2. 确认依赖 `schemastery` 在该 profile 下可以解析（DSH 自带插件通常已装；
   没有就 `npm i schemastery` 到这个 profile）。

3. 让 bundle patch 生效。两种方式任选：

   - **插件市场 / 插件管理页**安装本地包；
   - 或手动在 profile 的 `cordis.patch.yml`（或 settings 的插件列表）里加：

     ```yaml
     - insert:
         - id: whale-persona
           name: 'dsh-whale-persona'
     ```

4. 重启 DSH（或重新加载 web profile）。输入栏右侧应出现 `● 人设+记忆` 开关。

---

## 设置项（命名空间 `whale-persona`）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关，等同输入栏那个按钮 |
| `coreText` | string | `''` | **最高优先级**的一段人格内核，原样放在提示词最前。留空则不注入 |
| `soulPath` | string | `''` | 角色设定 Markdown 的绝对路径。留空则不注入 |
| `sharedRoot` | string | `~/.dsh/persona-data` | 数据目录（记忆账本 + 人格沉淀都在这里） |
| `personaEvolvePath` | string | `''` | 可选：外部人格账本模块路径（见下）。留空用内置实现 |
| `memoryItems` | number | `40` | 记忆注入条数上限（0=不注入最近条目，上限 40） |

注入顺序固定为：`coreText` → `soulPath` → `persona/current.md` → 共享记忆段。
**四段全空时不会注册提示词段**（不占 token）。

写进 `settings.yaml` 的样子：

```yaml
whale-persona:
  enabled: true
  coreText: ''
  soulPath: 'D:\my\soul.md'
  sharedRoot: 'D:\my\persona-data'
  personaEvolvePath: ''
  memoryItems: 40
```

---

## 四个工具

### `whale_remember`
写一条记忆进 `shared-memory.json`。

| 参数 | 说明 |
| --- | --- |
| `text` | 必填，一句话，≤300 字（超长自动截断） |
| `kind` | `topic` / `fact`（默认）/ `impression` |
| `target` | `impression` 时填：这是关于谁的 |

同 `kind + text + target` 重复写入不会刷屏，而是累加 `hits` 并刷新 `at`。
单条字段：`{ kind, text, target?, from, at, hits, pinned? }`。
`pinned: true` 的条目永远排在最前，且不占 `memoryItems` 额度。

### `whale_recall`
按 `query`（正文/对象模糊匹配）、`kind` 过滤，按时间倒序返回，`limit` 默认 20、上限 100。

### `whale_grow`
写一条长期人格观察进 `persona/ledger.json`。

| 参数 | 说明 |
| --- | --- |
| `kind` | `habit`（习惯/口头禅）/ `value`（在意的东西）/ `impression`（对某人的印象） |
| `text` | 第一人称短句，≤120 字 |

同一条累计 **3 次**后 `promoted: true`，表示「可以沉淀进 `persona/current.md`」——
**插件只记账、不做决定**，什么时候升级成稳定人格由你决定。
（想换逻辑就填 `personaEvolvePath` 指向自己的模块，需导出 `personaLog({kind,text,src})`，
可选 `status()`；导出不合规会自动回落到内置实现。）

### `whale_status`
返回：当前 `enabled`、`sharedRoot`、`soulPath` 与 `soulBytes`、`memoryCount`、
`memoryLatestAt`、`personaVersion`（读 `current.md` 里的 `ver=N` 标记）、`personaChars`、
`ledgerCount`、`ledgerPromoted`。

---

## 记忆账本格式

`shared-memory.json` 最小形态：

```json
{
  "version": 1,
  "items": [
    { "kind": "fact", "text": "用户偏好用中文回答", "from": "dsh", "at": 1730000000000, "hits": 2 },
    { "kind": "impression", "target": "小王", "text": "喜欢先看结论", "from": "dsh", "at": 1730000000000, "hits": 1, "pinned": true }
  ]
}
```

可选的 `tiers` 块用于放分过层的长期记忆（插件只读不写，写它的是你自己的脚本）：

```json
{
  "version": 1,
  "items": [],
  "tiers": {
    "important": [{ "who": "某人", "what": "重要的事" }],
    "long": [{ "topic": "话题", "summary": "近期发生了什么" }],
    "outline": [{ "oneLine": "只记得大概的一句话" }]
  }
}
```

渲染时会依次输出 `■ 重要` / `■ 近期` / `■ 永久大纲` 三段，再接 `■ 最近攒的`。

---

## 工程要点（改代码前值得知道）

- **mtime 缓存**：所有文件按 `mtimeMs + size` 缓存，没变化不重读。改了文件要等 30 秒轮询
  或重启；改了设置项立即生效。
- **降级不挂**：任何一段文件读不到都当空处理，插件不会因此报错或禁用。
- **写入安全**：`whale_remember` 走「严格读 → 合并 → 临时文件 + rename 原子替换」。
  文件损坏 / 正被别的进程原子替换时 **直接拒绝写入**，绝不用空数组覆盖整本账。
  如果你有别的进程（脚本、另一个客户端）也写同一个 `shared-memory.json`，这条是必须的。
- **只改 `items`**：写入时保留账本里其它字段（如 `tiers`），不会抹掉外部维护的分层数据。
- **工具注册失败不影响提示词段**：`tools` 缺失时插件照样只做提示词注入。

---

## 常见问题

**开关点了没反应？**
先看 `whale_status` 返回的 `enabled` 与 `sharedRoot`。确认 `cordis.patch.yml` 已生效、
profile 里能解析到本包；client half 需要 web 端 `__ModuleLoader__`（DSH Web GUI 自带）。

**提示词里什么都没有？**
四段都空时不注入。至少填一个：`coreText`、`soulPath`，或者在
`<sharedRoot>/persona/current.md` 里放点内容。

**改了 soul.md 不生效？**
30 秒轮询；也可以重启 DSH。检查路径是绝对路径、编码 UTF-8。

**会不会把记忆注入太长？**
记忆段默认上限 1400 字符（超出截断加 `…`），`memoryItems` 控制条目数，
`pinned` 条目不计入该额度。整体上下文预算自己盯着点。

---

## License

MIT
