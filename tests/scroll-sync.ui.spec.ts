import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('wheel reaches the real bottom across output refreshes and resumes live following', async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/bootstrap.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab .connected')).toHaveCount(1);
  const results = await page.evaluate(async () => {
    const { createTerminal, paneDimensions } = await import('/src/terminal.ts');
    const pane = document.createElement('div');
    pane.className = 'term-pane active';
    pane.style.cssText = 'position:fixed;inset:0;z-index:99';
    document.body.append(pane);
    const { term } = createTerminal(pane);
    const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    await frame();
    const dims = paneDimensions(pane, term);
    term.resize(dims.cols, dims.rows);
    await new Promise<void>(r => term.write(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n', r));
    await frame(); await frame();
    const viewport = term.element!.querySelector('.xterm-viewport') as HTMLElement;
    const read = () => ({ y: term.buffer.active.viewportY, base: term.buffer.active.baseY, top: viewport.scrollTop, max: viewport.scrollHeight - viewport.clientHeight });
    const wheel = (deltaY: number) => term.element!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
    const write = (text: string) => new Promise<void>(r => term.write(text, r));
    const failures: { cycle: number; position: ReturnType<typeof read> }[] = [];
    for (let i = 0; i < 20; i++) {
      // Leave a partial row in the DOM, as pixel-based wheels/touchpads do.
      wheel(-147);
      await frame(); await frame();
      await write('ongoing output\r\n');
      // Output aligns scrollTop on this frame. Scroll again before its native
      // scroll event is delivered: xterm may coalesce and ignore both events.
      await frame();
      wheel(100000);
      await frame(); await frame();
      wheel(100000);
      await frame(); await frame();
      const position = read();
      if (position.y !== position.base) failures.push({ cycle: i, position });
    }
    await write('following output\r\n');
    await frame(); await frame();
    const following = read();
    wheel(-147);
    await frame(); await frame();
    const historyY = term.buffer.active.viewportY;
    await write('output while reading history\r\n');
    await frame(); await frame();
    const history = read();
    await write('\x1b[?1049h');
    wheel(100000);
    await frame(); await frame();
    const alternate = { type: term.buffer.active.type, y: term.buffer.active.viewportY, base: term.buffer.active.baseY };
    term.dispose(); pane.remove();
    return { failures, following, historyY, history, alternate };
  });
  expect(results.failures).toEqual([]);
  expect(results.following.y).toBe(results.following.base);
  expect(Math.abs(results.following.top - results.following.max)).toBeLessThanOrEqual(1);
  expect(results.history.y).toBe(results.historyY);
  expect(results.history.y).toBeLessThan(results.history.base);
  expect(results.alternate).toEqual({ type: 'alternate', y: 0, base: 0 });
});
