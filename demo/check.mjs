import { chromium } from "playwright";

const base = "http://localhost:5199/";
const browser = await chromium.launch();
const context = await browser.newContext();

function watch(page, name) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(
        `[${name}] console.${msg.type()}: ${msg.text().slice(0, 500)}`,
      );
    }
  });
  page.on("pageerror", (err) =>
    console.log(`[${name}] pageerror: ${err.message.slice(0, 500)}`),
  );
}

const a = await context.newPage();
watch(a, "A");
await a.goto(base);
// wait for the app to boot: hash set + counter rendered
try {
  await a.waitForFunction(() => location.hash.startsWith("#automerge:"), null, {
    timeout: 10000,
  });
  console.log(
    "A booted, url:",
    await a.evaluate(() => location.hash.slice(0, 30)),
  );
} catch {
  console.log(
    "A FAILED to boot; body:",
    (await a.evaluate(() => document.body.innerText)).slice(0, 300),
  );
  await browser.close();
  process.exit(1);
}

const url = await a.evaluate(() => location.href);

const b = await context.newPage();
watch(b, "B");
await b.goto(url);
await b.waitForFunction(() => location.hash.startsWith("#automerge:"), null, {
  timeout: 10000,
});
console.log("B booted");

// --- counter sync A -> B
await a.click("#inc");
await a.click("#inc");
await b
  .waitForFunction(
    () => document.getElementById("count").textContent === "2",
    null,
    { timeout: 5000 },
  )
  .then(() => console.log("counter A->B sync OK"))
  .catch(async () =>
    console.log(
      "counter A->B sync FAILED, B shows:",
      await b.textContent("#count"),
    ),
  );

// --- note sync B -> A
await b.fill("#note", "hello from B");
await a
  .waitForFunction(
    () => document.getElementById("note").value === "hello from B",
    null,
    { timeout: 5000 },
  )
  .then(() => console.log("note B->A sync OK"))
  .catch(async () =>
    console.log(
      "note B->A sync FAILED, A shows:",
      JSON.stringify(await a.inputValue("#note")),
    ),
  );

// --- todo sync A -> B
await a.fill("#new-todo", "buy milk");
await a.click("#add-todo button[type=submit]");
await b
  .waitForFunction(
    () => document.querySelectorAll("#todos li").length === 1,
    null,
    { timeout: 5000 },
  )
  .then(() => console.log("todo A->B sync OK"))
  .catch(async () =>
    console.log(
      "todo A->B sync FAILED, B list:",
      await b.evaluate(() => document.getElementById("todos").innerHTML),
    ),
  );

// --- offline / merge / reconnect
await b.click("#toggle-connection");
console.log("B disconnected:", await b.textContent("#status-label"));
await a.click("#inc"); // A: 3
await b.click("#inc"); // B local: 3 (was 2)
await b.click("#inc"); // B local: 4
await new Promise((r) => setTimeout(r, 300));
const aCount = await a.textContent("#count");
const bCount = await b.textContent("#count");
console.log(`while offline: A=${aCount} (expect 3), B=${bCount} (expect 4)`);

await b.click("#toggle-connection");
await a
  .waitForFunction(
    () => document.getElementById("count").textContent === "5",
    null,
    { timeout: 5000 },
  )
  .then(() => console.log("reconnect merge OK: both should be 5"))
  .catch(async () =>
    console.log(
      "reconnect merge FAILED: A=",
      await a.textContent("#count"),
      "B=",
      await b.textContent("#count"),
    ),
  );
console.log("final B:", await b.textContent("#count"));

await browser.close();
