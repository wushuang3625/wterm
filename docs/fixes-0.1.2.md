# wterm 0.1.2 — 启动、菜单与连接复用

## 实现

- Shell 探测不再运行 where.exe，改为 PATH 文件检查；探测结果在 Rust 进程内缓存。
- PTY 创建及首次 Shell 探测移至后台线程，避免阻塞 Tauri 窗口线程。
- 新建本地标签立即显示 connecting 状态，不等待 Shell 启动完成才显示。
- 默认使用 xterm DOM 渲染；WebGL 拆成懒加载包，设置中可启用。主 JS 从约 520 KB 减至约 425 KB。
- 设置增加“快速启动 PowerShell（跳过 Profile）”，默认关闭，避免破坏现有 Shell 环境。
- 箭头菜单在请求 IPC 前即登记为唯一实例；关闭后的异步结果不再恢复旧菜单。Shell 与 SSH config 并行读取、缓存；菜单位置限制在视口内。
- 使用自绘标题栏和窗口控制按钮。空白区双击新建默认终端；拖动达到阈值才移动窗口；最大化仅通过按钮触发。
- 标签右键“复制终端”：本地创建相同 Shell 的新进程，SSH 在已认证连接上新开通道。不复制正在执行的命令或进程内存。
- 普通连接入口在密码/私钥解锁弹窗之前查找同一主机、端口、用户名的已连接会话。显示别名不影响复用；连接中的同一账户只聚焦现有标签。OTP 不缓存。
- 同账户连接仍存活时才可复用；服务器拒绝额外通道时显示明确错误，不静默退回重新输入密码/MFA。所有对应连接均关闭后仍需重新认证。
- OTP 弹窗使用项目的背景、表单、按钮、焦点颜色和居中布局。

## 测量及验证

一次本机 Shell 探测对比：五次 where.exe 约 479 ms；PATH 文件检查约 4 ms。这不是整个程序或 PowerShell 完整启动的计时，不保证固定启动速度。debug 构建会记录 PTY 创建和首个输出的耗时。

通过：

- `npm run build`：严格类型检查、Vite 打包。
- `npm run test:ui`：4 个 Edge 浏览器交互测试。覆盖延迟 IPC 下快速开关菜单、视口边界、缓存、标题栏双击、标签复制、OTP 深色与居中样式、普通连接及复制复用通道。测试使用模拟 Tauri IPC，不连接真实服务器。
- `npm test`：5 个 ZMODEM 协议回归测试。
- `npm run test:ssh`：4 个独立 SSH 实现交叉验证测试。
- `npm run tauri -- build --no-bundle`：生成 0.1.2 release EXE。

仍需原生窗口实测：Windows 标题栏拖动/窗口按钮、完整冷启动耗时及实际 JumpServer 的多通道限制。

## 运行

新版：`src-tauri/target/release/wterm.exe`。

旧版已保留为 `src-tauri/target/release/wterm-0.1.1.exe`，正在运行的旧进程没有被关闭；已有连接不会自动迁移到新进程。

新版本号可在 EXE 属性、任务栏标题及左上角品牌提示中确认。

开发依赖安装：`npm install --include=dev --ignore-scripts`。UI 测试默认使用本机 Microsoft Edge（无需下载 Chromium）。
