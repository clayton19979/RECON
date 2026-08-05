/* ---------- helpers ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail || message;
    } catch {}
    throw new Error(message);
  }
  // Anything that isn't a GET just changed the shop's records, and the change
  // counter is about to move because of it. Said out loud here so the freshness
  // check (pulse.js) can tell "I did that" from "the other PC did that" and
  // not offer to refresh a screen that is already reloading itself. A plain
  // DOM event rather than a call, so the lowest-level module in the app stays
  // free of imports.
  if ((opts.method || "GET").toUpperCase() !== "GET") {
    document.dispatchEvent(new CustomEvent("recon:wrote"));
  }
  if (res.status === 204) return null;
  return res.json();
}
/* Who the server should record as having done this.

   The server writes an `actor` onto every logged event, and the ticket's
   activity log prints it back as the person who did it. Getting that name
   onto the request was left to each call site, and it drifted exactly the way
   per-call-site conventions do: about a dozen writes sent it and the rest --
   opening a ticket, adding or ticking off a job, saving the assignment,
   editing a line -- sent nothing, so the log recorded the literal string
   "ui" and printed "Ticket opened by ui" back at an advisor.

   Attaching it here instead means a new write cannot forget. A call site that
   passes its own `actor` still wins, and nothing is added when nobody has
   said who they are -- the server's own placeholder is a better record of
   "we don't know" than a made-up name.

   Set by initCurrentUser (state.js) rather than imported, because this is the
   module everything else imports and it stays free of imports itself. */
let actorSource = () => "";
export function setActorSource(fn) {
  actorSource = fn;
}
function withActor(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if ("actor" in body) return body;
  const who = actorSource();
  return who ? { ...body, actor: who } : body;
}
/* A DELETE has no body to hide a name in, so the one delete that logs an
   event -- removing a job from a ticket -- takes its actor in the query
   string. Here rather than at the call site so there is still exactly one
   place that knows how the name travels. */
export function withActorParam(path) {
  const who = actorSource();
  return who ? `${path}${path.includes("?") ? "&" : "?"}actor=${encodeURIComponent(who)}` : path;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(withActor(body)) });
export const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(withActor(body)) });
export const patch = (path, body) => api(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(withActor(body)) });

// Hours read as hours, not as a raw float: 6 not 6.00, 6.5 not 6.50.
export function fmtHours(value) {
  const n = Number(value) || 0;
  const shown = Math.round(n * 100) / 100;
  return `${shown} ${shown === 1 ? "hr" : "hrs"}`;
}
