// Saves a full-page screenshot of a URL (used for the Grafana dashboard under load and the admin UI).
//   node scripts/screenshot.mjs <url> <out.png> [width] [height] [wait ms]
import { chromium } from '@playwright/test';

const [url, out, width = '1600', height = '1500', wait = '4000'] = process.argv.slice(2);
if (!url || !out) throw new Error('usage: screenshot.mjs <url> <out.png> [width] [height] [wait ms]');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`saved ${out}`);
