import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  const html = (await readFile('index.html', 'utf8')).replace('/src/main.ts', '/tests/ui-harness.js');
  await page.route('http://127.0.0.1:1420/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('/');
  await expect(page.locator('.tab .connected')).toHaveCount(1);
});

test('scrollbar appears with scrollback, drags, and track click scrolls', async ({ page }) => {
  const pane = page.locator('.term-pane:visible');
  const track = pane.locator('.term-scrollbar');

  // 无滚动缓冲时滚动条隐藏
  await expect(track).toHaveCount(1);
  await expect(track).toHaveClass(/hidden/);

  // 输出 200 行制造滚动缓冲
  await page.evaluate(async () => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n';
    await (window as any).emitPty(sid, text);
  });
  await expect(track).not.toHaveClass(/hidden/);

  const viewportTop = () => pane.evaluate(() =>
    (document.querySelector('.term-pane.active .xterm-viewport') as HTMLElement).scrollTop);

  // 输出后滚到底部
  const maxScroll = await pane.evaluate(() => {
    const vp = document.querySelector('.term-pane.active .xterm-viewport') as HTMLElement;
    return vp.scrollHeight - vp.clientHeight;
  });
  expect(maxScroll).toBeGreaterThan(1000);
  expect(await viewportTop()).toBe(maxScroll);

  // 拖拽滑块到轨道顶部 → 滚到最旧
  const thumb = track.locator('.term-scrollbar-thumb');
  const trackBox = await track.boundingBox();
  const thumbBox = await thumb.boundingBox();
  expect(trackBox).toBeTruthy();
  expect(thumbBox).toBeTruthy();

  await thumb.dispatchEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 1,
    clientX: thumbBox!.x + 3, clientY: thumbBox!.y + 5,
    button: 0, buttons: 1,
  });
  await page.evaluate(([tx, ty]) => {
    (document.querySelector('.term-scrollbar') as HTMLElement).dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: tx, clientY: ty, button: 0, buttons: 1,
    }));
  }, [trackBox!.x + 3, trackBox!.y + 2]);
  await page.waitForTimeout(200); // smoothScrollDuration: 100ms
  await page.evaluate(() => {
    (document.querySelector('.term-scrollbar') as HTMLElement).dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
    }));
  });
  expect(await viewportTop()).toBe(0);

  // 点击轨道底部 → 滚到最新
  await track.dispatchEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 1,
    clientX: trackBox!.x + 5, clientY: trackBox!.y + trackBox!.height - 3,
    button: 0, buttons: 1,
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    (document.querySelector('.term-scrollbar') as HTMLElement).dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
    }));
  });
  expect(await viewportTop()).toBe(maxScroll);
});

test('scrollbar thumb moves with viewport scroll and stays draggable during ongoing output', async ({ page }) => {
  const pane = page.locator('.term-pane:visible');
  const track = pane.locator('.term-scrollbar');
  const thumb = track.locator('.term-scrollbar-thumb');

  // 输出 200 行制造滚动缓冲
  await page.evaluate(async () => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n';
    await (window as any).emitPty(sid, text);
  });
  await expect(track).not.toHaveClass(/hidden/);

  // 1. 测试“屏幕在动，滚动条跟着走”：模拟鼠标滚轮/viewport 滚动
  const getThumbY = () => thumb.evaluate(el => {
    const match = el.style.transform.match(/translateY\((\d+)px\)/);
    return match ? Number(match[1]) : 0;
  });

  const bottomY = await getThumbY();
  expect(bottomY).toBeGreaterThan(0);

  // 将 viewport 向上滚动一半
  await page.evaluate(() => {
    const vp = document.querySelector('.term-pane.active .xterm-viewport') as HTMLElement;
    vp.scrollTop = Math.round((vp.scrollHeight - vp.clientHeight) / 2);
    vp.dispatchEvent(new Event('scroll'));
  });

  await expect.poll(async () => await getThumbY()).toBeLessThan(bottomY);
  const midY = await getThumbY();
  expect(midY).toBeGreaterThan(0);

  // 2. 测试“屏幕在持续输出（屏幕在动）时，滚动条可拖动，不卡顿”
  // 持续产生输出
  await page.evaluate(() => {
    const sid = (window as any).__wtermSessionPrefix + '-s1';
    (window as any).__outputInterval = setInterval(() => {
      void (window as any).emitPty(sid, 'streaming output line\r\n');
    }, 50);
  });

  // 拖拽滑块到顶部
  const trackBox = await track.boundingBox();
  const thumbBox = await thumb.boundingBox();
  expect(trackBox).toBeTruthy();
  expect(thumbBox).toBeTruthy();

  await thumb.dispatchEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 1,
    clientX: thumbBox!.x + 3, clientY: thumbBox!.y + 5,
    button: 0, buttons: 1,
  });

  // 移至顶部
  await page.evaluate(([tx, ty]) => {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: tx, clientY: ty, button: 0, buttons: 1,
    }));
  }, [trackBox!.x + 3, trackBox!.y + 2]);

  // 停止持续输出
  await page.evaluate(() => {
    clearInterval((window as any).__outputInterval);
  });

  // 验证滑块处于顶部
  expect(await getThumbY()).toBe(0);

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, button: 0,
    }));
  });

  // 验证终端 viewport 也确实滚动到了最顶部
  const viewportTop = await pane.evaluate(() =>
    (document.querySelector('.term-pane.active .xterm-viewport') as HTMLElement).scrollTop
  );
  expect(viewportTop).toBe(0);
});

