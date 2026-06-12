// Reload/catch-up scenario:
//  1. tab A boots, creates data
//  2. tab B opens the same doc
//  3. tab A closes ("reload" downtime)
//  4. B keeps editing while A is gone
//  5. A reopens -> must show its own old data AND B's edits
// Run: npx vite demo --port 5199   then   node demo/check-reload.mjs
import { chromium } from "playwright";

const base = "http://localhost:5199/";
const browser = await chromium.launch();
const context = await browser.newContext();

const boot = async (name, url) => {
  const page = await context.newPage();
  page.on("pageerror", (e) =>
    console.log(`[${name}] pageerror:`, e.message.slice(0, 300)),
  );
  await page.goto(url);
  await page.waitForFunction(
    () => location.hash.startsWith("#automerge:"),
    null,
    { timeout: 10000 },
  );
  return page;
};

let a = await boot("A", base);
const url = await a.evaluate(() => location.href);

await a.click("#inc");
await a.fill("#new-todo", "from A before reload");
await a.click("#add-todo button[type=submit]");

const b = await boot("B", url);
await b.waitForFunction(
  () => document.querySelectorAll("#todos li").length === 1,
);
console.log("B caught up with A's initial data");

// --- A goes away
await a.close();

// --- B edits while A is gone
await b.click("#inc");
await b.click("#inc");
await b.fill("#note", "written while A was away");
await b.fill("#new-todo", "from B during downtime");
await b.click("#add-todo button[type=submit]");
await new Promise((r) => setTimeout(r, 300));

// --- A comes back (same URL, like a reload)
a = await boot("A", url);
await a.waitForFunction(
  () =>
    document.getElementById("count").textContent === "3" &&
    document.querySelectorAll("#todos li").length === 2 &&
    document.getElementById("note").value === "written while A was away",
  null,
  { timeout: 5000 },
);
console.log("A after reload: count =", await a.textContent("#count"));
console.log(
  "A after reload: todos =",
  await a.evaluate(() =>
    [...document.querySelectorAll("#todos li span")].map((s) => s.textContent),
  ),
);
console.log(
  "A after reload: note  =",
  JSON.stringify(await a.inputValue("#note")),
);
console.log("reload catch-up OK");

await browser.close();
