import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const output = await build({ entryPoints: ['src/ai.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const {
  AI_SYSTEM_PROMPTS, buildMessages, extractCodeBlocks, renderMarkdownLite,
  canInsertCommand, diagnosticContext, redactDiagnostic,
} = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

test('system prompts cover chat, explain and summarize with Chinese output', () => {
  for (const [action, prompt] of Object.entries(AI_SYSTEM_PROMPTS)) {
    assert.ok(prompt.includes('中文'), `${action} asks for Chinese`);
  }
  assert.ok(AI_SYSTEM_PROMPTS.chat.includes('bash') && AI_SYSTEM_PROMPTS.chat.includes('PowerShell'));
  assert.ok(AI_SYSTEM_PROMPTS.explain.includes('解释'));
  assert.ok(AI_SYSTEM_PROMPTS.summarize.includes('总结'));
});

test('multi-turn requests replace old system prompts and cap complete turns', () => {
  const history = [buildMessages('chat', 'one')[0]];
  for (let i = 0; i < 20; i++) history.push({ role: 'user', content: String(i) }, { role: 'assistant', content: 'ok' });
  const messages = buildMessages('explain', 'last', history);
  assert.equal(messages.filter(message => message.role === 'system').length, 1);
  assert.equal(messages[0].content, AI_SYSTEM_PROMPTS.explain);
  assert.equal(messages.length, 14);
  assert.equal(messages[1].content, '14');
  assert.equal(messages.at(-1).content, 'last');
});

test('insertion accepts a single line and rejects shell input control sequences', () => {
  assert.ok(canInsertCommand('Get-ChildItem -Force'));
  for (const command of ['echo a\necho b', 'echo a\r', 'echo\tX', '\x1b[200~ls', '', 'a'.repeat(4097), 'a\u2028b']) {
    assert.equal(canInsertCommand(command), false, JSON.stringify(command.slice(0, 20)));
  }
});

test('diagnostic context masks common credentials before truncating the tail', () => {
  const failure = { command: 'curl -H "Authorization: Bearer hidden-token" https://user:password@example.com', exitCode: 7,
    output: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\npassword="my-password"\napi_key=sk-1234567890\n' + 'x'.repeat(6001) };
  const context = diagnosticContext(failure);
  assert.ok(context.includes('退出码：7'));
  assert.ok(context.includes('最后 6000 字符'));
  assert.ok(!context.includes('hidden-token') && !context.includes('my-password') && !context.includes('private'));
  const secret = redactDiagnostic('token=abc password: "abc def" api_key=sk-1234567890 Bearer secret-token');
  assert.ok(!secret.includes('abc') && !secret.includes('secret-token'));
});

test('buildMessages prepends the action system prompt', () => {
  const messages = buildMessages('explain', 'ls -la');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, AI_SYSTEM_PROMPTS.explain);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'ls -la');
});

test('extractCodeBlocks returns fenced blocks in order without fences', () => {
  const reply = '先安装：\n```bash\nnpm install\n```\n然后运行：\n```powershell\nnpm start\n```\n完成。';
  assert.deepEqual(extractCodeBlocks(reply), ['npm install', 'npm start']);
  assert.deepEqual(extractCodeBlocks('没有代码块'), []);
  assert.deepEqual(extractCodeBlocks('```\nplain\n```'), ['plain']);
});

test('renderMarkdownLite escapes html and isolates code blocks', () => {
  const html = renderMarkdownLite('第一行 <b>粗体</b>\n第二行\n```sh\nrm -rf /\n```');
  assert.ok(html.includes('第一行 &lt;b&gt;粗体&lt;/b&gt;<br/>第二行'), 'text escaped with line breaks');
  assert.ok(!html.includes('<b>'), 'no raw html passes through');
  assert.ok(html.includes('<pre class="ai-code-content"><code>rm -rf /</code></pre>'), 'code block isolated');
});

test('renderMarkdownLite keeps multi-line commands inside one code block', () => {
  const html = renderMarkdownLite('```bash\nfind . -name "*.log" |\n  xargs rm\n```');
  assert.ok(html.includes('find . -name &quot;*.log&quot; |\n  xargs rm'), 'newlines kept, quotes escaped');
  assert.equal(html.match(/<pre/g).length, 1);
});

test('markdown preserves closing-fence prose and does not treat incomplete fences as executable code', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const html = renderMarkdownLite(fence + 'sh\nls\n' + fence + '后续说明 <script>');
  assert.ok(html.includes('<code>ls</code>'));
  assert.ok(html.includes('后续说明 &lt;script&gt;'));
  assert.ok(!renderMarkdownLite(fence + 'sh\nrm').includes('<pre'));
});

test('markdown formats headings, lists, emphasis and inline code without leaking syntax', () => {
  const html = renderMarkdownLite('# 参数说明\n\n**命令与参数解释**\n\n- **`dnf`**：软件包管理器。\n- `--security`：仅更新安全补丁。\n  - *保留版本*\n\n1. 检查更新\n2. 手动确认\n\n> 不会自动执行。');
  assert.ok(html.includes('<h3 class="ai-heading">参数说明</h3>'));
  assert.ok(html.includes('<strong>命令与参数解释</strong>'));
  assert.ok(html.includes('<strong><code class="ai-inline-code">dnf</code></strong>'));
  assert.equal((html.match(/<ul /g) || []).length, 2);
  assert.ok(html.includes('<ol class="ai-list"><li>检查更新</li><li>手动确认</li></ol>'));
  assert.ok(html.includes('<em>保留版本</em>'));
  assert.ok(html.includes('<blockquote class="ai-quote">不会自动执行。</blockquote>'));
  assert.ok(!html.includes('**') && !html.includes('`'));
});

test('markdown treats model HTML and links as text, and keeps code literal', () => {
  const html = renderMarkdownLite('**<img src=x onerror=alert(1)>**\n\n[jump](javascript:alert(1))\n\n```sh\necho "**<script>**"\n```');
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<a '));
  assert.ok(html.includes('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>'));
  assert.ok(html.includes('echo &quot;**&lt;script&gt;**&quot;'));
});
