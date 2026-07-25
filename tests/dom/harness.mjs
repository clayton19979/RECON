// Shared jsdom harness for the front-end smoke tests.
//
// Booting the real index.html + app.js is fiddly in ways that are easy to get
// subtly wrong (see the DOMContentLoaded note below), and there's now more
// than one screen worth driving, so the boot lives here and each *_smoke.mjs
// file is just its screen's assertions.
//
// Requires jsdom, which is not a dependency of the app itself:
//     cd tests/dom && npm install jsdom
// tests/test_dom_smoke.py skips when node or jsdom isn't there.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// CommonJS resolution, so NODE_PATH works and jsdom can live anywhere the
// caller points at rather than only in a node_modules beside this file.
const { JSDOM } = createRequire(import.meta.url)("jsdom");

export const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "static");

/**
 * Boot the app in jsdom.
 *
 * @param {object} opts
 * @param {(url: string, opts: object) => any} opts.fetch  responds to the app's
 *        requests; return the parsed body, or a { status, body } pair.
 * @param {string[]} opts.expose  names from app.js's module scope to copy onto
 *        `window`. app.js is strict-mode, so an eval'd declaration does *not*
 *        become a global -- anything a test wants to call has to be listed.
 * @returns {Promise<object>} { dom, w, doc, fetchLog, settle, ok, fails, rejections, finish }
 */
export async function boot({ fetch: handler, expose = [] } = {}) {
  const html = fs.readFileSync(`${STATIC_DIR}/index.html`, "utf8");
  const js = fs.readFileSync(`${STATIC_DIR}/app.js`, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;

  const fetchLog = [];
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    fetchLog.push({ url: String(url), method });
    const answer = handler ? await handler(String(url), { ...opts, method }) : null;
    // A handler that wants to fail a request returns { __status, body }.
    if (answer && typeof answer === "object" && answer.__status) {
      return { ok: answer.__status < 400, status: answer.__status, statusText: "", json: async () => answer.body };
    }
    return { ok: true, status: 200, statusText: "", json: async () => answer };
  };

  // A render that throws inside a click handler surfaces as an unhandled
  // rejection, which would take the whole process down mid-suite and lose
  // every assertion after it. Record them and let the test decide.
  const rejections = [];
  process.on("unhandledRejection", (err) => rejections.push(err));

  const exposed = expose.length ? `\n;Object.assign(window, { ${expose.join(", ")} });` : "";
  w.eval(js + exposed);

  // Wait for jsdom's *own* DOMContentLoaded rather than dispatching one.
  // Dispatching it manually ran the app's whole init twice (jsdom fires the
  // real event a tick after the constructor returns), which quietly doubled
  // every listener the app binds at startup -- so a toggle handler bound at
  // init ran twice per click and appeared not to work at all.
  await new Promise((resolve) => {
    if (w.document.readyState === "loading") w.document.addEventListener("DOMContentLoaded", resolve, { once: true });
    else { w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true })); resolve(); }
  });

  // Give queued promise callbacks (fetch -> json -> render) a chance to run.
  const settle = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const finish = (label) => {
    if (fails.length) {
      console.error(`FAIL (${label})\n` + fails.join("\n"));
      process.exit(1);
    }
    console.log(`PASS -- ${label}`);
  };

  return { dom, w, doc: w.document, fetchLog, settle, ok, fails, rejections, finish };
}

/** Dispatch a keydown on document, the way a real key press reaches the app. */
export function press(w, key, init = {}) {
  const target = init.target || w.document.body;
  delete init.target;
  target.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

/** Click, optionally with modifiers (jsdom's .click() can't carry them). */
export function click(w, el, init = {}) {
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}
