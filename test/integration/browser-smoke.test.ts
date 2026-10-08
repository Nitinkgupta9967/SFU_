import { chromium, type Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';

let browser: Browser | undefined;
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await closeServer?.();
  closeServer = undefined;
});

describe('browser smoke', () => {
  it('loads the demo and allows two clients to join the same room', async () => {
    const { url } = await startServer();
    browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox']
    });

    const a = await browser.newPage();
    const b = await browser.newPage();
    const logs: string[] = [];
    for (const page of [a, b]) {
      page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    }
    await a.goto(`${url}/demo`);
    await b.goto(`${url}/demo`);

    await a.locator('#room').fill('itest');
    await a.locator('#name').fill('Alice');
    await b.locator('#room').fill('itest');
    await b.locator('#name').fill('Bob');

    await a.locator('#join').click();
    await b.locator('#join').click();

    await a.locator('#camera:not([disabled])').waitFor({ timeout: 10_000 });
    await b.locator('#camera:not([disabled])').waitFor({ timeout: 10_000 });

    await a.locator('#camera').click();
    try {
      await b.locator('.tile').filter({ hasText: /p_/ }).waitFor({ timeout: 20_000 });
    } catch (error) {
      const state = {
        aTiles: await a.locator('.tile').allTextContents(),
        bTiles: await b.locator('.tile').allTextContents(),
        room: await (await fetch(`${url}/api/rooms/itest`)).json(),
        bDebug: await b.evaluate(() => (window as any).__miniSfuDebug ?? []),
        logs
      };
      throw new Error(`${(error as Error).message}\n${JSON.stringify(state, null, 2)}`);
    }
  }, 30_000);
});

async function startServer(): Promise<{ url: string }> {
  const { app } = await createApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  closeServer = () => app.close();
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return { url: `http://127.0.0.1:${address.port}` };
}

function testConfig(): AppConfig {
  return {
    port: 0,
    rtcPortRange: { min: 41000, max: 41100 },
    iceServers: [],
    maxPeersPerRoom: 4,
    emptyRoomTtlMs: 30_000,
    authMode: 'none',
    pliThrottleMs: 0,
    negotiationDebounceMs: 0,
    reconnectGraceMs: 10_000,
    speakerThreshold: 50,
    packetCacheSize: 8,
    lastNVideo: 0,
    rateLimitPerSec: 50,
    logLevel: 'silent'
  };
}
