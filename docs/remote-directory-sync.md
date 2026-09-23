# 远端目录联动配置

wterm 的 SFTP 面板可以跟随 SSH 终端当前目录。勾选「跟随终端目录」后，远端 Shell 每次显示提示符时需要向终端发送当前路径；wterm 支持 OSC 7 文件 URI 和 OSC 9;9 原始路径。此功能不需要在服务器安装程序，也不需要 root 权限。

## 先做一次测试

在 wterm 的 SSH 终端中运行：

```sh
printf '\033]9;9;%s\a' "$PWD"
```

命令不会打印可见文本。若 SFTP 面板切换到了当前目录，上报链路正常。之后可以在终端运行 `cd /tmp`，确认开启「跟随终端目录」时 SFTP 也切换到 `/tmp`。

## 持久配置

将对应片段添加到**远端服务器**上当前用户的 Shell 配置文件。重新连接 SSH 后生效。已有自定义提示符钩子时，保留原钩子并把 `__wterm_report_cwd` 加进去，不要用下面的设置覆盖自己的提示符逻辑。

### Bash

添加到 `~/.bashrc`：

```bash
__wterm_report_cwd() { printf '\033]9;9;%s\a' "$PWD"; }
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__wterm_report_cwd)
else
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__wterm_report_cwd"
fi
```

这会把上报函数追加到 Bash 的 `PROMPT_COMMAND`；数组形式也会保留。如果远端 Bash 登录配置没有读取 `~/.bashrc`，请在 `~/.bash_profile` 中加载它。

### Zsh

添加到 `~/.zshrc`：

```zsh
autoload -Uz add-zsh-hook
__wterm_report_cwd() { printf '\033]9;9;%s\a' "$PWD"; }
add-zsh-hook -d precmd __wterm_report_cwd 2>/dev/null
add-zsh-hook precmd __wterm_report_cwd
```

使用 `precmd` 钩子，不会替换已有的 `precmd` 函数。

### Fish

添加到 `~/.config/fish/config.fish`：

```fish
function __wterm_report_cwd --on-event fish_prompt
    printf '\033]9;9;%s\a' "$PWD"
end
```

## 故障排查

- 配置针对远端 SSH 登录用户，不是运行 wterm 的本机 Shell。
- 修改配置后断开并重新连接 SSH，再测试 `cd`。
- 若一次性测试能切换 SFTP 路径，但 `cd` 后不能自动切换，检查 Shell 配置文件是否加载，以及提示符钩子是否实际运行。
- 若 Shell 在 tmux 或 screen 中运行，复用器可能拦截 OSC 序列；先在不经过复用器的 SSH 会话中测试。
- wterm 也识别 OSC 7（格式为 `ESC ] 7 ; file://主机/路径`）；如果已使用发送 OSC 7 的 Shell 集成，无需重复添加上面的 OSC 9;9 钩子。
