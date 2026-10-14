import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const output = await build({ entryPoints: ['src/ai-history.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'history-ipc', setup(build) {
  build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const invoke = (...args) => globalThis.historyInvoke(...args);', loader: 'js' }));
} }] });
const { AiHistoryStore, connectionForProfile, newConversation, completedTurns } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
globalThis.window = { setTimeout, clearTimeout };
const connection = connectionForProfile(null, true);
const message = (role, content, status = 'complete') => ({ id: crypto.randomUUID(), role, content, status, context: '', createdAt: Date.now(), action: 'chat', model: 'm', provider: 'p', error: '' });

test('profile rename preserves grouping; host, account and jump changes alter insertion target', () => {
  const profile = { id: 'stable', name: 'old', host: '[HOST]', port: 22, username: 'root', proxy_jump: 'jump' };
  const old = connectionForProfile(profile);
  assert.equal(connectionForProfile({ ...profile, name: 'new' }).id, old.id);
  assert.equal(connectionForProfile({ ...profile, host: 'host' }).targetKey, old.targetKey);
  for (const changed of [{ host: 'other' }, { username: 'admin' }, { port: 2222 }, { proxy_jump: 'different' }]) {
    assert.notEqual(connectionForProfile({ ...profile, ...changed }).targetKey, old.targetKey);
  }
  assert.notEqual(connectionForProfile({ ...profile, id: 'another' }).id, old.id);
});

test('all transcript messages survive while failed and interrupted turns stay out of model context', () => {
  const conversation = newConversation(connection);
  for (let i = 0; i < 20; i++) conversation.messages.push(message('user', String(i)), message('assistant', 'answer ' + i));
  const withContext = message('user', 'question'); withContext.context = 'terminal snippet';
  conversation.messages.push(withContext, message('assistant', 'good'), message('user', 'stopped'), message('assistant', 'partial', 'interrupted'), message('user', 'failed'), message('assistant', '', 'error'));
  const turns = completedTurns(conversation);
  assert.equal(conversation.messages.length, 46);
  assert.equal(turns.length, 42);
  assert.equal(turns.at(-2).content, 'question\n\nterminal snippet');
  assert.ok(!turns.some(value => value.content === 'partial' || value.content === 'stopped'));
});

test('saved reasoning stays out of subsequent model requests', () => {
  const conversation = newConversation(connection);
  const answer = message('assistant', 'final answer'); answer.reasoning = 'PROVIDER_REASONING_ONLY';
  conversation.messages.push(message('user', 'question'), answer);
  const turns = completedTurns(conversation);
  assert.deepEqual(turns, [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'final answer' }]);
  assert.ok(!JSON.stringify(turns).includes('PROVIDER_REASONING_ONLY'));
  assert.equal(conversation.messages[1].reasoning, 'PROVIDER_REASONING_ONLY');
});

test('queued streaming saves use fresh snapshots and the revision from the preceding save', async () => {
  const snapshots = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  globalThis.historyInvoke = async (command, args) => {
    assert.equal(command, 'ai_history_save'); snapshots.push(structuredClone(args.conversation));
    if (snapshots.length === 1) await first;
    return args.conversation.revision + 1;
  };
  const store = new AiHistoryStore(() => {}, error => { throw error; });
  const conversation = store.create(connection);
  conversation.messages.push(message('user', 'hello'), message('assistant', '半段', 'generating'));
  store.touch(conversation); const flushed = store.flush();
  conversation.messages[1].content += '中文回复'; conversation.messages[1].status = 'complete';
  store.touch(conversation); release(); await flushed;
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].messages[1].content, '半段');
  assert.equal(snapshots[1].messages[1].content, '半段中文回复');
  assert.deepEqual(snapshots.map(value => value.revision), [0, 1]); assert.equal(conversation.revision, 2);
});

test('a failed write retains the transcript and retry persists its latest draft', async () => {
  let fail = true; let saved;
  globalThis.historyInvoke = async (_command, args) => { if (fail) throw new Error('disk failure'); saved = args.conversation; return 1; };
  const errors = []; const store = new AiHistoryStore(() => {}, error => errors.push(error));
  const conversation = store.create(connection); conversation.messages.push(message('user', 'important'));
  store.touch(conversation); await store.flush();
  assert.equal(errors.length, 1); assert.equal(store.cache.get(conversation.id).messages[0].content, 'important');
  conversation.draft = 'next question'; fail = false; store.retry(); await store.flush();
  assert.equal(saved.draft, 'next question'); assert.equal(conversation.revision, 1);
});
