# Windows 11 资源管理器菜单

右键文件夹或文件夹内空白处，使用第一层菜单里的 **在 wterm 中打开**。每次打开一个新窗口，并将所选目录作为本地 Shell 的工作目录。目录通过进程参数传递，支持中文、空格和 UNC 路径，不经过 Shell 拼接。

普通启动仍恢复原来的布局和历史；资源管理器打开的窗口使用独立存储位置，避免覆盖普通窗口的历史。

## 构建和安装

Windows 构建需要 Rust MSVC 工具链和 Windows SDK（包含 MakeAppx.exe）。

```powershell
npm run tauri -- build --bundles nsis
```

构建过程编译原生 `IExplorerCommand` DLL，生成 sparse MSIX 身份包，随安装程序放到 wterm.exe 同一目录。NSIS 安装时为当前用户注册，卸载时注销。MSI 安装后需手动运行下面的注册命令；MSI 暂未加入自动注册动作。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "安装目录\Register-ExplorerIntegration.ps1"
# 移除菜单（保留程序）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "安装目录\Register-ExplorerIntegration.ps1" -Remove
```

开发机器若已启用开发者模式，注册脚本可直接注册 loose manifest。普通用户发布必须提供受系统信任的签名身份包。脚本不会开启开发者模式、安装证书或更改系统策略。

NSIS 即使安装 x64 程序，也运行在 32 位进程中。安装钩子使用 `Sysnative` 启动系统原生 PowerShell；注册脚本也会从 32 位 PowerShell 自动切换到原生进程，并显式读取 64 位注册表，避免误判开发者模式关闭。

如果此前从另一个目录注册过同一身份包，脚本会先确认旧注册可恢复，再注销并注册到新安装目录；迁移失败时尝试恢复旧注册。仅处理当前用户的 wterm 身份包，开发注册迁移使用 `PreserveApplicationData` 保留包数据。

发布构建可设置 `WTERM_EXPLORER_CERT_THUMBPRINT`，由 Windows SDK SignTool 使用当前用户证书存储中的现有证书签名 MSIX；证书 Subject 必须与包和可执行文件清单的 `CN=wterm` 一致。可选 `WTERM_EXPLORER_TIMESTAMP_URL` 指定时间戳服务。生产证书若使用不同 Subject，需要同步更新 `windows/app.manifest` 与 `windows/AppxManifest.xml.template` 的 Publisher。

```powershell
$env:WTERM_EXPLORER_CERT_THUMBPRINT = '现有证书指纹'
npm run tauri -- build --bundles nsis
```

右键扩展的位数必须匹配资源管理器；支持 x64 和 ARM64。注册或升级后若菜单未刷新，关闭并重新打开资源管理器窗口；必要时由用户重启资源管理器或重新登录。

## 验证

```powershell
npm run build:explorer
cargo test --manifest-path src-tauri/shell-extension/Cargo.toml --target-dir src-tauri/target/shell-extension --offline
cargo test --manifest-path src-tauri/Cargo.toml startup --lib --offline
npx playwright test tests/explorer-launch.ui.spec.ts tests/session-history.ui.spec.ts
Get-AppxPackage -Name dev.wterm.Explorer
```

原生测试检查 COM 类工厂、接口和对象释放；浏览器测试检查目录传递及历史隔离。实际第一层菜单位置和点击启动仍应在 Windows 11 资源管理器中验收。

实现依据：[Microsoft 资源管理器扩展说明](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer)、[未打包应用的包身份](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)。
