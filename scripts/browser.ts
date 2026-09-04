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
import { PRESETS, pizzaStudy } from "@sds/models";
import { PIZZA_INTERVIEW_PROMPT } from "../apps/studio/src/interview-prompts";


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
  const fixture = {
    ...pizzaStudy(),
    // The retired product-demo id is deliberately not persisted. This remains a private browser
    // fixture and reload coverage still exercises an ordinary user-project identity.
    id: "browser-acceptance-fixture",
    name: "browser acceptance fixture",
  };
  const json = JSON.stringify(JSON.stringify(fixture));
  if ((await count('input[type="file"]')) === 0) {
    await click(".crumb-current");
    await waitFor(`document.querySelector('input[type="file"]')`, "the project import input");
  }
  await evaluate(`(() => {
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error("no project import input");
    const transfer = new DataTransfer();
    transfer.items.add(new File([${json}], "browser-fixture.sds-project.json", { type: "application/json" }));
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
    name: "the current start screen exposes all three entry paths and a working blank canvas",
    async run() {
      const chips = await count(".candidate-chip:not(.candidate-add)");
      if (chips !== 0) return `expected an empty project, found ${chips} candidate chips`;
      await waitFor(`document.querySelector(".empty-study")`, "the empty state");
      const body = await text(".start-shell");
      if (!/coding agent draw the current system/i.test(body)) return "the codebase entry path is missing";
      if (!/coding agent/i.test(body)) return "the empty state never says that a coding agent does the work";
      if (!/webmcp/i.test(body)) return "the empty state never names the shared WebMCP path";
      if (!/new project/i.test(body)) return "the blank-canvas entry path is missing";
      if (!/system design interview/i.test(body) || !/200 free pizzas/i.test(body)) {
        return "the interview-prompt entry path is missing";
      }

      await evaluate(`(() => {
        window.__sdsCopiedPrompt = null;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (value) => { window.__sdsCopiedPrompt = String(value); } },
        });
      })()`);
      await click(".start-option.interview-prompt");
      await waitFor(
        `document.querySelector(".start-option.interview-prompt")?.textContent.includes("Prompt copied")`,
        "the interview prompt copy confirmation"
      );
      const copiedPrompt = await evaluate<string>(`window.__sdsCopiedPrompt ?? ""`);
      if (copiedPrompt !== PIZZA_INTERVIEW_PROMPT) return "the interview card copied the wrong prompt";
      if ((await count(".candidate-chip:not(.candidate-add)")) !== 0) {
        return "copying the interview prompt created or changed a project";
      }
      if ((await count('.start-option.interview-prompt [aria-live="polite"]')) !== 1) {
        return "the interview prompt has no accessible copy status";
      }

      await evaluate(`Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => { throw new DOMException("blocked", "NotAllowedError"); } },
      })`);
      await click(".start-option.interview-prompt");
      await waitFor(`document.querySelector(".interview-prompt-fallback textarea")`, "the manual-copy fallback");
      const manualPrompt = await evaluate<string>(
        `document.querySelector(".interview-prompt-fallback textarea")?.value ?? ""`
      );
      if (manualPrompt !== PIZZA_INTERVIEW_PROMPT) {
        return "the clipboard failure did not reveal the exact prompt";
      }
      if ((await count(".candidate-chip:not(.candidate-add)")) !== 0) {
        return "a failed interview-prompt copy created or changed a project";
      }

      await click(`.start-option.import .btn:not(.primary)`);
      await waitFor(`document.querySelector(".starter-prompt")`, "the agent prompt disclosure");
      if ((await count(".starter-prompt")) !== 1) return "expected exactly one agent prompt";
      const topbar = await text(".topbar");
      if (/projects|agent prompts/i.test(topbar)) return "empty project controls remain in the top bar";

      await click(".start-option.blank .btn.primary");
      await waitFor(
        `document.querySelectorAll(".candidate-chip:not(.candidate-add)").length === 1`,
        "the manual design candidate"
      );
      if ((await count(".react-flow__node")) !== 0) return "the manual canvas invented components";
      const quickInsertCount = await count(`.toolbar-quick button[aria-label^="Add "]`);
      if (quickInsertCount !== PRESETS.length) {
        return `expected ${PRESETS.length} component presets, found ${quickInsertCount}`;
      }
      for (const preset of PRESETS) {
        await click(`button[aria-label=${JSON.stringify(`Add ${preset.label}`)}]`);
      }
      await waitFor(
        `document.querySelectorAll(".react-flow__node").length === ${PRESETS.length}`,
        "every component preset to be inserted"
      );
      const styled = await count(".react-flow__node .node");
      if (styled !== PRESETS.length) return `${PRESETS.length - styled} inserted presets used a fallback node`;
      if (!/server/i.test(await text(".rail.right"))) return "the final inserted component did not open its Inspector";
      await click(`button[aria-label="Delete node"]`);
      await waitFor(
        `document.querySelectorAll(".react-flow__node").length === ${PRESETS.length - 1}`,
        "the selected inserted component to be removed"
      );
      if ((await count("button")) === 0 || !/component/i.test(await text(".topbar"))) {
        return "the manual canvas has no way to add its first component";
      }
      return null;
    },
  },

  {
    name: "the development fixture imports through the same JSON path as a user project",
    async run() {
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
      const styled = await count(".react-flow__node .node");
      if (styled !== nodes) return `${nodes - styled} nodes fell back to React Flow's default renderer`;
      return null;
    },
  },

  {
    name: "Guided folds advanced controls while Expert expands the same model",
    async run() {
      await evaluate(`document.querySelector('[aria-label="Interface detail"] button:first-child').click()`);
      await evaluate(`document.querySelector('.react-flow__node[data-id="crowd"]').click()`);
      await waitFor(`document.querySelector('.rail.right .density-section')`, "component controls in the Inspector");
      const guidedOpen = await evaluate<number>(
        `[...document.querySelectorAll('.rail.right .density-section')].filter((section) => section.open).length`
      );
      if (guidedOpen !== 0) return `Guided unexpectedly opened ${guidedOpen} advanced sections`;

      await evaluate(`document.querySelector('[aria-label="Interface detail"] button:nth-child(2)').click()`);
      await waitFor(
        `[...document.querySelectorAll('.rail.right .density-section')].every((section) => section.open)`,
        "Expert controls to expand"
      );
      const caption = await text(".density-caption");
      if (caption !== "All controls") return `Expert caption stayed at "${caption}"`;
      if ((await count(".react-flow__node")) < 1) return "changing interface density changed the design";

      await evaluate(`document.querySelector('[aria-label="Interface detail"] button:first-child').click()`);
      await waitFor(
        `![...document.querySelectorAll('.rail.right .density-section')].some((section) => section.open)`,
        "Guided controls to fold again"
      );
      return null;
    },
  },

  {
    name: "a rendered connection can be selected, edited, and undone",
    async run() {
      const selected = await evaluate<boolean>(`(() => {
        const path = document.querySelector('.react-flow__edge .react-flow__edge-interaction');
        if (!path) return false;
        path.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      if (!selected) return "no rendered connection interaction path was available";
      await waitFor(`document.querySelector('button[aria-label="Delete connection"]')`, "the connection Inspector");
      await evaluate(`document.querySelector('[aria-label="Interface detail"] button:nth-child(2)').click()`);
      await waitFor(
        `[...document.querySelectorAll('.rail.right .density-section')].every((section) => section.open)`,
        "connection controls to expand"
      );

      const before = await evaluate<string>(`(() => {
        const field = [...document.querySelectorAll('.rail.right label.field')]
          .find((label) => label.querySelector('.field-label')?.childNodes[0]?.textContent?.trim() === 'probability');
        return field?.querySelector('input')?.value ?? '';
      })()`);
      if (!before) return "the connection routing probability control is missing";
      const next = before === "100" ? "99" : "100";
      await evaluate(`(() => {
        const field = [...document.querySelectorAll('.rail.right label.field')]
          .find((label) => label.querySelector('.field-label')?.childNodes[0]?.textContent?.trim() === 'probability');
        const input = field?.querySelector('input');
        if (!input) throw new Error('probability input missing');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(next)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(
        `(() => {
          const field = [...document.querySelectorAll('.rail.right label.field')]
            .find((label) => label.querySelector('.field-label')?.childNodes[0]?.textContent?.trim() === 'probability');
          return field?.querySelector('input')?.value === ${JSON.stringify(next)};
        })()`,
        "the edited connection value"
      );

      await click(`button[aria-label^="Undo"]`);
      await waitFor(
        `(() => {
          const field = [...document.querySelectorAll('.rail.right label.field')]
            .find((label) => label.querySelector('.field-label')?.childNodes[0]?.textContent?.trim() === 'probability');
          return field?.querySelector('input')?.value === ${JSON.stringify(before)};
        })()`,
        "the connection edit to undo"
      );
      return null;
    },
  },

  {
    name: "manual injection and full streaming both drive deterministic live sessions",
    async run() {
      await click(`.lens-tabs button:nth-child(2)`);
      await waitFor(`document.querySelector(".simulation-session")`, "the live simulation controls");

      await click(`.session-mode button:first-child`);
      await click(`.simulation-session .session-actions .btn.primary`);
      await waitFor(`document.querySelector('.session-state')?.textContent.includes('ready')`, "the armed manual session");
      const manualTimeBefore = await text(".session-progress-row .tnum");
      await new Promise((resolve) => setTimeout(resolve, 400));
      const manualTimeAfter = await text(".session-progress-row .tnum");
      if (manualTimeAfter !== manualTimeBefore) return "a paused manual session advanced on wall-clock time";

      await evaluate(`document.querySelector('.react-flow__node[data-id="crowd"]').click()`);
      await waitFor(
        `document.querySelector('.session-readout')?.textContent.includes('1 injected')`,
        "one manual request to be injected"
      );
      const manualReadout = await text(".session-readout");
      if (!manualReadout.includes("1 injected")) return `manual click produced the wrong count: ${manualReadout}`;
      await evaluate(`([...document.querySelectorAll('.simulation-session button')]
        .find((button) => button.textContent.trim() === 'Finish')).click()`);
      await waitFor(`document.querySelector('.session-state')?.textContent.includes('completed')`, "manual completion", 90_000);
      if ((await count(".simulation-session button")) === 0 || !(await text(".simulation-session")).includes("Replay trace")) {
        return "the completed manual session was not retained for replay";
      }

      await click(`.session-mode button:nth-child(2)`);
      await click(`.simulation-session .session-actions .btn.primary`);
      await waitFor(
        `(() => {
          const value = document.querySelector('.session-readout span')?.textContent ?? '';
          return /[1-9][0-9,]* generated/.test(value);
        })()`,
        "the full workload stream"
      );
      await click(`button[aria-label="Pause session"]`);
      await waitFor(`document.querySelector('button[aria-label="Resume session"]')`, "the full session to pause");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pausedAt = await text(".session-progress-row .tnum");
      await new Promise((resolve) => setTimeout(resolve, 400));
      if ((await text(".session-progress-row .tnum")) !== pausedAt) return "the paused full session kept advancing";

      await evaluate(`(() => {
        const select = document.querySelector('.session-speed select');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, '4');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await click(`button[aria-label="Resume session"]`);
      await waitFor(
        `document.querySelector('.session-progress-row .tnum')?.textContent !== ${JSON.stringify(pausedAt)}`,
        "the resumed full session to advance"
      );
      await evaluate(`([...document.querySelectorAll('.simulation-session button')]
        .find((button) => button.textContent.trim() === 'Finish')).click()`);
      await waitFor(`document.querySelector('.session-state')?.textContent.includes('completed')`, "full completion", 90_000);
      await click(`.lens-tabs button:first-child`);
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
      await click(`.lens-tabs button:first-child`);
      await waitFor(`document.querySelector(".doc-rail")`, "the Behaviour lens");
      await click(`.hero-play`);
      await waitFor(`document.querySelector(".verdict")`, "a verdict", 90_000);

      const status = await text(".verdict-status");
      if (!/breaks a rule|violated/i.test(status)) {
        return `expected the first candidate to break a rule, got "${status}"`;
      }

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
      const before = await text(".dock-state");
      // Through the native value setter, because React tracks the last value it wrote on the DOM
      // node and ignores an event whose value it believes it already has. Assigning `.value`
      // directly updates the node and React's tracker in one step, so the change looks like a
      // no-op. This is a property of the framework, not of the app, and getting it wrong here would
      // have reported a working scrubber as broken.
      await evaluate(`(() => {
        const slider = document.querySelector(".dock-scrub");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(slider, "0");
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      const after = await text(".dock-state");
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
      await click(`.lens-tabs button:first-child`);
      await waitFor(`document.querySelector(".doc-rail")`, "the Behaviour lens");
      await click(`[aria-label="Interface detail"] button:first-child`);
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('.doc-rail button')]
          .find((candidate) => candidate.textContent.trim() === '+ add a rule');
        if (!button || button.disabled) throw new Error('the add-rule control is unavailable');
        button.click();
      })()`);
      await waitFor(`document.querySelector(".builder")`, "the Guided invariant builder");

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
      await click(`[aria-label="Interface detail"] button:nth-child(2)`);
      await new Promise((r) => setTimeout(r, 200));
      const previews = await count(".invariant-list .expr-preview");
      if (previews < 1) return "expert mode rendered no expression";
      const body = await text(".invariant-list .expr-preview");
      if (!body.includes("kind")) return `the expression did not render as declarative JSON: ${body.slice(0, 80)}`;
      return null;
    },
  },

  {
    name: "the compare view gates broken candidates out and offers approval only for eligible changes",
    async run() {
      await click(`.topbar button[title^="Compare versions"]`);
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

      const enabledApproval = await evaluate<number>(`
        [...document.querySelectorAll(".gate-card footer .btn")]
          .filter((b) => b.textContent.trim().startsWith("Approve") && !b.disabled).length
      `);
      if (enabledApproval < 1) return "no eligible experiment offered an enabled approval button";
      const enabledOnIneligible = await evaluate<number>(`
        [...document.querySelectorAll(".gate-card.gate-ineligible footer .btn")]
          .filter((b) => b.textContent.trim().startsWith("Approve") && !b.disabled).length
      `);
      if (enabledOnIneligible > 0) return "an ineligible candidate offered approval";
      return null;
    },
  },

  {
    name: "approval is a human click and it sticks",
    async run() {
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll(".gate-card.gate-eligible footer .btn")]
          .find((b) => b.textContent.trim().startsWith("Approve") && !b.disabled);
        if (!btn) throw new Error("no eligible approval button");
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
      const title = await evaluate<string>(`document.querySelector(".status-btn")?.getAttribute("title") ?? ""`);
      if (!title) return "the Agent button has no availability explanation";
      await click(".status-btn");
      await waitFor(`document.querySelector(".agent-panel")`, "the Agent panel");
      const panel = await text(".agent-panel");
      if (!/WebMCP/.test(panel) || !/(connected through|no WebMCP client attached)/i.test(panel)) {
        return `the Agent panel status is uninformative: "${panel.slice(0, 160)}"`;
      }
      if (!/recommended/.test(panel) || !/external coding agent/i.test(panel)) {
        return "the Agent panel does not identify the primary external provider";
      }
      const layout = await evaluate<{
        stepsBottom: number;
        streamTop: number;
        streamBottom: number;
        composerTop: number;
      } | null>(`(() => {
        const steps = document.querySelector(".agent-panel > .agent-steps");
        const stream = document.querySelector(".agent-panel > .agent-stream");
        const composer = document.querySelector(".agent-panel > .ask-agent");
        if (!steps || !stream || !composer) return null;
        const stepsRect = steps.getBoundingClientRect();
        const streamRect = stream.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        return {
          stepsBottom: stepsRect.bottom,
          streamTop: streamRect.top,
          streamBottom: streamRect.bottom,
          composerTop: composerRect.top,
        };
      })()`);
      if (!layout) return "the Agent panel is missing a progress, activity, or composer section";
      if (layout.stepsBottom > layout.streamTop + 0.5) {
        return `the progress tracker overlaps the activity stream by ${Math.round(layout.stepsBottom - layout.streamTop)}px`;
      }
      if (layout.streamBottom > layout.composerTop + 0.5) {
        return `the activity stream overlaps the composer by ${Math.round(layout.streamBottom - layout.composerTop)}px`;
      }
      return null;
    },
  },

  {
    name: "adding a candidate copies rather than aliases",
    async run() {
      if (await count(`button[aria-label="close review"]`)) await click(`button[aria-label="close review"]`);
      await click(`.lens-tabs button:first-child`);
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
