// Screenshot the built dashboard at 1440x900 viewport, JPEG, three shots:
// 1-board (cover), 2-detail (top protocol), 3-filtered (FARM filter, sorted by net).
// Serves the output dir on loopback only; no network. Usage:
//   node tools/shoot.mjs <outDir> <shotDir>
import { chromium } from "../tools/playwright-core/index.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

const outDir = process.argv[2];
const shotDir = process.argv[3];
if (!outDir || !shotDir) { console.error("usage: shoot.mjs <outDir> <shotDir>"); process.exit(2); }
mkdirSync(shotDir, { recursive: true });

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const file = join(outDir, path === "/" ? "dashboard/index.html" : path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const exe = process.env.HOME + "/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const board = JSON.parse(readFileSync(join(outDir, "board.json"), "utf8"));
const topSlug = board.rows[0].slug;

async function shot(name, url, waitFor, scrollTo) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(waitFor, { timeout: 15000 });
  if (scrollTo) await page.evaluate((sel) => { document.querySelector(sel)?.scrollIntoView({ block: "start" }); }, scrollTo);
  await page.waitForTimeout(400);
  let quality = 82;
  for (;;) {
    const buf = await page.screenshot({ type: "jpeg", quality });
    if (buf.length <= 512 * 1024 || quality <= 55) {
      writeFileSync(join(shotDir, name), buf);
      console.log(name, buf.length + " bytes, quality " + quality);
      return;
    }
    quality -= 8;
  }
}
const base = `http://127.0.0.1:${port}/dashboard/index.html`;
await shot("1-board.jpg", base + "#/board", "#rows tr");
await shot("2-detail.jpg", base + "#/protocol/" + topSlug, "#detailView .detail");
await shot("3-filtered.jpg", base + "#/board?verdict=FARM&sort=net", "#rows tr", "#filters");
await browser.close();
server.close();
if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
console.log("shoot: no page errors");
