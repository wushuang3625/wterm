(() => {
  'use strict';
  const root = document.documentElement;
  const nodes = [...document.querySelectorAll('[data-i18n]')];
  const chinese = Object.fromEntries(nodes.map(node => [node.dataset.i18n, node.innerHTML]));
  const english = {
    skip:'Skip to content',navFeatures:'Features',navWorkflow:'Workflow',navDownload:'Get started',eyebrow:'MADE FOR EVERYDAY CONNECTIONS',
    heroTitle:'A clear space<br>for every <em>connection.</em>',
    heroDescription:'Connect to servers, manage files, and make sense of commands and output. Local terminals, SSH, SFTP, and an optional AI assistant, together in one desktop workspace.',
    downloadWindows:'Download for Windows',viewSource:'Explore the source ↗',versionNote:'Source v0.1.6 · Installer features follow GitHub Releases',
    illustration:'Interactive illustration',aiTab:'AI assistant',workspace:'WORKSPACE',fileName:'Name',fileSize:'Size',filePermissions:'Permissions',
    transferComplete:'Downloaded · Open file or location',conversations:'CHATS',explainJump:'Explain jump hosts',reviewOutput:'Understand output',diagnoseIssue:'Connection issues',
    aiQuestion:'What does ssh -J do?',thinking:'Thinking content',thinkingNote:'When a provider returns thinking text or a summary, you can expand it here.',
    aiAnswer:'Connect through a jump host before reaching the destination. Useful for servers behind a bastion host.',aiControl:'You review and execute the command.',composer:'Ask a question, or attach selected terminal text…',
    demoStatus:'Illustration · No live server connection',previewCaption:'One workspace. Three perspectives.',previewHint:'Switch tabs to explore ↗',foundation:'Familiar foundations. A focused desktop.',
    featuresTitle:'Each tool in its place.<br>Your work in one flow.',featuresDescription:'From local development to remote troubleshooting, keep connections, files, and context in the same workspace.',
    connectionsTitle:'Connections, in order',connectionsText:'Arrange local shells and remote sessions with tabs and splits. Organize saved connections into groups.',
    connectionsOne:'Multi-hop ProxyJump and SSH channel reuse',connectionsTwo:'System ssh-agent, keys, and multi-round MFA',connectionsThree:'Host-key confirmation and connection history',
    filesTitle:'Files, within reach',filesText:'Browse, edit, and transfer remote files in an SFTP panel alongside the session you are working in.',
    filesOne:'Upload, download, and edit remote files',filesTwo:'Transfer queues, pause, continue, and retry',filesThree:'Open downloaded files or their location',
    aiTitle:'AI, when you need it',aiText:'Bring selected text into a conversation to explain a command, summarize output, or investigate an issue.',
    aiOne:'Your provider, your model, your API key',aiTwo:'Local chat history, grouped by connection',aiThree:'Concurrent chats and collapsible thinking',aiAvailability:'See source features and release availability ↗',
    workflowTitle:'Keep your context.<br><em>Carry on from here.</em>',workflowText:'Reopen your workspace with tabs, splits, and recent terminal text. Bring up command history and the AI assistant when you need them.',historyNote:'Restores layouts and text, without replaying commands or restoring old processes.',
    stepConnect:'Find your next destination',stepConnectText:'Search saved connections, or open a local terminal.',stepFiles:'Keep your files close',stepFilesText:'Open remote files beside the current SSH session.',stepAi:'Ask when you need a second look',stepAiText:'Expand the assistant, keep the conversation, and return to the terminal.',
    downloadTitle:'Start with your next connection.',downloadText:'Get the published Windows installer, or explore the source.',downloadRelease:'Get the latest release',buildSource:'Build from source ↗',
    releaseNote:'Windows x64 NSIS is recommended. Current source is v0.1.6; installer capabilities follow the corresponding Release.',cloneLabel:'Bring the source home',copy:'Copy command',sourceFactOne:'Local shells + SSH + SFTP',sourceFactTwo:'Optional AI · Bring your own key',
    faqTitle:'Before you connect.',platformQuestion:'Which platforms are supported?',platformAnswer:'Locally validated Windows x64 installers are available and require Microsoft Edge WebView2. Check Releases for packages and validation on other platforms. The source includes macOS and Linux adaptations.',
    privacyQuestion:'How does the AI assistant use my content?',privacyAnswer:'AI is optional. Requests send your question, explicitly attached excerpts, and limited conversation history to your configured provider. Automatic failure diagnosis is off by default. API keys use the system credential store; local chat history is unencrypted. Providers may charge for API usage.',
    scopeQuestion:'Can AI execute commands directly?',scopeAnswer:'You review suggestions and decide what to execute. Eligible single-line commands can be inserted into a terminal with a matching connection, without pressing Enter. Tool execution, AI-created splits, and external MCP access remain planned.',
    installQuestion:'Anything to know before installing?',installAnswer:'Current installers are unsigned. The Windows 11 Explorer context menu also has package-identity registration requirements. Registration failure does not prevent the main app from working. See the corresponding release notes for installation details and limitations.',
    footerNote:'A little more focus for every connection.',feedback:'Report an issue ↗'
  };
  const readPreference = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const writePreference = (name, value) => { try { localStorage.setItem(name, value); } catch { /* Preferences are optional. */ } };
  let language = 'zh';
  const languageButton = document.querySelector('.language-button');
  const themeButton = document.querySelector('.theme-button');
  const updateLabels = () => {
    const en = language === 'en';
    languageButton.textContent = en ? '中文' : 'EN';
    languageButton.setAttribute('aria-label', en ? 'Switch to Chinese' : '切换到英文');
    const dark = root.dataset.theme === 'dark';
    themeButton.setAttribute('aria-label', en ? `Switch to ${dark ? 'light' : 'dark'} theme` : `切换到${dark ? '浅色' : '深色'}主题`);
    themeButton.setAttribute('aria-pressed', String(dark));
    const labels = en ? {nav:'Main navigation',preview:'Workspace preview',connections:'Illustrative connections',footerNav:'More links'} : {nav:'主导航',preview:'工作台界面',connections:'演示连接',footerNav:'更多链接'};
    for (const [key, value] of Object.entries(labels)) document.querySelector(`[data-label="${key}"]`)?.setAttribute('aria-label', value);
  };
  const setLanguage = (next, updateUrl = false) => {
    language = next === 'en' ? 'en' : 'zh';
    root.lang = language === 'en' ? 'en' : 'zh-CN';
    const dictionary = language === 'en' ? english : chinese;
    for (const node of nodes) node.innerHTML = dictionary[node.dataset.i18n] ?? chinese[node.dataset.i18n];
    document.title = language === 'en' ? 'wterm — A clear space for every connection' : 'wterm — 本地与远端，尽在一个工作台';
    document.querySelector('meta[name="description"]').content = language === 'en' ? 'Local terminals, SSH, SFTP, and an optional AI assistant in one focused desktop workspace. Built with Tauri, Rust, TypeScript, and xterm.js.' : 'wterm 将本地终端、SSH、SFTP 与可选 AI 助手整合在一个桌面工作台。连接服务器、管理文件，保持工作的上下文。';
    document.querySelector('[data-source-link]').href = language === 'en' ? 'https://github.com/wushuang3625/wterm#development' : 'https://github.com/wushuang3625/wterm/blob/main/README.zh-CN.md#从源码运行';
    document.querySelector('.copy-status').textContent = '';
    writePreference('wterm-site-language', language);
    if (updateUrl) { const url = new URL(location.href); url.searchParams.set('lang', language); history.replaceState(null, '', url); }
    updateLabels();
  };
  const setTheme = theme => {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = root.dataset.theme === 'dark' ? '#1c2420' : '#f5f4ef';
    writePreference('wterm-site-theme', root.dataset.theme);
    updateLabels();
  };
  languageButton.addEventListener('click', () => setLanguage(language === 'en' ? 'zh' : 'en', true));
  themeButton.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const selectTab = tab => {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
    }
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const destination = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (destination < 0) return;
      event.preventDefault(); selectTab(tabs[destination]); tabs[destination].focus();
    });
  }
  document.querySelector('.copy-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    const status = document.querySelector('.copy-status');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(document.getElementById('clone-command').textContent.trim());
      status.textContent = language === 'en' ? 'Copied' : '已复制';
    } catch {
      status.textContent = language === 'en' ? 'Select the command to copy manually.' : '请选中命令手动复制。';
    } finally { button.disabled = false; }
  });
  const queryLanguage = new URLSearchParams(location.search).get('lang');
  setLanguage(queryLanguage === 'en' || queryLanguage === 'zh' ? queryLanguage : readPreference('wterm-site-language'));
  setTheme(readPreference('wterm-site-theme'));
})();
