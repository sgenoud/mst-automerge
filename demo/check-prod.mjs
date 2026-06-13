import { chromium } from "playwright";

const base = process.argv[2] || "http://localhost:5198/";
const browser = await chromium.launch();
const page = await browser.newContext().then((c) => c.newPage());
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(`console.${m.type()}: ${m.text().slice(0, 600)}`);
});
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 600)));

await page.goto(base);
await new Promise((r) => setTimeout(r, 4000));
console.log(
  "hash after 4s:",
  JSON.stringify(await page.evaluate(() => location.hash)),
);
console.log(
  "localStorage:",
  JSON.stringify(
    await page.evaluate(() => localStorage.getItem("mst-automerge-demo-url")),
  ),
);
console.log(
  "count el:",
  await page.evaluate(() => document.getElementById("count")?.textContent),
);
await browser.close();
