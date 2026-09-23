import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const output = await build({ entryPoints: ['src/transfer-queue.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { TransferQueue } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (name, sid = 'one') => ({ sid, name, direction: 'upload', local: '/local/' + name, remote: '/remote/' + name, overwrite: false });
function fixture() {
  const running = new Map(), controls = [];
  const queue = new TransferQueue({
    run(task) { return new Promise((resolve, reject) => running.set(task.id, { resolve, reject })); },
    async control(task, action) { controls.push([task.id, action]); if (action === 'cancel') running.get(task.id).reject(Error('传输已取消')); },
  }, () => {});
  const progress = task => queue.progress({ id: task.id, sid: task.sid, done: 1, total: 100, speed: 12 });
  return { queue, running, controls, progress };
}
test('bounded concurrency preserves destinations and serializes duplicate paths', async () => {
  const { queue, running } = fixture();
  const first = queue.add(input('a')), duplicate = queue.add(input('a')), other = queue.add(input('b', 'two'));
  assert.equal(running.size, 2);
  assert.equal(duplicate.status, 'queued');
  assert.equal(other.sid, 'two');
  running.get(first.id).resolve(100); await tick();
  assert.equal(duplicate.status, 'starting');
  assert.equal(duplicate.remote, '/remote/a');
});
test('pause, resume, cancellation and retry preserve state and use a new transfer id', async () => {
  const { queue, running, controls, progress } = fixture();
  const task = queue.add(input('a')); progress(task);
  await queue.control(task.id, 'pause'); assert.equal(task.status, 'paused');
  progress(task); assert.equal(task.status, 'paused');
  await queue.control(task.id, 'resume'); assert.equal(task.status, 'running');
  await queue.control(task.id, 'cancel'); await tick(); assert.equal(task.status, 'cancelled');
  const retry = queue.retry(task.id); assert.notEqual(retry.id, task.id); assert.equal(retry.overwrite, true); assert.equal(retry.error, undefined);
  running.get(retry.id).resolve(100); await tick(); assert.equal(retry.status, 'completed');
  assert.equal(controls.length, 3);
});
test('cancelling a session prevents its waiting transfers from starting', async () => {
  const { queue, running, progress } = fixture();
  const a = queue.add(input('a')), b = queue.add(input('b')), c = queue.add(input('c'));
  progress(a); progress(b); queue.cancelSession('one'); await tick();
  assert.equal(c.status, 'cancelled'); assert.equal(running.has(c.id), false);
  queue.progress({ id: a.id, sid: 'other', done: 999, total: 999, speed: 0 });
  assert.equal(a.done, 1);
});
test('completion wins against a delayed control acknowledgement', async () => {
  let finish, acknowledge;
  const queue = new TransferQueue({ run: () => new Promise(resolve => { finish = resolve; }), control: () => new Promise(resolve => { acknowledge = resolve; }) }, () => {});
  const task = queue.add(input('a'));
  queue.progress({ id: task.id, sid: task.sid, done: 0, total: 100, speed: 0 });
  const pending = queue.control(task.id, 'pause'); finish(100); await tick(); acknowledge(); await pending;
  assert.equal(task.status, 'completed');
});
