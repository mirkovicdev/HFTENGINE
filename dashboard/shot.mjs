// Full-resolution screenshots of the dashboard with Playwright's Chromium.
//   node shot.mjs <url> <width> <height> <out.png> [waitMs]
import { chromium } from "playwright";

const [url, w, h, out, wait] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(wait ?? 1500));
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
