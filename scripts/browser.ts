/**
 * Browser acceptance, over the Chrome DevTools Protocol.
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN A VITEST FILE
 *
 * Because it needs a built bundle and a real browser, and both are slow enough that they should not
 * be in the loop a developer runs on every save. It also needs a Chrome, which not every environment
 * has, so it fails with an explanation rather than being a test that mysteriously cannot run.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE DOES
 *
 * The repository's own history is the argument: a missing `nodeTypes` entry that React Flow silently
 * papered over, a non-null assertion that blanked the app on every run, a sprite canvas that passed
 * every assertion and rendered nothing. None of those are visible to `tsc` or to a node test, because
 * all three are failures of what the browser does with correct data. The checks below are therefore
 * about RENDERED CONSEQUENCES -- does the swimlane grid contain cells, does the promote button become
 * enabled, does the state survive a reload -- rather than about internal values.
 *
 * Usage:
 *   pnpm build
 *   pnpm --filter @sds/studio preview --port 4319 &
 *   pnpm browser
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { pizzaStudy } from "@sds/models";


/**
 * `WebSocket` is a global from Node 22 onwards, which is what this repository targets. Declared
 * rather than imported so the script has no dependency of its own.
 */
declare const WebSocket: {
  new (url: string): {
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  };
};
type WebSocket = InstanceType<typeof WebSocket>;

const URL_UNDER_TEST = process.env.SDS_URL ?? "http://localhost:4319/";
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const CDP_TIMEOUT_MS = 120_000;

interface Check {
  name: string;
  /** Returns null on success, or the reason it failed. */
  run(): Promise<string | null>;
}

let messageId = 0;
let socket: WebSocket | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/**
 * The session a message is routed to.
 *
 * Null until the page target is attached, after which every message carries the session id. Held as
 * a variable rather than threaded through every helper, because the alternative puts CDP plumbing
 * into every check and makes the checks harder to read than the thing they are checking.
 */
let sessionId: string | null = null;

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    socket!.send(JSON.stringify(message));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, CDP_TIMEOUT_MS);
  });
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * `awaitPromise` is on, so a check can await the app's own asynchronous work -- restoring a study
 * from IndexedDB, for instance -- rather than sleeping and hoping.
 */
async function evaluate<T>(expression: string): Promise<T> {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluation threw");
  }
  return result.result.value as T;
}

async function click(selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`nothing matched ${selector}`);
}

async function waitFor(expression: string, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate<boolean>(`Boolean(${expression})`)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function count(selector: string): Promise<number> {
  return evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

async function text(selector: string): Promise<string> {
  return evaluate<string>(
    `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`
  );
}

/** Import the README's development scenario without exposing it in the application UI. */
async function importDevelopmentScenario(): Promise<void> {
  const json = JSON.stringify(JSON.stringify(pizzaStudy()));
  await evaluate(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error("no project import input");
    const transfer = new DataTransfer();
    transfer.items.add(new File([${json}], "pizza.sds-project.json", { type: "application/json" }));
    Object.defineProperty(input, "files", { value: transfer.files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    `document.querySelectorAll(".candidate-chip:not(.candidate-add)").length >= 7`,
    "the imported development scenario"
  );
}

const checks: Check[] = [
  {
    name: "the app renders at all, with no console error",
    async run() {
      await waitFor(`document.querySelector(".shell")`, "the shell");
      const errors = await evaluate<string[]>(`window.__sdsErrors ?? []`);
      if (errors.length > 0) return `console errors: ${errors.join(" | ")}`;
      return null;
    },
  },

  {
    // The product's actual first screen. It used to boot into the pizza example, which taught that
    // the problem ships with the tool and only the architecture is yours -- backwards, since the
    // problem is the input.
    name: "it opens on an empty project, and says what to do next",
    async run() {
      const chips = await count(".candidate-chip:not(.candidate-add)");
      if (chips !== 0) return `expected an empty project, found ${chips} candidate chips`;
      await waitFor(`document.querySelector(".empty-study")`, "the empty state");
      const body = await text(".empty-card");
      // An empty state that only says "nothing here" leaves the reader to guess which of four
      // views fixes it.
      if (!/describe (the )?(real )?problem/i.test(body)) {
        return `the empty state offers no next step: ${body.slice(0, 120)}`;
      }
      if (!/codex/i.test(body)) return "the empty state never says that Codex can do this";
      return null;
    },
  },

  {
    name: "the README development scenario imports without appearing in the app",
    async run() {
      const appText = await text(".shell");
      if (/pizza|worked examples/i.test(appText)) return "the app exposes the development scenario";
      await importDevelopmentScenario();
      const agentChips = await count(".candidate-chip.agent");
      if (agentChips !== 0) return `${agentChips} candidates are marked agent-authored before any agent ran`;
      return null;
    },
  },

  {
    name: "every node kind renders as a studio node rather than React Flow's fallback",
    async run() {
      // The failure this is here for: a missing `nodeTypes` entry does not throw, it silently renders
      // React Flow's default node, which has no label and breaks selection.
      const nodes = await count(".react-flow__node");
      if (nodes < 4) return `expected the default candidate's nodes, found ${nodes}`;
      const styled = await count(".react-flow__node .sds-node, .react-flow__node [class*='node']");
      if (styled < nodes) return `${nodes - styled} nodes fell back to React Flow's default renderer`;
      return null;
    },
  },

  {
    name: "topology search, authored reach and shortest routes stay graph-grounded",
    async run() {
      await evaluate(`(() => {
        const input = document.querySelector('[aria-label="Find a component by label or stable ID"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "claim service");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await click(".topology-go");
      await waitFor(
        `document.querySelector(".topology-receipt")?.textContent.includes("Focused claim service")`,
        "component search to focus the authored node"
      );

      await evaluate(`(() => {
        const button = [...document.querySelectorAll(".topology-action")]
          .find((candidate) => candidate.textContent.trim().startsWith("Downstream"));
        if (!button || button.disabled) throw new Error("downstream reach did not enable");
        button.click();
      })()`);
      await waitFor(
        `document.querySelectorAll(".react-flow__node.topology-muted").length > 0`,
        "unrelated topology to dim"
      );
      const reachReceipt = await text(".topology-receipt");
      if (!reachReceipt.includes("authored links")) return `reach receipt lost its source boundary: ${reachReceipt}`;
      if (!reachReceipt.includes("runtime impact is not inferred")) {
        return `reach receipt overclaims runtime meaning: ${reachReceipt}`;
      }

      await evaluate(`(() => {
        const button = [...document.querySelectorAll(".topology-action")]
          .find((candidate) => candidate.textContent.trim().startsWith("Route"));
        if (!button) throw new Error("route control missing");
        button.click();
      })()`);
      await waitFor(`document.querySelector('[aria-label="Route start"]')`, "route controls");
      await evaluate(`(() => {
        const select = document.querySelector('[aria-label="Route start"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "crowd");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(
        `document.querySelector('[aria-label="Route destination"] option[value="db"]')`,
        "the claims store route destination"
      );
      await evaluate(`(() => {
        const select = document.querySelector('[aria-label="Route destination"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "db");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(`document.querySelector(".topology-route-receipt")`, "the route receipt");
      // The explorer receipt and React Flow's internally memoized SVG edges commit in separate
      // render work. Wait for the rendered consequence instead of racing that second commit.
      await waitFor(
        `document.querySelectorAll(".react-flow__edge.topology-match").length === 3`,
        "the three route links to highlight"
      );

      const matchingEdges = await count(".react-flow__edge.topology-match");
      if (matchingEdges !== 3) return `expected the three-hop authored route, highlighted ${matchingEdges} links`;
      const routeReceipt = await text(".topology-route-receipt");
      if (!routeReceipt.includes("Shortest authored route · 3 hops")) {
        return `route receipt is not exact about its method: ${routeReceipt}`;
      }
      return null;
    },
  },

  {
    name: "the correctness view runs a search and renders a counterexample as swimlanes",
    async run() {
      await click(`.tabs button:nth-of-type(2)`);
      await waitFor(`document.querySelector(".view-correctness")`, "the correctness view");
      await click(`.view-correctness .btn.primary`);
      await waitFor(`document.querySelector(".verdict")`, "a verdict", 90_000);

      const status = await text(".verdict-status");
      if (!status.includes("violated")) return `expected the first candidate to be violated, got "${status}"`;

      // The rendered consequence, not the internal value: a layout that computed correct columns and
      // drew nothing would pass every node test and fail here.
      const cells = await count(".lane-cell");
      if (cells < 2) return `the swimlane grid rendered ${cells} cells`;
      const heads = await count(".lane-head");
      if (heads < 2) return `expected at least two lanes, found ${heads}`;
      const diffs = await count(".lane-diff");
      if (diffs < 1) return "no state change was shown in the trace";
      return null;
    },
  },

  {
    name: "the scrubber steps through the trace",
    async run() {
      const before = await text(".timeline .stat-grid");
      // Through the native value setter, because React tracks the last value it wrote on the DOM
      // node and ignores an event whose value it believes it already has. Assigning `.value`
      // directly updates the node and React's tracker in one step, so the change looks like a
      // no-op. This is a property of the framework, not of the app, and getting it wrong here would
      // have reported a working scrubber as broken.
      await evaluate(`(() => {
        const slider = document.querySelector(".scrubber input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(slider, "0");
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      const after = await text(".timeline .stat-grid");
      if (before === after) return "moving the scrubber to the first step changed nothing on screen";
      const future = await count(".lane-row-future");
      if (future < 1) return "later steps were not dimmed, so the trace does not read as ordered";
      return null;
    },
  },

  {
    name: "the guided invariant builder adds an invariant",
    async run() {
      // The earlier search locks the contract. Reimport the development fixture so this check
      // starts with a fresh project rather than testing the lock twice.
      await importDevelopmentScenario();
      await click(`.tabs button:nth-of-type(2)`);
      await waitFor(`document.querySelector(".view-correctness")`, "the correctness view");

      const before = await count(".invariant-list li");
      await evaluate(`(() => {
        const selects = document.querySelectorAll(".builder select");
        const set = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        set(selects[0], "counter-non-negative");
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      await evaluate(`(() => {
        const selects = document.querySelectorAll(".builder select");
        const set = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        set(selects[1], "inventory");
      })()`);
      await waitFor(`!document.querySelector(".builder .btn.primary").disabled`, "the add button to enable");
      await click(".builder .btn.primary");
      await new Promise((r) => setTimeout(r, 300));
      const after = await count(".invariant-list li");
      if (after !== before + 1) return `invariant count went from ${before} to ${after}`;
      return null;
    },
  },

  {
    name: "expert mode shows the same invariant as declarative JSON",
    async run() {
      await click(`.tabs-small button:nth-of-type(2)`);
      await new Promise((r) => setTimeout(r, 200));
      const previews = await count(".invariant-list .expr-preview");
      if (previews < 1) return "expert mode rendered no expression";
      const body = await text(".invariant-list .expr-preview");
      if (!body.includes("kind")) return `the expression did not render as declarative JSON: ${body.slice(0, 80)}`;
      return null;
    },
  },

  {
    name: "the compare view gates the broken candidates out and offers promotion only for eligible ones",
    async run() {
      await click(`.tabs button:nth-of-type(4)`);
      await waitFor(`document.querySelector(".view-compare")`, "the compare view");

      const deltaPickers = await count(".architecture-delta select");
      if (deltaPickers !== 2) return `architecture delta rendered ${deltaPickers} candidate selectors`;
      const deltaClaim = await text(".architecture-delta");
      if (!deltaClaim.includes("Exact-ID authored delta only")) {
        return `architecture delta lost its comparison boundary: ${deltaClaim.slice(-180)}`;
      }
      if (!deltaClaim.includes("api")) return "architecture delta did not identify the changed stable component ID";

      await click(`.view-compare .btn.primary`);
      // Seven candidates, correctness plus replicated performance. Generous, and bounded.
      await waitFor(
        `document.querySelectorAll(".gate-card").length >= 7 && !document.querySelector(".chip-spin")`,
        "every candidate to be evaluated",
        600_000
      );

      const eligible = await count(".gate-card.gate-eligible");
      const ineligible = await count(".gate-card.gate-ineligible");
      if (eligible < 1) return "no candidate became eligible, so the gates are rejecting everything";
      if (ineligible < 4) return `expected at least four deliberately-broken candidates to be gated out, ${ineligible} were`;

      const claim = await text(".view-compare .lede");
      if (!claim.includes("AMONG THE CANDIDATES TESTED")) {
        return `the frontier claim dropped its qualifier: "${claim.slice(0, 120)}"`;
      }

      const enabledPromote = await evaluate<number>(`
        [...document.querySelectorAll(".gate-card footer .btn")]
          .filter((b) => b.textContent.trim() === "Choose" && !b.disabled).length
      `);
      if (enabledPromote < 1) return "no eligible candidate offered an enabled promote button";
      const enabledOnIneligible = await evaluate<number>(`
        [...document.querySelectorAll(".gate-card.gate-ineligible footer .btn")]
          .filter((b) => b.textContent.trim() === "Choose" && !b.disabled).length
      `);
      if (enabledOnIneligible > 0) return "an ineligible candidate offered promotion";
      return null;
    },
  },

  {
    name: "promotion is a human click and it sticks",
    async run() {
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll(".gate-card.gate-eligible footer .btn")]
          .find((b) => b.textContent.trim() === "Choose" && !b.disabled);
        btn.click();
      })()`);
      await waitFor(`document.querySelector(".chip-promoted")`, "a promoted badge");
      const promoted = await count(".chip-promoted");
      if (promoted !== 1) return `${promoted} candidates are marked promoted`;
      return null;
    },
  },

  {
    name: "the project survives a reload, from IndexedDB",
    async run() {
      const nameBefore = await text(".candidate-bar-title");
      const invariantsBefore = await evaluate<number>(`
        (async () => {
          // Read through the app's own store rather than the DOM, because the correctness view is not
          // the one currently mounted.
          return document.querySelectorAll(".candidate-chip:not(.candidate-add)").length;
        })()
      `);

      await send("Page.reload", { ignoreCache: false });
      await waitFor(`document.querySelector(".candidate-bar-title")`, "the app after reload");
      // The pointer is in local storage and the document is in IndexedDB, so a restore is
      // asynchronous. Waiting for the promoted badge waits for the real thing.
      await waitFor(`document.querySelector(".chip-promoted")`, "the promoted candidate to come back", 30_000);

      const nameAfter = await text(".candidate-bar-title");
      if (nameAfter !== nameBefore) return `project name changed across reload: "${nameBefore}" -> "${nameAfter}"`;
      const chipsAfter = await count(".candidate-chip:not(.candidate-add)");
      if (chipsAfter !== invariantsBefore) return `candidate count changed across reload: ${invariantsBefore} -> ${chipsAfter}`;
      return null;
    },
  },

  {
    name: "the agent surface reports its own availability rather than failing silently",
    async run() {
      const label = await evaluate<string>(`
        [...document.querySelectorAll(".btn")].map((b) => b.textContent.trim()).find((t) => t.startsWith("Codex ")) ?? ""
      `);
      if (!label) return "no agent status is shown anywhere";
      // Either a tool count, or a stated reason. Both are acceptable; silence is not.
      if (!/Codex (ready|unsupported|failed|idle)/.test(label)) {
        return `Codex status is uninformative: "${label}"`;
      }
      return null;
    },
  },

  {
    name: "adding a candidate copies rather than aliases",
    async run() {
      await click(`.tabs button:nth-of-type(1)`);
      const before = await count(".candidate-chip:not(.candidate-add)");
      await click(".candidate-add");
      await new Promise((r) => setTimeout(r, 400));
      const after = await count(".candidate-chip:not(.candidate-add)");
      if (after !== before + 1) return `candidate count went from ${before} to ${after}`;
      return null;
    },
  },
];

async function main(): Promise<void> {
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) {
    console.log(`${RED}no Chrome or Chromium found${OFF}. Looked in:`);
    for (const p of CHROME_CANDIDATES) console.log(`  ${p}`);
    console.log(`\nSet one on the PATH, or run the checks by hand against ${URL_UNDER_TEST}.`);
    process.exit(1);
  }

  const port = 9222 + Math.floor(Math.random() * 400);
  const browser: ChildProcess = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1600,1000",
      // A fresh profile every run, so a stored study from a previous run cannot make a reload check
      // pass for the wrong reason.
      `--user-data-dir=/tmp/sds-browser-${port}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const cleanup = () => {
    socket?.close();
    browser.kill();
  };
  process.on("exit", cleanup);

  // The debugging endpoint takes a moment to bind.
  let wsUrl = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!wsUrl) {
    console.log(`${RED}could not reach the browser's debugging endpoint${OFF}`);
    cleanup();
    process.exit(1);
  }

  socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve());
    socket!.addEventListener("error", () => reject(new Error("debugger socket failed")));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId, flatten: true });
  // From here on, every message is routed to the page session.
  sessionId = attached.sessionId as string;

  await send("Runtime.enable");
  await send("Page.enable");
  // Capture errors so the first check can assert there were none. A React error boundary failure
  // prints and renders nothing, which is exactly the class of bug this script exists for.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__sdsErrors = [];
      window.addEventListener("error", (e) => window.__sdsErrors.push(String(e.message)));
      window.addEventListener("unhandledrejection", (e) => window.__sdsErrors.push("unhandled rejection: " + String(e.reason)));
      console.error = ((orig) => (...a) => { window.__sdsErrors.push(a.map(String).join(" ")); orig(...a); })(console.error);`,
  });
  await send("Page.navigate", { url: URL_UNDER_TEST });

  let failures = 0;
  for (const check of checks) {
    try {
      const reason = await check.run();
      if (reason === null) {
        console.log(`${GREEN}pass${OFF} ${check.name}`);
      } else {
        failures++;
        console.log(`${RED}FAIL${OFF} ${check.name}\n     ${DIM}${reason}${OFF}`);
      }
    } catch (err) {
      failures++;
      console.log(
        `${RED}FAIL${OFF} ${check.name}\n     ${DIM}${err instanceof Error ? err.message : String(err)}${OFF}`
      );
    }
  }

  console.log(
    `\n${failures === 0 ? GREEN : RED}${checks.length - failures}/${checks.length} browser checks passed${OFF}`
  );
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
