# Pi 配置仓库

多台机器之间同步 Pi coding agent 配置的私有仓库。

- **仓库地址**：`https://github.com/littlecabbage/pi-sync-config.git`
- **同步工具**：[`@xyzensun/pi-sync`](https://www.npmjs.com/package/@xyzensun/pi-sync) v0.3.3
- **本机**：`cengzihuidemacbook-air-local`

---

## 快速开始（新机器）

```bash
# 1. 装同步扩展
pi install npm:@xyzensun/pi-sync

# 2. 在 Pi 会话里初始化
/pisync
```

`/pisync` 会弹出输入框，填入仓库地址：

```
https://github.com/littlecabbage/pi-sync-config.git
```

然后选择首次拉取方式：

| 选项 | 含义 |
| --- | --- |
| 智能化拉取 | 冲突以远端为准，本机独有文件保留 |
| 以远端覆盖本机 | 本机与远端不一致处全部以远端为准（**本机独有文件会被删除**） |
| 暂不拉取 | 什么都不动，之后随时再选 |

> ⚠️ 初始化只完成仓库连接，**不会改动本机配置**。真正落盘发生在你选完拉取方式之后。
>
> 非交互式会话（`-p`、rpc、json）弹不出选择框，会停在「仅连接」状态，需要到带 UI 的会话里再跑一次。

---

## 日常同步

| 命令 | 用途 |
| --- | --- |
| `/pisync` | 打开面板（看清状态再操作） |
| `/pisync push` | 推送本机改动到仓库 —— **这就是备份** |
| `/pisync pull` | 从仓库拉取到本机 |
| `/pisync status` | 看 git 状态与三方比较结果 |
| `/pisync diff` | 预览待同步的差异 |

**备份 = push。** 在改动过配置的机器上跑一次 `/pisync push`，仓库里就多一个快照。
没有自动定时推送，需要手动触发（面板里可开 `autoSync`）。

---

## 同步了什么

仓库根目录的 `pi-sync.json` 决定同步范围，`sync/` 下是实际内容。

| 路径 | 内容 | 当前数量 |
| --- | --- | --- |
| `sync/settings.json` | Pi 主配置（**白名单投影**，见下） | — |
| `sync/AGENTS.md` | 全局工作纪律 / 指令文件 | 1 |
| `sync/extensions/` | 扩展 | 11 项 |
| `sync/skills/` | 技能 | 1 |
| `sync/themes/` | 主题 | 8 |
| `sync/prompts/` | 提示词模板 | 0（空） |

`sync/settings.json` 不是整文件同步，而是**白名单投影** —— 只有这些顶层键会进仓库：

```
defaultProvider  defaultModel  defaultThinkingLevel  thinkingBudgets  theme
retry  compaction  branchSummary  warnings  transport  steeringMode
followUpMode  httpIdleTimeoutMs  websocketConnectTimeoutMs  enabledModels
defaultTools  doubleEscapeAction  treeFilterMode  editorPaddingX  outputPad
autocompleteMaxVisible  showHardwareCursor  markdown  terminal  images
tuiMode  fullscreenExitOutput  fullscreenScrollbar  packages
```

白名单外的键（含 Pi 未来新增的字段）**既不会进仓库，也不会被覆盖**。

---

## 没同步什么

| 内容 | 原因 |
| --- | --- |
| `auth.json` | 不在 `include` 里 —— 含各家 provider 的 OAuth token 和 API key |
| `sessions/**` | 不在 `include` 里 —— 会话记录，体积大且是本机私密内容 |
| `traces/**`、`missions/**`、`npm/**` | 不在 `include` 里 |
| `models.json`、`trust.json`、`models-store.json` | 不在 `include` 里 |
| `settings.json` 里的 `lastChangelogVersion` | 白名单外，本机专属 |
| `settings.json` 里的 `skills` | 白名单外，且值是本机绝对路径 |
| `.git`、`node_modules`、`*.log`、`*.tmp`、`cache/`、`logs/` | 在 `exclude` 里 |

> **pi-sync 没有内置黑名单，也不做密钥扫描。** 一个文件是否同步，完全由 `pi-sync.json` 的
> `include` / `exclude` 决定。往 `include` 里加内容前，先确认它该进 git 历史。

---

## 目录结构

```
pi-sync-config/
├── pi-sync.json          # 同步清单（include / exclude / 分支 / schema 版本）
├── README.md             # 本文件
├── .gitignore            # 忽略 .pi-sync/（本机同步状态）
└── sync/                 # 同步根目录
    ├── settings.json
    ├── AGENTS.md
    ├── extensions/       # ask-user, pi-permission-system, pi-ego, ...
    ├── skills/           # i-have-adhd
    ├── prompts/          # 空
    └── themes/           # 8 个主题
```

**分支：**

| 分支 | 用途 |
| --- | --- |
| `main` | 共享配置主线 |
| `pisync-device/<host>-<uuid>` | 每台机器的设备分支，记录该机状态 |

---

## 调整同步范围

编辑 `pi-sync.json`：

```jsonc
{
  "include": ["settings.json", "AGENTS.md", "extensions/**", "skills/**", "themes/**"],
  "exclude": [
    "**/.DS_Store", "**/*.tmp", "**/*.log",
    "extensions/pi-sync/**",        // 插件自己不同步自己
    "extensions/**/.git/**",        // 避免嵌套仓库被折叠成 gitlink
    "extensions/**/cache/**",
    "extensions/**/logs/**"
  ],
  "delete": "tracked"               // 仓库中已跟踪但不在 include 的文件会被删除
}
```

改完在 Pi 里跑 `/pisync push` 生效。

---

## 已知问题

### `sync/extensions/pi-ego` 是悬空的 gitlink

`pi-ego` 本身是一个独立的 git 仓库（clone 自 `hjanuschka/pi-ego`）。git 检测到目录里嵌了
`.git`，就把它折叠成了一个 **submodule 指针**而不是文件：

```
160000 fa830f38bbdabcc091c8685c5b6c537c98968b6f  sync/extensions/pi-ego
```

**后果：** 新机器 clone 后 `pi-ego/` 是**空目录**，且仓库里没有 `.gitmodules`，git 也不知道去哪拉。

**修复方向：** 在 `exclude` 里加 `extensions/**/.git/**`，让 pi-sync 不再复制 `.git` 目录，
git 就会把 42 个真实文件正常收录。这样本机仍保留独立 clone 和 `git pull` 上游更新的能力。

---

## 参考

- pi-sync 用法与设计：`npm:@xyzensun/pi-sync` 的 README
- 本仓库的同步清单以 `pi-sync.json` 为准，本文件仅为说明
