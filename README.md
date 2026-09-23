# wterm

开源、轻量、设计驱动的 SSH 工作台 —— **Warp 的颜值 + Tabby 的功能 + 零订阅**。

## 当前状态：v0.1.4（预览版）

核心闭环已验证，日常可用范围：

- ✅ 本地 Shell 终端（PowerShell / cmd 等自动探测）+ 多标签 + 递归分屏
- ✅ xterm.js（可选 WebGL）、终端搜索（Ctrl+F）、主题系统（深/浅 + 10 套内置）、字号快捷缩放（Ctrl+= / Ctrl+-）
- ✅ SSH 连接管理（Profile 持久化、分组/标签、树形整理、Ctrl+P 快速连接）
- ✅ 认证：密码 / 私钥 / 系统 ssh-agent（Windows named pipe、Unix SSH_AUTH_SOCK）/ MFA（多轮 OTP）
- ✅ 凭据可选写入系统 Keychain（`keyring`）
- ✅ ProxyJump 跳板链（最多 8 跳）、自动重连（可配退避）、keepalive、登录脚本
- ✅ SFTP 侧栏文件浏览器、传输队列（进度/暂停/重试）、chmod、目录联动、远程编辑
- ✅ 命令面板（Ctrl+K）、自定义快捷键、收藏、批量开主机、分屏广播输入
- ✅ 窗口布局启动恢复、系统通知（命令完成/断开/关键词）、毛玻璃/背景图/透明度
- 🟨 部分完成与 ❌ 未完成项见 [功能清单 · 实现核验](docs/feature-list.md)（唯一权威状态）

已知边界（发布说明请如实标注）见 README「当前边界」与 [0.1.4 验收说明](docs/fixes-0.1.4.md)。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2（Rust 后端 + WebView2 前端） |
| 前端 | TypeScript + Vite + xterm.js（WebGL / image / search addon） |
| 后端 | Rust：`portable-pty`（本地 PTY）、`russh`（SSH）、`keyring`（凭据）、`window-vibrancy`（窗口效果） |

## 目录结构

```
wterm/
├── index.html              # 入口 HTML（含主题变量）
├── src/                    # 前端 TypeScript
│   ├── main.ts             # 应用主体：标签、会话生命周期、布局恢复、快捷键分发
│   ├── terminal.ts         # xterm.js 封装 + 后端 IO 桥接 + 链接识别
│   ├── profiles.ts         # SSH 配置 / 设置 / 连接管理 UI
│   ├── sftp.ts             # SFTP 面板
│   ├── transfer-queue.ts   # 传输队列
│   ├── shortcuts.ts        # 快捷键动作表与预设
│   ├── themes.ts           # 内置主题
│   ├── notifications.ts    # 系统通知
│   ├── credentials.ts      # Keychain 前端封装
│   ├── sshimport.ts        # ~/.ssh/config 导入
│   ├── knownhosts.ts       # known_hosts 管理
│   ├── appearance.ts       # 背景 / 透明度 / 窗口效果
│   └── styles.css          # 视觉体系
├── src-tauri/src/          # Rust 后端
│   ├── lib.rs              # Tauri 命令注册
│   ├── pty.rs              # 本地伪终端 + 输出转发
│   ├── ssh.rs              # russh 连接 + 通道 actor
│   ├── ssh_route.rs        # ProxyJump 路由解析
│   ├── ssh_auth.rs         # 认证策略（含 MFA / partial-success）
│   ├── ssh_agent.rs        # 系统 ssh-agent
│   ├── sshconfig.rs        # SSH config 解析
│   ├── sftp.rs             # SFTP 后端
│   ├── transfers.rs        # 传输引擎
│   ├── known_hosts.rs      # known_hosts 读写
│   ├── credentials.rs      # 系统 Keychain
│   ├── windowing.rs        # 窗口 / 外部打开 / vibrancy
│   ├── session.rs          # 会话抽象（本地 / SSH 统一接口）
│   ├── profiles.rs         # SSH 配置 JSON 持久化
│   └── state.rs            # 全局会话表
├── src-tauri/capabilities/default.json   # 权限（事件监听必需！）
├── src-tauri/tauri.conf.json
└── docs/
    ├── feature-list.md     # 功能清单与实现核验（权威状态）
    ├── remote-directory-sync.md # 远端 Shell 目录联动配置
    ├── fixes-0.1.4.md      # 0.1.4 实现与验收说明
    ├── fixes-0.1.3.md      # 0.1.3 实现与验收说明
    ├── fixes-0.1.2.md      # 0.1.2 历史记录
    └── fixes-search-mfa-zmodem.md  # 0.1.1 历史记录
```

## 运行

### 开发模式（推荐）

```bash
npm install
npx tauri dev
```

`tauri dev` 会同时启动 Vite 开发服务器和桌面应用，并支持前端热重载。

> ⚠️ **注意**：debug 构建的二进制默认加载 `devUrl`（`http://localhost:1420`）。
> 因此**不要**直接双击运行 `target/debug/wterm.exe`——必须先启动 Vite（`npm run dev`），
> 否则窗口白屏。生产构建（`tauri build`）会内嵌前端资源，无此限制。

### 构建安装包

```bash
npm run build
npx tauri build
```

## 快捷键（常用）

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+T` | 新建本地终端 |
| `Ctrl+Shift+W` | 关闭当前会话 |
| `Ctrl+Tab` | 切换到下一个会话 |
| `Ctrl+P` | 快速连接（模糊搜索） |
| `Ctrl+K` | 命令面板 |
| `Ctrl+F` | 终端内搜索 |
| `Ctrl+=` / `Ctrl++` | 放大终端字体 |
| `Ctrl+-` | 缩小终端字体 |

全部可在设置中重映射，含 wterm / VS Code / iTerm2 预设（见 `src/shortcuts.ts`）。

## SSH 配置存储位置

`%APPDATA%\wterm\profiles.json`（Windows）

## 排查问题

debug 构建下，前端 JS 异常与后端 PTY 错误会写入：

```
%TEMP%\wterm-debug.log
```

白屏类问题可优先查看此文件。

### 快捷键无反应时自检

仅 debug 构建（`npx tauri dev`）会记录。快捷键按下后会写入日志，按下无反应的组合键（如 Ctrl+Shift+E）后查看本文件即可定位原因：

- 日志无任何记录：按键被系统或输入法截走（Windows 下 Ctrl+Shift 可能被用作切换输入法热键，可切换输入法为英文键盘后再试，或在「设置 → 快捷键」改绑到 Ctrl+Alt 组合）。
- `快捷键被跳过`：有对话框未关闭，或焦点在输入框内。
- `快捷键未匹配`：该组合键当前未绑定动作——多为在设置里应用过 VS Code / iTerm2 预设（如预设中上下拆分是 Ctrl+Shift+\\），点「恢复默认」或重新绑定即可。
- `快捷键命中 ... -> splitV` 但界面无变化：属会话状态问题，请附带日志反馈。

## ProxyJump、ssh-agent 与 SFTP

- 新建 SSH 连接的“跳板链”可填写已保存连接名、SSH config 别名，或 user@host:port；多跳用逗号分隔，IPv6 写为 user@[::1]:22。每一跳独立确认指纹及认证，最多 8 跳。
- 已保存跳板沿用其密码、私钥或 agent 配置；直接地址默认使用系统 agent。导入 SSH config 时保留 ProxyJump。
- “系统 ssh-agent”会请求本机 agent 签名。Windows 使用 OpenSSH named pipe（或 SSH_AUTH_SOCK 指定的 named pipe）；Unix 使用 SSH_AUTH_SOCK。请先启动 agent 并用 ssh-add 添加密钥。
- SFTP 支持传输队列、进度/速度、暂停/继续、取消、从头重试、覆盖确认和下载另存为。队列每次并发最多 2 项，同会话同一上传目标串行执行。
- 支持 Unix 权限修改。SFTP「跟随终端目录」支持远端 Shell 通过 OSC 7 或 OSC 9;9 上报路径；面板内提供 Bash、Zsh、Fish 配置片段和复制按钮。详细说明见 [远端目录联动配置](docs/remote-directory-sync.md)。
- 详见 [0.1.3 实现与验收说明](docs/fixes-0.1.3.md)。

## 当前边界

- agent 暂不支持证书身份、Pageant 或转发到远程。
- SSH config 仍不展开 Include / Match / 通配符默认项；ProxyCommand 不执行。
- SFTP 暂停可继续当前连接内的传输；失败、取消或程序重启后没有持久化断点续传，重试从头开始，目标可能保留部分文件。
- 递归目录传输、拖出文件至系统文件管理器、压缩解压仍未实现。
- 真实 JumpServer、系统 agent 服务及不同 SFTP 服务端仍需实机验收；自动化测试使用独立本机协议服务器。
- 字号快捷键缩放按按键产生的字符（`=` / `+` / `-`）匹配，个别键盘布局下按键位置不同时可在「设置 → 快捷键」重映射。

## 下一步

见 `docs/feature-list.md` 的「版本切分建议」（已按 2026-09-22 实现核验刷新），当前未完成项主要包括：

- **配置**：全量设置文件化（5.1，目前仅 profiles.json 落盘）、WebDAV/Gist 同步
- **SSH**：端口转发、Mosh、PuTTY/Tabby 导入、SSH config Include/Match、agent 证书/转发
- **SFTP**：断点续传、压缩解压、拖出下载、递归目录传输
- **界面**：Workspace、主题配色导入、多窗口会话迁移
- **其他**：串口/Telnet、AI（BYOK）

## 连接菜单与终端设置

- 快速连接菜单按最近 3 个成功连接、收藏、新建自定义连接、本地终端、已保存连接排列。
- 双击标题栏空白处最大化或还原；分屏不再显示重复工具条，悬停窗格右上角可拖动交换位置。
- 设置内可更改快捷键和终端字体，保存后立即生效；也可随时用 Ctrl+= / Ctrl++ 放大、Ctrl+- 缩小字号（8–40px）。
- 分屏后点击标题栏“广播输入”向当前标签的已连接窗格广播，再点击“停止广播”关闭。

### Windows ssh 的 getsockname 报错

原生 Windows OpenSSH 不支持 ControlMaster 连接复用。如果 ssh -G 主机别名显示 controlmaster auto 和 controlpath，可用以下命令关闭复用验证：

```powershell
ssh -o ControlMaster=no -o ControlPath=none -o ControlPersist=no jumpserver
```

长期使用时，在 Windows SSH 配置对应 Host 段、通配符默认段之前设置 ControlMaster no、ControlPath none、ControlPersist no。wterm 内置 SSH 的通道复用不依赖这些选项。
