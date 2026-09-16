// Keyboard smoke test: press keys, print the resulting URL, save screenshots.
//   node keys.mjs <url> <outdir>
import { chromium } from "playwright";

const [url, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE ERROR:", m.text()); });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const steps = [
  ["3", "focus latency"],
  ["0", "all panels"],
  ["b", "ladder ticks"],
  ["1", "focus book"],
  ["l", "layout toggle"],
  ["0", "all"],
  ["ArrowRight", "seek +5s"],
  ["ArrowUp", "speed x2"],
  ["Space", "play"],
];
for (const [key, what] of steps) {
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  console.log(`${key.padEnd(10)} ${what.padEnd(14)} -> ${page.url().split("?")[1]}`);
  if (key === "1" || key === "l") await page.screenshot({ path: `${out}/key_${key}.png` });
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/key_final.png` });
const status = await page.evaluate(() => document.querySelector(".bar.status")?.textContent);
console.log("status:", status);
await browser.close();
