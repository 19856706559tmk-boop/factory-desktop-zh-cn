# factory-desktop-zh-cn — Factory Desktop（Windows & macOS）原生级全量中文汉化包

[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-blue)](#)
[![Factory Desktop](https://img.shields.io/badge/Factory_Desktop-v0.199.1%2B-success)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

为 Windows 与 macOS 版 **Factory Desktop** 打造的**原生级、零外联**的简体中文（`zh-CN`）汉化补丁系统。采用四层混合汉化架构与五维安全标准，一步到位汉化全部界面与左侧会话标题。

**Windows 为原生一等公民支持**：自动探测 Squirrel 安装目录、同步 `factory-desktop.exe` 内嵌 ASAR 完整性哈希、内置终端运行保护、事务性回滚，双击 `.bat` 即可完成汉化与还原。

---

## ✨ 核心特性

### 1. 四层原生混合汉化架构

- **Layer 1 — React `i18next` 原生资源树注入**：直接向渲染进程 `i18next` 注入 `14,900+` 条精准词条、69 条语义消歧路径覆盖（`pathOverrides`）与 58 条动态前缀规则，保留全部 `{{变量}}` 插值与 `<Trans>` 组件结构。
- **Layer 2 — Electron 主进程与系统菜单汉化**：完整汉化 macOS 顶部应用菜单栏（`文件`、`编辑`、`视图`、`窗口`、`帮助`）、系统托盘菜单与右键上下文菜单。
- **Layer 3 — 零闪烁 DOM 兜底引擎**：基于 `WeakMap` + `requestAnimationFrame` 微任务批处理的轻量级 `MutationObserver`，自动跳过 `<pre>`、`<code>`、`.monaco-editor`、`.xterm` 等代码与终端区域，并带有全链路 `try...catch` 异常隔离保护罩，杜绝误伤代码标识符与 Git 分支名。同步翻译 `data-text` 属性，覆盖 CSS `content: attr()` 流光伪元素与宽度测量器（修复 AI 流式输出时状态条中英文叠加问题）。
- **Layer 4 — 左侧会话标题原生中文生成**：通过等长字节补丁（In-place Binary Patch + 优雅降级兜底）将 `bin/droid` 内置的会话标题生成提示词切换为简体中文，**完全不影响主对话模型的推理与回答质量**。

### 2. Windows 原生支持

- **安装目录自动探测**：自动定位 `%LOCALAPPDATA%\Factory\app-x.y.z`（Squirrel 布局），也支持 `FACTORY_APP_PATH` 环境变量与 `C:\Program Files\Factory` 自定义路径。
- **exe 完整性哈希同步**：自动改写 `factory-desktop.exe` 内嵌的 ASAR SHA-256 完整性资源（Electron asar integrity），补丁后应用可正常启动；哈希更新失败时自动回滚 `app.asar`，任何失败路径都不会让应用无法开机。
- **内置终端保护**：检测到脚本运行于 Factory 内置终端时自动中止，避免杀掉正在使用的会话。
- **原子替换**：临时文件写入后 `rename` 原子生效，断电/失败不会产生半成品文件。

### 3. 五维安全与跨版本标准

- **原生接管软件内「更新」按钮（macOS）**：内置 macOS 原生更新桥接器，点击软件右上角「有可用更新」时自动校验官方 Apple `Developer ID Application` 证书签名，并在后台自动完成新版本的中文预注入与重签名，**重启后直接进入全中文最新版**。
- **ASAR 完整性哈希同步**：重打包 `app.asar` 后同步更新哈希——macOS 写入 `Contents/Info.plist` 的 `ElectronAsarIntegrity`；Windows 改写 exe 内嵌完整性资源。
- **APFS 写时复制原子替换（macOS）**：在 `/private/tmp` 独立安全目录中完成克隆、打补丁与由内向外动态重签名（兼容 Apple Silicon 与 Intel 架构，保留完整 `entitlements.plist` 权限），校验通过后原子替换 `Factory.app`。
- **独立持久化目录（`~/.factory-zh`）**：运行时与原版备份持久化，删掉下载文件夹后自动更新自愈（macOS）与还原功能依然永久有效。
- **智能防自杀（双平台）**：自动识别是否在 Factory 内置终端中运行并保护当前会话（Windows 自动中止操作；macOS 跳过自动重启），兼容 `sudo` 执行并自动归还当前用户文件所有权。

---

## 🚀 快速开始

### Windows

1. 安装 [Python 3](https://www.python.org/downloads/windows/)（安装时勾选 *Add python.exe to PATH*）
2. 下载本仓库（`Code → Download ZIP` 解压，或 `git clone`）
3. 双击 **`一键汉化.bat`**；或在 PowerShell 中执行：

```powershell
cd factory-desktop-zh-cn
python patcher.py
```

> 💡 脚本检测到 Factory Desktop 正在运行时会自动关闭并在汉化后重启；**请勿在 Factory 内置终端中运行**（会检测到并自动中止，以保护当前会话）。

### macOS

打开「终端（Terminal）」，依次运行：

```bash
git clone https://github.com/19856706559tmk-boop/factory-desktop-zh-cn.git
cd factory-desktop-zh-cn
python3 patcher.py
```

> 💡 若提示权限不足，运行 `sudo python3 patcher.py`（脚本会自动识别真实用户并归还文件权限）。

---

## 🛠️ 常用命令与卸载还原

| 命令 | 说明 |
| :--- | :--- |
| `python patcher.py` | 一键应用汉化补丁并持久化至 `~/.factory-zh` |
| `python patcher.py --force` | 从干净备份强制重建并重新应用（修改词库或升级引擎后使用） |
| `python patcher.py --check` | 检查当前 Factory 是否已汉化（只读操作，任何终端均可运行） |
| `python patcher.py --no-guard` | 仅应用汉化补丁，不安装后台自愈守护（仅 macOS 生效） |
| `python patcher.py --skip-kill` | 不自动关闭/重启 Factory |
| `python restore.py` | **一键无损还原英文原版**：还原 `app.asar` / `bin/droid` / 完整性哈希、清理 `~/.factory-zh` |
| `python localize_sessions.py` | 汉化本地历史会话标题（`.jsonl` + SQLite 索引 + 发现索引，保留修改时间） |
| `python localize_sessions.py --restore` | 还原被汉化的历史会话标题 |
| `一键汉化.bat` / `一键还原.bat` | Windows 双击入口（自动回退 `py` 启动器） |

---

## ⚠️ Windows 用户必读

1. **应用更新后需要重新汉化**：Windows 版没有后台自愈守护（macOS 通过 LaunchAgent 自动重打补丁）。Factory 每次自动更新后界面会回到英文，重新运行一次 `python patcher.py` 即可，脚本会自动为新版本重建干净备份。
2. **不要在 Factory 内置终端中运行补丁/还原**：脚本会检测到并自动中止。请完全退出 Factory 后，在系统自带的 PowerShell / CMD 中运行，或直接双击 `.bat`。
3. **杀毒软件误报**：补丁会改写 `factory-desktop.exe` 的内嵌哈希区，个别杀软可能提示文件被修改，请将 Factory 安装目录加入白名单。
4. **合规提示**：本补丁会修改 Factory 客户端文件，请自行斟酌相关服务条款风险；随时可用 `python restore.py` 或 `一键还原.bat` 无损还原。

---

## 🐛 问题排查

- **AI 流式输出时状态条中英文叠加** → v1.2 已修复。若当前安装的是旧补丁，请运行 `python patcher.py --force` 强制重建。
- **汉化后应用无法启动** → 运行 `python restore.py`（还原已带事务保护）；或重新安装 Factory Desktop 后再汉化。
- **界面部分英文残留** → 词库基于 0.199.x–0.201.x 构建，官方后续新增文案由 DOM 兜底引擎自动处理，仍漏译的欢迎提 Issue 补充词条。
- **还原后仍是中文** → 说明应用更新到从未打过补丁的新版本，属正常现象，重新汉化即可。

---

## 📂 目录结构

```text
factory-desktop-zh-cn/
├── engine/
│   ├── asar-patcher.js       # 核心 ASAR 重打包 + exe/Info.plist 完整性同步 + 四层补丁引擎（Windows & macOS）
│   └── dom-translator.js     # 渲染进程 DOM 兜底引擎（WeakMap 快照 + 代码区白名单 + data-text 伪元素同步）
├── locales/
│   ├── zh-CN.json            # 渲染进程 14,900+ 核心词库、pathOverrides 与动态前缀规则
│   └── zh-desktop-i18n.json  # Electron 主进程菜单栏与托盘词库
├── patcher.py                # 一键汉化入口（Windows & macOS）
├── restore.py                # 一键无损还原入口（Windows & macOS）
├── localize_sessions.py      # 本地历史会话标题汉化与无损还原
├── 一键汉化.bat               # Windows 双击汉化
├── 一键还原.bat               # Windows 双击还原
├── .gitignore
└── LICENSE
```

---

## 📝 更新日志

- **v1.2（2026-10-18）**
  - **修复**：AI 流式输出时状态条中英文叠加——根因是流光高亮层由 CSS `content: attr(data-text)` 伪元素渲染，DOM 引擎此前只翻译文本节点；现已同步翻译 `data-text` 属性（含宽度测量器），中英文不再叠加。
  - **新增**：Windows 内置终端运行保护（`patcher.py` / `restore.py` 通过进程祖先链检测，运行于 Factory 内置终端时自动中止）。
  - **加固**：Windows 补丁事务性——`exe` 完整性哈希更新失败时自动回滚 `app.asar`；还原流程改为「先算哈希 → 先写 exe → 后换 asar」，失败自动回滚 exe 哈希，任何路径都不会让应用无法启动。
  - **加固**：`restore.py` 锁实现与引擎对齐，新增持锁进程存活检查（Toolhelp32 / `OpenProcess`），不再盲删锁目录。
  - **清理**：移除 `localize_sessions.py` 中误带入的个人调试会话标题，仅保留官方默认占位标题。
  - `一键汉化.bat` / `一键还原.bat` 增加 `py -3` 启动器回退。
- **v1.1** — Windows 原生支持：Squirrel 目录探测、`factory-desktop.exe` 内嵌 ASAR 完整性哈希同步、一键 `.bat` 入口。
- **v1.0** — 首个版本（macOS）：四层混合汉化架构、LaunchAgent 自愈守护、更新按钮原生接管。

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。欢迎 Issue 与 PR 补充词条、反馈兼容性问题。
