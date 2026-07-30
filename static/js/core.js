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
  if (res.status === 204) return null;
  return res.json();
}
export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = (path, body) => api(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });

// Hours read as hours, not as a raw float: 6 not 6.00, 6.5 not 6.50.
export function fmtHours(value) {
  const n = Number(value) || 0;
  const shown = Math.round(n * 100) / 100;
  return `${shown} ${shown === 1 ? "hr" : "hrs"}`;
}
