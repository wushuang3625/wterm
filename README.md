<div align="center">
  <img src="src-tauri/icons/icon.png" width="80" alt="wterm logo" />
  <h1>wterm</h1>
  <p><strong>A desktop workspace for local terminals, SSH, and SFTP.</strong></p>
  <p>
    <a href="https://github.com/wushuang3625/wterm/releases"><img src="https://img.shields.io/github/v/release/wushuang3625/wterm?style=flat-square" alt="GitHub release" /></a>
    <img src="https://img.shields.io/badge/Tauri-2-24C8D8?style=flat-square" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&amp;logo=rust&amp;logoColor=white" alt="Rust" />
  </p>
  <p>
    <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a> ·
    <a href="https://wushuang3625.github.io/wterm/">Website</a> ·
    <a href="https://github.com/wushuang3625/wterm/releases">Download</a> ·
    <a href="https://github.com/wushuang3625/wterm/issues">Issues</a>
  </p>
</div>

---

wterm brings local shells, SSH connection management, SFTP transfers, and an optional AI assistant into one desktop application for development, server administration, and troubleshooting. It uses **Tauri 2, TypeScript, and xterm.js**, with a Rust backend for terminals and networking.

## Contents

[Features](#features) · [Installation](#installation) · [Quick start](#quick-start) · [AI assistant](#ai-assistant) · [Keyboard shortcuts](#keyboard-shortcuts) · [Configuration and data](#configuration-and-data) · [Development](#development) · [Known limitations](#known-limitations) · [Contributing](#contributing) · [License](#license)

## Features

| Feature | Details |
| --- | --- |
| Local terminals | Shell detection, including PowerShell and cmd; tabs, drag reordering, recursive splits, and broadcast input. |
| SSH workspace | Saved connections, groups, tags, quick connect, batch connections, keepalive, login scripts, and configurable reconnection. |
| SSH authentication | Passwords, private keys, system ssh-agent, multi-round MFA, fingerprint confirmation, and `known_hosts` checks. |
| Jump hosts | ProxyJump chains of up to 8 hops, with independent authentication and host-key confirmation. |
| SFTP file management | Browse, upload, download, edit remote files and upload changes, rename, delete, create directories, and change Unix permissions. |
| Transfer queue | Progress and speed, pause, continue, cancel, and retry from the beginning; open completed downloads. |
| Terminal reading | Regex search, log coloring rules, font zoom, command history, sixel, and iTerm2 image previews. |
| Appearance and recovery | Light/dark themes, backgrounds, transparency, platform-specific window effects, notifications, and restoration of tabs, splits, and recent text output. |
| AI assistant (source) | Bring your own API key (BYOK); explain and generate commands, summarize output, optionally diagnose failures, and keep local conversations in a docked panel with collapsible thinking content. |
| Windows integration | “Open in wterm” in the Windows 11 Explorer context menu; opens a new window in the selected directory and requires package identity registration. |

> **Version note:** Source version `0.1.6` includes the AI assistant, local conversation history, terminal insertion fixes, and collapsible thinking content. See the [0.1.6 notes](docs/releases-0.1.6.md) for changes and local validation. Published packages are listed on [GitHub Releases](https://github.com/wushuang3625/wterm/releases); implementation status and plans are tracked in the [feature checklist](docs/feature-list.md).

## Installation

Visit [GitHub Releases](https://github.com/wushuang3625/wterm/releases) and choose a package for your system.

| Platform | Status |
| --- | --- |
| Windows x64 | NSIS (`.exe`) is recommended. See the corresponding Release for available packages; the local `0.1.6` build provides an NSIS installer. |
| Windows ARM64 | Explorer build scripts support ARM64; consult the Release for available packages and validation status. |
| macOS / Linux | Platform adaptations exist in source; consult the Release for packages and target-platform validation. |

Windows requires Microsoft Edge WebView2 Runtime. The local installers and Explorer identity package are unsigned. The Windows 11 top-level context menu requires a trusted identity package or an environment with Developer Mode already enabled. NSIS attempts registration automatically; MSI requires manual registration. Registration failure does not prevent the application from being installed. See the [release notes](docs/releases-0.1.6.md) and [Explorer guide](docs/windows-explorer.md).

## Quick start

1. Launch wterm and press `Ctrl+Shift+T` to open a local terminal.
2. Add an SSH connection with its host, port, username, and authentication method. Press `Ctrl+P` to find and connect to it.
3. Verify the host fingerprint on first connection. For system ssh-agent authentication, start your agent and load keys with `ssh-add` first.
4. Press `Ctrl+Shift+R` in an SSH session to browse, upload, download, or edit remote files.
5. Press `Ctrl+,` to configure themes, fonts, shortcuts, notifications, and terminal behavior.

**Jump hosts:** Enter saved connection names, SSH config aliases, or `user@host:port` in the jump-host chain. Separate multiple hops with commas; use `user@[::1]:22` for IPv6.

**Directory following:** Enable the SFTP option to follow the terminal directory. The remote shell must report paths using OSC 7 or OSC 9;9. Bash, Zsh, and Fish snippets are available in the panel and the [directory-sync guide](docs/remote-directory-sync.md).

**Command history and images:** Choose disabled, shell markers (OSC 133), or input inference in settings. Use the terminal’s command-block button to switch to history. Complex line editing and interactive programs can affect inferred boundaries. iTerm2 images open in a separate preview; sixel renders in the terminal grid. Neither requires command blocks.

**Session recovery:** Restarting restores tabs, splits, and recent text before creating new shell / SSH sessions. Restored history is for viewing; it does not replay commands or restore processes. Alternate screens, images, and manually closed tabs are not restored.

## AI assistant

This section describes the current source. Check the corresponding Release for availability in installers.

Open the AI assistant settings, choose a provider or custom endpoint and protocol, save your API key, and fetch and select models or enter model IDs manually. Presets include OpenAI, Anthropic, DeepSeek, Moonshot, Qwen, and local Ollama. Ollama does not require an API key.

- **Panel and layout:** Press `Ctrl+Shift+K` or click the robot button to open or collapse the panel. It docks on the right by default, supports the left side or above the terminal, and can be resized. Collapsing it keeps requests running.
- **Explain and summarize:** Select terminal text and use the AI button beside the mouse or the context menu to explain commands, troubleshoot, or add the selection to the draft. `Ctrl+Shift+I` prepares an explanation request.
- **Generate commands:** Describe the task and review the response. Eligible single-line commands can be inserted into the terminal for the matching connection without a trailing Enter. Multiline code or code containing control characters is copy-only.
- **Conversation history:** Conversations are saved locally. Browse all conversations or group by connection; click to preview and continue editing, double-click or press Enter to activate, and use the context menu to rename, pin, or delete. Multiple conversations can generate replies simultaneously and show progress in the sidebar.
- **Thinking content:** When the provider returns thinking text or a summary, a section above the answer stays collapsed by default. Expand it to follow updates. The content is saved with the conversation and excluded from subsequent model prompts.
- **Failure diagnosis:** Off by default. When enabled, it analyzes explicitly reported nonzero exits in the active session, including up to the last 6000 characters of that command’s output. Local PowerShell reports exit codes; remote shells need exit markers. The current cmd integration does not report exit codes.
- **Request control:** Streaming responses, activity status, independent cancellation, and retries are supported. Switching terminal tabs keeps requests running. There is no tool executor; users review and execute suggestions themselves.

The Rust backend connects directly to the configured endpoint. API keys are stored in the system credential store separately for each endpoint and protocol. Requests may contain your input, explicitly attached terminal excerpts, and limited conversation history. Automatic diagnosis also sends the failed command, exit code, and limited output, with best-effort credential redaction. Redaction cannot cover every sensitive value. Local AI transcripts are stored without encryption and may contain terminal excerpts. Providers may charge for API usage. See the [AI implementation notes](docs/ai-review.md) for validation scope.

## Keyboard shortcuts

Default bindings can be changed in settings, with wterm, VS Code, and iTerm2 presets available.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+T` | New local tab |
| `Ctrl+Shift+W` | Close the current pane |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Side-by-side / stacked split |
| `Ctrl+P` | Quick connect |
| `Ctrl+K` | Command palette |
| `Ctrl+F` | Search terminal |
| `Ctrl+Shift+R` | Remote files |
| `Ctrl+=` / `Ctrl+-` | Increase / decrease font size (`Ctrl++` also increases it) |
| `Ctrl+,` | Preferences |
| `Ctrl+Shift+I` | Explain the selection with AI |
| `Ctrl+Shift+K` | Open AI assistant |

See [`src/shortcuts.ts`](src/shortcuts.ts) for the full action list.

## Configuration and data

The default Windows configuration directory is `%APPDATA%\wterm\`. On macOS / Linux, wterm uses the system configuration directory with a `wterm/` subdirectory.

| File or storage | Purpose |
| --- | --- |
| `settings.json` | Appearance, terminal behavior, notifications, shortcuts, favorites, and AI preferences. |
| `settings-location.json` | Location of a custom settings file. |
| `profiles.json` | SSH connections, groups, tags, and authentication configuration; excludes saved passwords and key passphrases. |
| `ai-history.sqlite3` | Local AI conversations, drafts, and attached context in the current source. |
| System credential store | SSH passwords, key passphrases, and AI API keys. |
| WebView local storage | Window layouts, recent terminal text, and other runtime state. |

Change the absolute path of `settings.json` in the configuration-file section of general settings. Switching writes current preferences and preserves the old file; it does not move SSH profiles or AI history. Restart after manual settings edits. Legacy preferences are migrated on first launch.

Review host addresses, login scripts, and conversation content before sharing files. Secrets in the system credential store do not migrate with configuration files.

## Development

### Prerequisites

- Git, Node.js 22 or later, and npm.
- Rust 1.89 or later and Cargo.
- Windows: MSVC toolchain, Visual Studio C++ Build Tools, WebView2, and a Windows SDK containing `MakeAppx.exe`. Desktop development startup also builds the Explorer extension.
- macOS / Linux: install the appropriate system dependencies from the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Run the desktop app

```bash
git clone https://github.com/wushuang3625/wterm.git
cd wterm
npm ci
npm run tauri -- dev
```

This starts Vite and the desktop app. `npm run dev:web` starts only the frontend server. Full terminal, SSH, SFTP, and AI functionality requires the Tauri backend.

### Build installers

```bash
npm run tauri -- build
```

Tauri runs the frontend build and preparation scripts automatically. Default packages are written to `src-tauri/target/release/bundle/`. To build only NSIS on Windows:

```bash
npm run tauri -- build --bundles nsis
```

See the [Explorer guide](docs/windows-explorer.md) for identity-package signing and registration.

### Checks and tests

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build:web
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:ui
```

The current UI test configuration uses Microsoft Edge (`msedge`) and starts Vite automatically. Browser tests mock desktop interfaces; some SSH and AI tests use local protocol servers. These do not replace validation against real servers, providers, or target operating systems.

### Repository structure

```text
wterm/
├── src/                    # TypeScript UI, terminals, SSH/SFTP, and AI interaction
├── src-tauri/
│   ├── src/                # Rust PTY, SSH, SFTP, credentials, AI, and history storage
│   ├── shell-extension/    # Native Windows Explorer extension
│   ├── windows/            # Identity package, registration, and installer hooks
│   └── tauri.conf.json     # Application and build configuration
├── scripts/                # Desktop build and Explorer packaging scripts
├── tests/                  # Unit tests and Playwright UI tests
├── docs/                   # Feature status, guides, and release notes
└── package.json            # npm dependencies and scripts
```

### Troubleshooting

- **Blank development window:** Debug builds load `http://localhost:1420`. Start with `npm run tauri -- dev`, or start Vite before launching the debug executable directly. Production builds embed frontend assets.
- **Shortcuts do not respond:** Check the current preset, input focus, and system input-method shortcuts. Windows debug logs are normally written to `%TEMP%\wterm-debug.log`.
- **SFTP does not follow the directory:** Ensure the remote shell reports path markers. Test outside tmux / screen first; see the [directory-sync guide](docs/remote-directory-sync.md).
- **Native Windows ssh reports `getsockname`:** If ControlMaster is enabled, try `ssh -o ControlMaster=no -o ControlPath=none -o ControlPersist=no <host>`. wterm’s built-in SSH channel reuse does not depend on these options.

## Known limitations

- SSH config does not expand `Include`, `Match`, or wildcard `Host` defaults, and does not execute `ProxyCommand`. PuTTY import is not implemented.
- ssh-agent does not support certificate identities, Pageant, or agent forwarding. Port forwarding and Mosh are not implemented.
- SFTP does not support recursive directory transfers, archive operations, dragging files out to the system file manager, or resuming across disconnects / restarts. Pausing continues only within the current connection. Retrying starts over; partial destination files may remain.
- WebDAV / Gist sync, theme imports, Workspace combinations, and session migration between windows are not implemented.
- AI has no tool executor; real-provider validation and formal release remain pending. JumpServer, system agents, different SFTP servers, and Explorer integration need target-environment validation.

## Contributing

Report bugs and suggest features through [Issues](https://github.com/wushuang3625/wterm/issues), or submit improvements through a Pull Request.

Include the application version, operating system, reproduction steps, expected and actual behavior, and sanitized logs in bug reports. Run checks relevant to your changes, describe the results, and update documentation when behavior changes.

## License

The repository does not currently include a standalone `LICENSE` file. MIT / Apache-2.0 appear as candidates in the feature plan, not as an adopted project license. The maintainer still needs to specify the licensing terms.
