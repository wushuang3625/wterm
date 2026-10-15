<div align="center">
  <img src="src-tauri/icons/icon.png" width="80" alt="wterm logo" />
  <h1>wterm</h1>
  <p><strong>本地终端、SSH 与 SFTP，一站式桌面工作台。</strong></p>
  <p>
    <a href="https://github.com/wushuang3625/wterm/releases"><img src="https://img.shields.io/github/v/release/wushuang3625/wterm?style=flat-square" alt="GitHub release" /></a>
    <img src="https://img.shields.io/badge/Tauri-2-24C8D8?style=flat-square" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&amp;logo=rust&amp;logoColor=white" alt="Rust" />
  </p>
  <p>
    <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a> ·
    <a href="https://wushuang3625.github.io/wterm/">官网</a> ·
    <a href="https://github.com/wushuang3625/wterm/releases">下载</a> ·
    <a href="https://github.com/wushuang3625/wterm/issues">反馈</a>
  </p>
</div>

---

wterm 将本地 Shell、SSH 连接管理、SFTP 文件传输和可选的 AI 助手整合在一个桌面应用中，适合日常开发、服务器管理与远程排障。界面基于 **Tauri 2、TypeScript 和 xterm.js**，由 Rust 提供终端与网络后端。

## 目录

[功能亮点](#功能亮点) · [下载安装](#下载安装) · [快速开始](#快速开始) · [AI 助手](#ai-助手) · [常用快捷键](#常用快捷键) · [配置与数据](#配置与数据) · [从源码运行](#从源码运行) · [当前边界](#当前边界) · [参与贡献](#参与贡献) · [许可证](#许可证)

## 功能亮点

| 功能 | 说明 |
| --- | --- |
| 本地终端 | 自动探测本地 Shell，支持 PowerShell、cmd 等；多标签、拖拽排序、递归分屏与广播输入。 |
| SSH 工作台 | 保存连接、分组与标签，快速连接、批量连接、keepalive、登录脚本及可配置的自动重连。 |
| SSH 认证 | 密码、私钥、系统 ssh-agent 与多轮 MFA；主机指纹确认及 `known_hosts` 校验。 |
| 跳板连接 | 支持最多 8 跳的 ProxyJump 链，每一跳独立认证和确认主机指纹。 |
| SFTP 文件管理 | 文件浏览、上传与下载、远程编辑回传、重命名、删除、目录创建及 Unix 权限修改。 |
| 传输队列 | 显示进度与速度，支持暂停、继续、取消和从头重试；可打开已完成的下载。 |
| 终端阅读 | 正则搜索、日志颜色规则、字体缩放、命令历史视图、sixel 与 iTerm2 图片预览。 |
| 外观与恢复 | 深浅主题、背景图、透明度、平台相关窗口效果、通知，以及标签、分屏和近期文字输出恢复。 |
| AI 助手（源码） | 自带 API Key（BYOK），解释与生成命令、总结输出、可选失败诊断；支持停靠面板、本机会话历史及按需展开思考过程。 |
| Windows 集成 | Windows 11 资源管理器「在 wterm 中打开」，从所选目录启动新窗口；需要满足包身份注册条件。 |

> **版本说明**：当前源码版本 `0.1.6` 包含 AI 助手、本机会话历史、终端插入修复和折叠思考过程。改动与本机验证见 [0.1.6 版本说明](docs/releases-0.1.6.md)；已发布的安装包以 [GitHub Releases](https://github.com/wushuang3625/wterm/releases) 为准，源码完成度与后续规划见 [功能清单](docs/feature-list.md)。

## 下载安装

前往 [GitHub Releases](https://github.com/wushuang3625/wterm/releases)，选择适合系统的安装包。

| 平台 | 当前说明 |
| --- | --- |
| Windows x64 | 推荐 NSIS（`.exe`）；可下载的包以对应 Release 为准，本机 `0.1.6` 构建提供 NSIS 安装包。 |
| Windows ARM64 | Explorer 扩展构建脚本支持 ARM64；可下载包及验证情况以 Release 为准。 |
| macOS / Linux | 源码包含平台适配；安装包及目标平台验证情况以 Release 为准。 |

Windows 运行依赖 Microsoft Edge WebView2 Runtime。本机构建的安装程序与 Explorer 身份包未签名；Windows 11 第一层右键菜单需要受系统信任的身份包，或已开启开发者模式的环境。NSIS 尝试自动注册，MSI 需手动注册；菜单注册失败不影响主程序安装。详见 [版本说明](docs/releases-0.1.6.md) 和 [资源管理器集成](docs/windows-explorer.md)。

## 快速开始

1. 启动应用，按 `Ctrl+Shift+T` 新建本地终端。
2. 在连接管理中添加 SSH 主机，填写地址、端口、用户名和认证方式；按 `Ctrl+P` 搜索并连接。
3. 首次连接时核对主机指纹。使用系统 ssh-agent 前，先启动 agent 并用 `ssh-add` 加载密钥。
4. 在 SSH 会话中按 `Ctrl+Shift+R` 打开远程文件面板，上传、下载或编辑文件。
5. 按 `Ctrl+,` 配置主题、字体、快捷键、通知与终端行为。

**跳板连接**：在 SSH 配置的跳板链中填写已保存连接名、SSH config 别名或 `user@host:port`；多跳用逗号分隔，IPv6 可写为 `user@[::1]:22`。

**目录联动**：开启 SFTP「跟随终端目录」后，远端 Shell 需通过 OSC 7 或 OSC 9;9 上报路径。面板提供 Bash、Zsh、Fish 配置片段，见 [远端目录联动配置](docs/remote-directory-sync.md)。

**命令块与图片**：在设置中选择关闭、Shell 标记（OSC 133）或输入推断模式；通过终端的「命令块」按钮切换到历史视图。复杂行编辑与交互程序可能影响输入推断。iTerm2 图片使用独立预览，sixel 在终端网格中显示，无需开启命令块。

**恢复会话**：重新启动时恢复标签、分屏和近期文字输出，再建立新 Shell / SSH 会话。历史仅供查看，不会重新执行旧命令或恢复原进程；备用屏幕与图片不恢复，手动关闭的标签不恢复。

## AI 助手

此部分说明当前源码中的功能；发布版是否包含，请查看对应 Release。

在「设置 → AI 助手」中选择服务商或自定义地址与协议，保存 API Key，再获取模型列表并勾选添加，或手动填写模型 ID。提供 OpenAI、Anthropic、DeepSeek、Moonshot、通义千问和本地 Ollama 预设；Ollama 无需 API Key。

- **打开与布局**：按 `Ctrl+Shift+K` 或点击机器人入口打开或折叠面板，默认停靠右侧，可改为左侧或终端上方，并调整宽高。分隔条显示为细线，仍可拖动或用方向键调整；折叠后请求继续运行。
- **解释与总结**：选中终端文字，在鼠标附近的 AI 按钮或右键菜单中选择「解释命令」「排查问题」「插入会话」，内容会带入聊天草稿；`Ctrl+Shift+I` 也可准备解释问题。
- **生成命令**：输入需求，审阅回复后复制代码；符合条件的单行命令可插入当前匹配连接的终端，不追加回车。多行或含控制字符的代码仅供复制。
- **对话历史**：在本机保存对话，支持全部会话或按连接查看、搜索。单击预览并继续编辑，双击或 Enter 激活；重命名、置顶、删除放在右键菜单。多个会话可同时生成回复，列表显示运行圆环。
- **思考过程**：服务商返回思考文本或摘要时，回复上方默认折叠，展开后实时查看；内容随会话保存，不加入后续模型问答的上下文。
- **失败诊断**：默认关闭。启用后，仅分析活动会话中明确上报非零退出码的命令，附带该命令最后最多 6000 字符输出。本地 PowerShell 已接入；远端 Shell 需配置退出码标记，cmd 当前不提供退出码。
- **请求控制**：支持流式回复、运行状态、独立停止和失败重试，切换终端标签不会中断请求。当前没有工具执行器，AI 建议由用户审阅后执行。

请求由本机 Rust 后端直连配置的服务地址，API Key 按地址与协议分别保存在系统凭据库。请求可能包含输入、显式附带的终端片段及有限对话历史；自动诊断会额外发送失败命令、退出码与有限输出，并尝试隐藏常见凭据。脱敏无法覆盖全部敏感信息。AI 对话数据库以未加密形式保存在本机，可能包含终端片段。服务商可能按 API 使用量收费。实现记录与验证范围见 [AI 说明](docs/ai-review.md)。

## 常用快捷键

以下为默认绑定，可在设置中修改，并切换 wterm、VS Code 或 iTerm2 预设。

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Shift+T` | 新建本地标签 |
| `Ctrl+Shift+W` | 关闭当前窗格 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签 |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | 左右 / 上下分屏 |
| `Ctrl+P` | 快速连接 |
| `Ctrl+K` | 命令面板 |
| `Ctrl+F` | 搜索终端 |
| `Ctrl+Shift+R` | 远程文件面板 |
| `Ctrl+=` / `Ctrl+-` | 放大 / 缩小字体（`Ctrl++` 也可放大） |
| `Ctrl+,` | 偏好设置 |
| `Ctrl+Shift+I` | AI 解释选中内容 |
| `Ctrl+Shift+K` | 打开 AI 助手 |

完整动作表见 [`src/shortcuts.ts`](src/shortcuts.ts)。

## 配置与数据

Windows 默认配置目录为 `%APPDATA%\wterm\`；macOS / Linux 使用系统配置目录下的 `wterm/`。

| 文件或存储 | 用途 |
| --- | --- |
| `settings.json` | 外观、终端行为、通知、快捷键、收藏和 AI 偏好。 |
| `settings-location.json` | 记录自定义设置文件位置。 |
| `profiles.json` | SSH 连接、分组、标签及认证配置，不包含保存的密码或私钥口令。 |
| `ai-history.sqlite3` | 当前源码中的本地 AI 对话、草稿与附带上下文。 |
| 系统凭据库 | SSH 密码、私钥口令与 AI API Key。 |
| WebView 本地存储 | 窗口布局、近期终端文字输出等运行状态。 |

可在「设置 → 常规设置 → 配置文件」更改 `settings.json` 的绝对路径。切换时会写入当前设置并保留旧文件；该选项不移动 SSH 配置或 AI 历史。手工修改设置文件后重启应用生效，首次启动会迁移旧版偏好设置。

分享配置前检查主机地址、登录脚本和对话内容；系统凭据库中的秘密不会随配置文件一起迁移。

## 从源码运行

### 环境要求

- Git、Node.js 22 或更高版本，以及 npm。
- Rust 1.89 或更高版本与 Cargo。
- Windows：MSVC 工具链、Visual Studio C++ Build Tools、WebView2，以及包含 `MakeAppx.exe` 的 Windows SDK；桌面开发启动也会构建 Explorer 扩展。
- macOS / Linux：安装对应系统的 Tauri 依赖，详见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)。

### 启动桌面开发版

```bash
git clone https://github.com/wushuang3625/wterm.git
cd wterm
npm ci
npm run tauri -- dev
```

该命令启动 Vite 与桌面应用。`npm run dev:web` 仅启动前端开发服务器，完整终端、SSH、SFTP 和 AI 功能需要 Tauri 后端。

### 构建安装包

```bash
npm run tauri -- build
```

Tauri 会自动运行前端构建及相关准备脚本，无需先手动构建前端。默认安装包位于 `src-tauri/target/release/bundle/`。Windows 可仅构建 NSIS：

```bash
npm run tauri -- build --bundles nsis
```

Explorer 身份包的签名与注册要求见 [构建和安装说明](docs/windows-explorer.md)。

### 检查与测试

在项目根目录执行：

```bash
npm run typecheck
npm test
npm run build:web
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:ui
```

UI 测试按当前配置使用 Microsoft Edge（`msedge`），并自动启动 Vite。浏览器测试使用模拟桌面接口；SSH 与 AI 的部分测试使用本机协议服务，不能替代真实服务器、服务商或目标操作系统验收。

### 项目结构

```text
wterm/
├── src/                    # TypeScript 界面、终端、SSH/SFTP 与 AI 交互
├── src-tauri/
│   ├── src/                # Rust：PTY、SSH、SFTP、凭据、AI 与历史存储
│   ├── shell-extension/    # Windows Explorer 原生扩展
│   ├── windows/            # 身份包、注册脚本与安装钩子
│   └── tauri.conf.json     # 应用及构建配置
├── scripts/                # 桌面构建与 Explorer 打包脚本
├── tests/                  # 单元测试及 Playwright UI 测试
├── docs/                   # 功能核验、使用说明与发布记录
└── package.json            # npm 依赖和命令
```

### 故障排查

- **开发版白屏**：debug 程序默认读取 `http://localhost:1420`。使用 `npm run tauri -- dev` 启动；单独运行 debug 可执行文件前需先启动 Vite。生产构建内嵌前端资源。
- **快捷键无反应**：检查当前预设、输入框焦点与系统输入法热键。debug 日志通常位于 Windows 的 `%TEMP%\wterm-debug.log`。
- **SFTP 不跟随目录**：确认远端 Shell 已发送路径标记；先绕过 tmux / screen 测试，见 [目录联动排查](docs/remote-directory-sync.md#故障排查)。
- **Windows 原生 ssh 报 `getsockname` 错误**：如配置启用了 ControlMaster，可用 `ssh -o ControlMaster=no -o ControlPath=none -o ControlPersist=no <host>` 验证。wterm 内置 SSH 通道复用不依赖这些选项。

## 当前边界

- SSH config 不展开 `Include`、`Match` 或 `Host` 通配符默认项，不执行 `ProxyCommand`；PuTTY 导入尚未实现。
- ssh-agent 暂不支持证书身份、Pageant 或 agent forwarding；端口转发与 Mosh 尚未实现。
- SFTP 不支持递归目录传输、压缩解压、拖出到系统文件管理器，或跨断线 / 重启的断点续传。暂停仅在当前连接内继续；重试从头开始，目标可能保留部分文件。
- WebDAV / Gist 同步、主题配色导入、Workspace 组合与跨窗口会话迁移尚未实现。
- AI 没有工具执行器；真实服务商联调与正式发布待验收。JumpServer、系统 agent、不同 SFTP 服务端及 Explorer 菜单仍需目标环境验证。

## 参与贡献

欢迎通过 [Issues](https://github.com/wushuang3625/wterm/issues) 提交问题或建议，通过 Pull Request 提交改进。

报告问题时请提供应用版本、操作系统、复现步骤、预期与实际行为，以及脱敏后的日志。提交代码前运行与改动相关的检查，并说明测试结果；修改功能时同步更新文档。

## 许可证

仓库目前未包含独立的 `LICENSE` 文件。功能规划中的 MIT / Apache-2.0 是候选方案，尚不代表已采用的项目许可；具体授权条款需由维护者明确。
