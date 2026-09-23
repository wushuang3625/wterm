# wterm 0.1.4 — 终端字体缩放快捷键

## 快捷键缩放

- `Ctrl+=`（含 `Ctrl++`，即 Shift+=）放大终端字体，`Ctrl+-` 缩小；步进 1px，范围 8–40px，与设置内「字号」输入框的取值范围一致。
- 缩放对所有已打开的标签、分屏窗格立即生效，并写入 `wterm_font_size`：重启应用、窗口布局恢复后沿用，新建终端也按缩放后的字号创建。
- 两个动作接入统一快捷键表（`src/shortcuts.ts`），在「设置 → 快捷键」中与其他动作一样展示、重映射；切换内置预设（wterm / VS Code / iTerm2）未覆盖时回退默认值 `Ctrl+=` / `Ctrl+-`。
- 终端聚焦时由 xterm 自定义按键处理器拦截，缩放按键不会下发到本地或远端 Shell；断开重连、复制标签后缩放结果保留。
- `keyChord()` 将 `+`（Shift+=）归一为 `=`，因此 `Ctrl+=` 与 `Ctrl++` 命中同一绑定；在快捷键编辑器中按下任一组合都会记录为 `Ctrl+=`。

## 与设置内字号的关系

设置内「字号」（`cfg-font-size`）保存走既有链路：`applyAppearance()` 派发 `wterm-appearance-changed` → `refreshTerminalTheme()` 重读 `wterm_font_size` 并统一生效；快捷键缩放直接写同一键并逐会话更新 `term.options.fontSize` 后重新 fit。两条路径共用一份偏好，互不冲突。

## 验证范围

- `npm run typecheck`（tsc --noEmit）通过；`npm test` 10 个单元测试全部通过。
- 未新增 UI 自动化用例：缩放命中快捷键表后，与设置内「字号」共用保存—应用链路可被覆盖；真实按键行为（不同键盘布局下 `=` / `+` / `-` 的 `e.key` 表现）仍需人工在窗口内确认。
