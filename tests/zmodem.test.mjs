import { build } from 'esbuild';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const Zmodem = createRequire(import.meta.url)('zmodem.js/src/zmodem');
const output = await build({
  entryPoints: ['src/zmodem.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'mocks', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, args => ({ path: args.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path.endsWith('core')
      ? 'export const invoke = (...args) => globalThis.mockInvoke(...args);'
      : 'export const open = (...args) => globalThis.mockOpen(...args); export const save = (...args) => globalThis.mockSave(...args);' }));
  }}],
});
const { createZmodemHandler } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(r => setTimeout(r, 10));
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await tick(); }
  assert.fail('protocol did not complete within 2 seconds');
}
function terminal() {
  const output = [];
  return { output, write: (x, done) => { output.push(x); done?.(); }, writeln: x => output.push(x), focus() {} };
}
const header = new TextEncoder().encode('**\x18B0100000023be50\r\n\x11');
test('split header opens once; cancellation restores input even while dialog remains open', async t => {
  let dialogs = 0, resolve, pointerRestores = 0;
  globalThis.mockOpen = () => { dialogs++; return new Promise(r => { resolve = r; }); };
  const sent = [], term = terminal();
  const handler = createZmodemHandler(term, x => sent.push(x), { restorePointer: () => pointerRestores++ });
  t.after(() => handler.dispose());
  handler.consume(header.slice(0, 8));
  handler.consume(header.slice(8));
  await tick();
  assert.equal(dialogs, 1);
  assert.ok(pointerRestores > 0, 'restore native mouse BEFORE dialog closes');
  handler.cancel();
  assert.equal(handler.isActive(), false, 'dialog promise must not keep keyboard locked');
  handler.consume(header);
  await tick();
  assert.equal(dialogs, 1);
  resolve(null);
  await tick();
  assert.ok(sent.flat().includes(24));
  assert.ok(sent.flat().includes(3));
  assert.ok(term.output.includes('\x1b[?25h'));
});
test('dialog failure and idle timeout release keyboard and allow a new rz', async t => {
  globalThis.mockOpen = () => Promise.reject(new Error('dialog failed'));
  const handler = createZmodemHandler(terminal(), () => {}, { idleTimeoutMs: 30 });
  t.after(() => handler.dispose());
  handler.consume(header);
  await tick();
  assert.equal(handler.isActive(), false);
  globalThis.mockOpen = () => new Promise(() => {});
  handler.consume(header);
  await until(() => !handler.isActive());
});
test('real rz peer receives full binary file; finishing returns control to terminal', async t => {
  const bytes = Uint8Array.from({ length: 24000 }, (_, n) => n % 256);
  globalThis.mockOpen = async () => 'C:/fixture.bin';
  globalThis.mockInvoke = async command => { assert.equal(command, 'read_local_binary_file'); return Array.from(bytes); };
  const peer = new Zmodem.Session.Receive();
  let received;
  const errors = [];
  const handler = createZmodemHandler(terminal(), data => setImmediate(() => {
    try { peer.consume(data); } catch (e) { if (!peer.aborted()) errors.push(e); }
  }));
  t.after(() => handler.dispose());
  peer.set_sender(data => setImmediate(() => handler.consume(new Uint8Array(data))));
  peer.on('offer', file => { file.accept().then(chunks => { received = Buffer.concat(chunks.map(c => Buffer.from(c))); }); });
  peer.start();
  await until(() => received && !handler.isActive());
  assert.deepEqual(errors, []);
  assert.deepEqual(received, Buffer.from(bytes));
});
test('peer abort while waiting for file acknowledgement releases input immediately', async t => {
  globalThis.mockOpen = async () => 'C:/fixture.bin';
  globalThis.mockInvoke = async () => [1, 2, 3];
  const peer = new Zmodem.Session.Receive();
  let aborted = false;
  const handler = createZmodemHandler(terminal(), data => setImmediate(() => {
    try { if (!aborted) peer.consume(data); } catch {}
  }));
  t.after(() => handler.dispose());
  peer.set_sender(data => setImmediate(() => handler.consume(new Uint8Array(data))));
  peer.on('offer', () => { aborted = true; peer.abort(); });
  peer.start();
  await until(() => aborted && !handler.isActive());
});
test('real sz peer saves exact binary bytes', async t => {
  const bytes = [0, 1, 24, 255, 13, 10, 42];
  globalThis.mockSave = async () => 'C:/download.bin';
  let saved, completed = false;
  globalThis.mockInvoke = async (command, args) => { assert.equal(command, 'write_local_binary_file'); saved = args.data; };
  let handler;
  const peer = new Zmodem.Sentry({
    to_terminal() {}, on_retract() {},
    sender: data => setImmediate(() => handler.consume(new Uint8Array(data))),
    on_detect: detection => {
      const session = detection.confirm();
      void (async () => {
        const file = await session.send_offer({ name: 'fixture.bin', size: bytes.length });
        await file.end(bytes);
        await session.close();
        completed = true;
      })();
    },
  });
  handler = createZmodemHandler(terminal(), data => setImmediate(() => peer.consume(data)));
  t.after(() => handler.dispose());
  handler.consume(new TextEncoder().encode('**\x18B00000000000000\r\n\x11'));
  await until(() => saved && completed && !handler.isActive());
  assert.deepEqual(saved, bytes);
});
