# wterm 0.1.1：JumpServer / rz 第二轮修复

## 问题定位

旧 wterm 在私钥认证后、OTP 挑战出现之前失败。旧依赖 russh 0.45 的客户端认证状态存在两个关键限制：

- 切换认证方式时没有同步 keyboard-interactive 的挑战解析状态（client/encrypted.rs 的 write_auth_request_if_needed）。
- USERAUTH_FAILURE 中的 partial-success 位没有传递给调用方。

因此仅添加前端 MFA 输入框不足以修复私钥后继续 MFA 的路径。

## 本轮改动

- russh 升至 0.63.3，Rust 最低版本相应为 1.89；RSA 使用服务端支持的签名算法。
- 认证策略抽离为 `src-tauri/src/ssh_auth.rs`：依据服务器剩余认证方法继续，保留 partial-success，支持多轮 OTP 与普通密码。删除旧嵌套布尔值认证分支。
- 终端显示不含凭据的认证阶段信息；取消/超时后断开认证连接。
- ZMODEM 不再依赖可能永远不 resolve 的传输 Promise 来释放终端；结束、取消、错误、远端 abort、120 秒无协议活动都释放键盘并恢复光标。
- 文件对话框打开前和关闭后恢复终端文本光标及 Windows 原生鼠标指针。
- 增加可点击的传输取消按钮和 Ctrl+C 取消；取消同时向远端发送中断。
- Tauri 字节写入串行化，避免协议包乱序。
- 补上 `dialog:allow-save` 与 `core:window:allow-set-cursor-visible` 权限。
- 添加 TypeScript 严格检查，纳入 `npm run build`。
- EXE 窗口标题明确标注 `wterm 0.1.1 — SSH / MFA 修复版`。

没有删除用户配置、SSH 私钥或整个项目。旧调试进程未被强制关闭。

## 验证

通过：

- `npm run build`（TypeScript 严格检查 + Vite）。
- `npm test`：5 项 ZMODEM 测试，包括真实协议双方的二进制上传/下载内容比对、对话框未关闭时取消、超时和远端中断。
- `npm run test:ssh`：4 项跨实现 localhost SSH 测试；客户端为实际生产认证函数，服务端为独立的 Node ssh2。覆盖签名验证后的 partial-success → 两轮 MFA → 认证通道输出、错误 OTP、取消、普通密码。
- `npm run tauri -- build --no-bundle`：生成完整 release EXE。

测试不会连接实际 JumpServer，不使用真实私钥或 OTP。测试服务器只监听 127.0.0.1，密钥临时生成。

最终自动审查服务因 WebSocket 连接错误不可用。

## 运行与实机验收

运行 `src-tauri/target/release/wterm.exe`。旧 debug EXE 不会自动升级；先确认新窗口标题为 0.1.1。

仍需实际验证：

1. 从 SSH 菜单连接 JumpServer，观察私钥认证后是否出现 OTP 输入框并完成登录。
2. 在内置 SSH 会话中执行 rz，检查鼠标指针、文件选择、取消后命令输入与上传文件内容。
3. 验证 sz 的原生保存对话框。

注意：本地 PowerShell 内另行启动 ssh 的输出经过 Windows ConPTY，与内置 SSH 原始字节通道不同；上述协议测试不证明 ConPTY 对二进制 ZMODEM 的兼容性。

## 上一轮 UI 改动保留

顶栏仅文件/设置；新建菜单搜索；Ctrl+F 搜索浮层；Ctrl+| 左右分屏、Ctrl+_ 上下分屏；SSH 导入位于新建菜单。
