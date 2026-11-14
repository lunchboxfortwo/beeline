import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { armForwardTiming, readForwardTiming } from './web-forward-timing.mjs';

for (const feedback of [false, true]) test(`forward feedback=${feedback} is recorded before the driver reads it`, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="modal"><div data-testid="forward-room-picker"><button>Forward</button></div></div>',
    );
    await page.evaluate(() => {
      window.WebSocket = class extends EventTarget {
        send() {}
      };
      window.__originalSend = WebSocket.prototype.send;
    });
    await page.evaluate(armForwardTiming);
    await page.evaluate(async (feedback) => {
      window.__latencyStart = performance.now();
      document.querySelector('button').click();
      const socket = new WebSocket();
      socket.send(JSON.stringify({ op: 'sendRoomMessage', id: 'forward' }));
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ id: 'unrelated' }) }),
      );
      if (window.__forwardTiming.events.reply !== undefined)
        throw new Error('Unrelated reply recorded');
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ id: 'forward' }) }),
      );
      const modal = document.querySelector('#modal');
      modal.dispatchEvent(new AnimationEvent('animationstart', { bubbles: true }));
      if (feedback) {
        document.querySelector('button').textContent = 'FORWARDED';
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      modal.dispatchEvent(new AnimationEvent('animationend', { bubbles: true, elapsedTime: 0.25 }));
      document.querySelector('[data-testid="forward-room-picker"]').remove();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }, feedback);
    const first = await page.evaluate(readForwardTiming);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const delayed = await page.evaluate(readForwardTiming);
    assert.deepEqual(delayed, first, 'Driver observation must not move the saved stop time');
    assert.ok(first.dismissalResultMs >= first.removalMs);
    if (feedback) {
      assert.ok(first.acceptedResultMs > 0);
      assert.ok(first.acceptedResultMs < first.animationEndMs);
      assert.ok(first.durationMs < first.removalMs);
    } else {
      assert.equal(first.acceptedResultMs, null);
      assert.ok(first.durationMs >= first.removalMs);
    }
    assert.ok(first.removalMs >= first.dispatchMs);
    assert.equal(first.dispatchMs, 0, 'driver dispatch delay is outside the browser click interval');
    assert.equal(first.configuredAnimationMs, 250);
    assert.ok(
      feedback ? first.animationMs >= 250 : first.animationMs < 250,
      'Observed event span must not be replaced by configured CSS duration',
    );
    assert.equal(first.closeToGoneMs, first.removalMs - first.closeStartMs);
    assert.equal(first.sourceMessageVisibleMs, null);
    assert.equal(
      await page.evaluate(() => WebSocket.prototype.send === window.__originalSend),
      true,
    );
    await page.evaluate(() => {
      window.__forwardTiming.complete = false;
    });
    await assert.rejects(page.evaluate(readForwardTiming), /not observed/);
  } finally {
    await browser.close();
  }
});
