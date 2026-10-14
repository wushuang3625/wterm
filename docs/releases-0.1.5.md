# wterm v0.1.5

本次提供 Windows x64 的 NSIS 安装程序和 MSI 安装包，使用 Tauri 2、TypeScript 和 xterm.js。

## 更新

- 关闭窗口后保存终端文字历史；重新启动时恢复标签、分屏和历史，再建立新会话。历史不会重新执行命令，备用屏幕和图片不恢复。
- 偏好设置迁入 `settings.json`，支持更改配置文件路径；密码与私钥短语继续使用系统 Keychain。
- 命令历史按需显示；iTerm2 图片使用独立预览，支持适应窗口和原始大小。
- 改进标签拖动、分屏交互、滚动跟随与顶部／底部导航，补充护眼主题和自适应日志颜色。
- SFTP 下载完成后可打开文件或定位到文件目录。
- 新增 Windows 11 资源管理器「在 wterm 中打开」扩展，支持中文、空格及 UNC 路径，并隔离从资源管理器打开的窗口历史。

## 安装与边界

- 推荐使用 `wterm_0.1.5_x64-setup.exe`。MSI 安装后需手动运行安装目录中的 `Register-ExplorerIntegration.ps1` 注册右键菜单。
- 此次安装程序和 Explorer 身份包未签名。普通用户启用右键菜单需要系统信任的签名身份包；已开启开发者模式的机器可注册开发清单。安装脚本不会开启开发者模式、安装证书或修改安全策略；菜单注册失败不影响主程序安装。
- 系统 ssh-agent、真实 JumpServer、不同 SFTP 服务端，以及 Windows 11 第一层右键菜单的显示与启动仍需在目标环境验收。
- SSH config 的 Include、Match 与 ProxyCommand，递归目录传输及跨重启断点续传仍未实现。

详细安装说明见 [Windows Explorer 集成](windows-explorer.md)，其余边界见 [README](../README.zh-CN.md#当前边界)。

## 本次验证

- 前端生产构建与 TypeScript 检查通过。
- 前端单元测试 13 项、界面测试 48 项全部通过。
- Rust 后端测试 17 项、Explorer 原生扩展测试 1 项全部通过。
- Windows x64 的 NSIS 和 MSI 安装包构建通过。
