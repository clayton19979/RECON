import { $, $$, api, get, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { esc, fmtDate, relativeTime, withLoading } from "./shortcuts.js";
import { emptyRow } from "./empty-states.js";
import { STATUS_PILL_CLASS } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { overrideRenderStatusCard } from "./vehicle-detail.js";

/* ==================================================================
   REDESIGN ADDITIONS -- details drawer, status picker, concern preview,
   backup/restore modal. Purely additive: wraps/observes the existing
   render functions above rather than changing them, so none of the real
   data flow above this line needs to change.
   ================================================================== */
// Class-driven dot color: reading getComputedStyle off the display:none pill
// forced a style recalc on every render and broke the moment the pill's
// classes changed.
const STATUS_DOT_COLOR = {
  "pill-status-estimate": "var(--ink-faint)", "pill-status-pending": "var(--warn)",
  "pill-status-progress": "var(--accent)", "pill-status-complete": "var(--good)",
};
export function wireDrawer() {
  overrideRenderStatusCard((orig) => function (order) {
    orig(order);
    const pillEl = $("#vd-status-pill");
    const picker = $("#vd-status-picker");
    const assignPicker = $("#vd-assign-picker");
    const dot = $(".status-picker-dot", picker || document);
    if (pillEl && picker) {
      const text = pillEl.textContent.trim();
      picker.style.display = text ? "" : "none";
      if (assignPicker) assignPicker.style.display = text ? "" : "none";
      if (dot) dot.style.background = STATUS_DOT_COLOR[STATUS_PILL_CLASS[order.status]] || "var(--accent)";
    }
    const concernBox = $("#vd-concern");
    const previewWrap = $("#vd-concern-preview");
    const previewText = $("#vd-concern-preview-text");
    if (concernBox && previewWrap && previewText) {
      const val = concernBox.value.trim();
      previewWrap.style.display = val ? "" : "none";
      previewText.textContent = val;
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Details drawer: collapsible, remembers open/closed like the theme does.
    // A single handle sits on the drawer's edge at all times -- its chevron
    // flips direction to show which way it'll swing, instead of a close-only
    // "x" that disappears once collapsed.
    //
    // The preference is remembered *per width bucket*, not globally. Below
    // 1240px the drawer takes enough room out of the detail shell that the
    // Parts & Labor grid drops into its stacked card layout -- so a window
    // that was once maximised (drawer open, plenty of room) shouldn't drag
    // that choice down with it when it's resized to sit beside another app.
    // Wide defaults to open, narrow defaults to closed, and each remembers
    // what you last did *at that size*; crossing the threshold re-applies the
    // bucket you just entered rather than leaving the other one's choice on.
    const drawer = $("#vd-details-drawer");
    const handle = $("#vd-details-handle");
    // matchMedia is missing in a couple of embedded WebViews (and in the test
    // harness); falling back to "never narrow" keeps the old single-preference
    // behaviour rather than throwing halfway through wiring the page.
    const DRAWER_NARROW = typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 1240px)")
      : { matches: false };
    const drawerKey = () => (DRAWER_NARROW.matches ? "dao-details-open-narrow" : "dao-details-open");
    function setDrawerOpen(open, remember = true) {
      if (!drawer || !handle) return;
      drawer.classList.toggle("closed", !open);
      handle.classList.toggle("closed", !open);
      if (remember) localStorage.setItem(drawerKey(), open ? "1" : "0");
    }
    function applyDrawerPreference() {
      const saved = localStorage.getItem(drawerKey());
      setDrawerOpen(saved === null ? !DRAWER_NARROW.matches : saved === "1", false);
    }
    if (drawer && handle) {
      applyDrawerPreference();
      handle.addEventListener("click", () => setDrawerOpen(drawer.classList.contains("closed")));
      // addListener is the pre-2019 spelling; the app-mode window is whatever
      // WebView the machine has, so keep the fallback.
      if (DRAWER_NARROW.addEventListener) DRAWER_NARROW.addEventListener("change", applyDrawerPreference);
      else if (DRAWER_NARROW.addListener) DRAWER_NARROW.addListener(applyDrawerPreference);
    }

    // Assign picker popover (technician/advisor) -- reveals the real
    // select+save controls without keeping them inline in their own card.
    const assignToggle = $("#vd-assign-picker-toggle");
    const assignMenu = $("#vd-assign-picker-menu");
    if (assignToggle && assignMenu) {
      assignToggle.setAttribute("aria-haspopup", "true");
      assignToggle.setAttribute("aria-expanded", "false");
      assignToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = assignMenu.classList.toggle("open");
        assignToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", (e) => {
        if (!e.target.closest(".status-picker")) {
          assignMenu.classList.remove("open");
          assignToggle.setAttribute("aria-expanded", "false");
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && assignMenu.classList.contains("open")) {
          assignMenu.classList.remove("open");
          assignToggle.setAttribute("aria-expanded", "false");
          assignToggle.focus();
        }
      });
    }

    // Every dialog closes on backdrop click -- the .modal child is the click
    // surface, so a click landing on the <dialog> itself is the backdrop.
    $$("dialog").forEach((d) => d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    }));
  });
}

function fmtBackupSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  // 0 stays 0 -- rounding a truncated backup up to "1 KB" hides exactly the
  // corruption this column exists to reveal.
  return `${Math.round(bytes / 1024)} KB`;
}

// A toast fired right before location.reload() dies with the page. Stash a
// one-shot flash (and which view to land on) for the boot code to replay.
function flashAfterReload(message, view) {
  try {
    sessionStorage.setItem("dao-flash", JSON.stringify({ message, view }));
  } catch {}
}

function backupFriendlyLabel(b) {
  const stamp = b.modified_at * 1000;
  const d = new Date(stamp);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + `, ${time}`;
}

// The page's first job is answering "am I actually protected right now?" --
// four tiles derived from the same payload as the table, plus the status
// endpoint's word on whether anything is running the auto-backup loop.
function renderBackupStats(backups, status) {
  const box = $("#backup-stats");
  if (!box) return;
  const newest = backups[0];
  const intervalMinutes = status?.interval_minutes ?? 5;
  // status.last_age_hours is the server's own computation off the same
  // files this page lists -- prefer it over recomputing client-side, and
  // fall back only if the /status fetch itself failed.
  const ageHours = status?.last_age_hours ?? (newest ? (Date.now() / 1000 - newest.modified_at) / 3600 : null);
  /* Health is about unsaved work, not about age. The auto-backup loop skips
     snapshots that would be byte-identical, so on a quiet night the newest
     backup legitimately gets old while protection stays perfect -- judging by
     age alone would cry "Stale" every morning and train everyone to ignore
     the strip. `pending_changes` is the server's direct answer to "is there
     anything not backed up yet", and only once something *is* pending does
     how long it's been pending start to matter. */
  const pending = status ? !!status.pending_changes : true;
  const graceHours = Math.max(0.5, (intervalMinutes * 4) / 60);
  const tone = ageHours == null ? "crit"
    : !pending ? ""
    : ageHours > graceHours * 4 ? "crit"
    : ageHours > graceHours ? "warn" : "";
  const ageTone = tone;
  const health = ageHours == null ? "None"
    : !pending ? "Healthy"
    : tone === "crit" ? "Stale" : tone === "warn" ? "Aging" : "Healthy";
  const healthSub = ageHours == null ? "take one now"
    : !pending ? "everything is backed up"
    : tone ? "changes are waiting to be backed up" : "changes will be picked up shortly";
  const totalBytes = backups.reduce((s, b) => s + b.size_bytes, 0);
  const autoOn = !!status?.auto_enabled;
  box.innerHTML = `
    <div class="stat">
      <div class="stat-label">Last Backup</div>
      <div class="stat-value${ageTone ? ` ${ageTone}` : ""}">${newest ? esc(relativeTime(newest.modified_at * 1000)) : "never"}</div>
      <div class="stat-sub">${newest ? esc(fmtDate(newest.modified_at * 1000)) : "no backup exists yet"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Protection</div>
      <div class="stat-value${ageTone ? ` ${ageTone}` : ""}">${health}</div>
      <div class="stat-sub">${healthSub}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Auto-Backup</div>
      <div class="stat-value${autoOn ? "" : " warn"}">${autoOn ? "On" : "Off"}</div>
      <div class="stat-sub">${autoOn ? `checks every ${intervalMinutes} min` : "click Create Backup Now instead"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Backups Kept</div>
      <div class="stat-value">${backups.length}</div>
      <div class="stat-sub">${esc(retentionSummary(status))}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Size</div>
      <div class="stat-value num">${fmtBackupSize(totalBytes)}</div>
      <div class="stat-sub">${status?.backups_dir ? `in ${esc(status.backups_dir)}` : "on this machine"}</div>
    </div>`;

  // The header copy promises automatic backups; if nothing in this process
  // is running the loop, that promise is false -- say so where it matters.
  const warning = $("#backup-auto-warning");
  if (warning) {
    if (status && !status.auto_enabled) {
      warning.textContent = "Automatic backups are not running in this session — backups only happen when you click Create Backup Now.";
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }
  }

  // The policy sentence used to hardcode "24 hours"/"14" -- if either
  // constant is ever tuned, this kept the page quietly lying about the
  // real policy. Now it reads the same status payload the cards do.
  const policyDesc = $("#backup-policy-desc");
  if (policyDesc && status) {
    policyDesc.textContent = `A full database backup (.db) is made automatically every ${intervalMinutes} minutes when something has changed, and older ones thin out over time — ${retentionSummary(status)}. Make one manually any time, and download, restore, or delete any backup below.`;
  }
}

/* Retention is no longer a single number, because a flat cap and a short
   interval destroy each other: keeping "the newest 14" at one snapshot every
   five minutes means the whole backup history is the last 70 minutes. The
   tiers keep recent work dense and let older history thin out, so this
   describes them in the shop's words rather than showing a count. */
function retentionSummary(status) {
  const r = status?.retention;
  if (!r) return "older ones are pruned";
  return `every snapshot for ${r.every_snapshot_hours}h, hourly for ${r.hourly_hours}h, `
    + `daily for ${r.daily_days} days, monthly for ${r.monthly_months} months`;
}

export async function loadBackupView() {
  const tbody = $("#backup-table");
  if (!tbody) return;
  let backups;
  try {
    backups = await get("/api/backup");
  } catch (err) {
    renderViewFailure("backup", err);
    return;
  }
  const status = await get("/api/backup/status").catch(() => null);
  renderBackupStats(backups, status);
  tbody.innerHTML = backups.length ? backups.map((b, i) => `
    <tr>
      <td>
        <div class="backup-name-main">${esc(backupFriendlyLabel(b))} ${i === 0 ? `<span class="pill pill-done">Newest</span>` : ""}</div>
        <div class="backup-name-file">${esc(b.name)}</div>
      </td>
      <td class="num-col${b.size_bytes === 0 ? " backup-size-zero" : ""}" ${b.size_bytes === 0 ? 'title="Zero bytes — this backup may be corrupt"' : ""}>${fmtBackupSize(b.size_bytes)}</td>
      <td>${fmtDate(b.modified_at * 1000)}</td>
      <td class="actions-col"><div class="row-actions">
        <a class="btn btn-ghost btn-sm" href="/api/backup/download/${encodeURIComponent(b.name)}" download aria-label="Download ${esc(b.name)}">Download</a>
        <button type="button" class="btn btn-ghost btn-sm btn-warn-ghost backup-restore-btn" data-name="${esc(b.name)}" aria-label="Restore from ${esc(b.name)}">Restore</button>
        <button type="button" class="btn btn-ghost btn-sm btn-danger-ghost backup-delete-btn" data-name="${esc(b.name)}" aria-label="Delete ${esc(b.name)}">Delete</button>
      </div></td>
    </tr>
  `).join("") : emptyRow(4, {
    icon: "backup",
    title: "No backup has been taken yet",
    hint: "Take one now — it only takes a moment.",
    actions: `<button type="button" class="btn btn-primary btn-sm" data-empty-action="run-backup">Create Backup Now</button>`,
  });
  $$(".backup-restore-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      const entry = backups.find((b) => b.name === name);
      if (!(await confirmAction({
        eyebrow: "RESTORE",
        title: `Restore from "${name}"?`,
        body: `${entry ? `${backupFriendlyLabel(entry)} · ${fmtBackupSize(entry.size_bytes)}. ` : ""}This replaces the live database with the contents of that backup. The current database is saved aside first (as a pre-restore snapshot next to the live file), so the swap can be undone.`,
        confirmLabel: "Restore",
        danger: true,
      }))) return;
      await withLoading(btn, "Restoring…", async () => {
        try {
          await post(`/api/backup/restore/${encodeURIComponent(name)}`);
          flashAfterReload(`Restored from ${name}`, "backup");
          location.reload();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  });
  $$(".backup-delete-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      const isLast = backups.length === 1;
      if (!(await confirmAction({
        eyebrow: "BACKUP",
        title: `Delete backup "${name}"?`,
        body: isLast
          ? "This is your ONLY backup. Deleting it leaves the shop with no recovery point at all."
          : "The backup file is removed from disk. This can't be undone.",
        confirmLabel: "Delete Backup",
        danger: true,
      }))) return;
      await withLoading(btn, "Deleting…", async () => {
        try {
          await api(`/api/backup/${encodeURIComponent(name)}`, { method: "DELETE" });
          toast("Backup deleted");
          await loadBackupView();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  });
}

export function wireBackupView() {
  const runBackup = async (btn) => {
    const exec = async () => {
      try {
        const created = await post("/api/backup/run");
        toast(`Backup created: ${created.name}`);
        await loadBackupView();
      } catch (err) {
        toast(err.message, true);
      }
    };
    // A second impatient click would create a redundant backup and prune a
    // real one out of retention -- the busy state prevents it.
    if (btn) await withLoading(btn, "Backing up…", exec);
    else await exec();
  };
  $("#backup-run-btn")?.addEventListener("click", (e) => runBackup(e.currentTarget));
  // Same action offered from the empty state, which is re-rendered on every
  // load and so has to be delegated.
  $("#backup-table")?.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-empty-action="run-backup"]');
    if (btn) runBackup(btn);
  });

  // Dropzone: the raw file input is visually hidden; the zone is the
  // affordance -- click to browse, or drop a file from a USB stick.
  const input = $("#backup-restore-file");
  const zone = $("#backup-dropzone");
  const submit = $("#backup-restore-submit");
  const showFile = () => {
    const file = input.files[0];
    if (!zone || !submit) return;
    if (file) {
      zone.classList.add("has-file");
      zone.innerHTML = `<span class="dropzone-file"><span>${esc(file.name)}</span><span class="dz-size">${fmtBackupSize(file.size)}</span></span>`;
      submit.disabled = false;
    } else {
      zone.classList.remove("has-file");
      zone.innerHTML = `<strong>Drop a .db backup here</strong> or click to choose a file`;
      submit.disabled = true;
    }
  };
  if (zone && input) {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    ["dragover", "dragenter"].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    }));
    zone.addEventListener("drop", (e) => {
      if (e.dataTransfer?.files?.length) {
        input.files = e.dataTransfer.files;
        showFile();
      }
    });
    input.addEventListener("change", showFile);
  }

  submit?.addEventListener("click", async () => {
    const file = input.files[0];
    if (!file) return toast("Choose a file first", true);
    if (!file.name.toLowerCase().endsWith(".db")) return toast("Choose a .db backup file", true);
    // Read the first 16 bytes and check SQLite's magic header -- an instant,
    // honest rejection beats uploading a renamed JPEG and learning from a
    // red toast after the server's integrity check.
    try {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const magic = "SQLite format 3";
      const looksSqlite = magic.split("").every((ch, i) => head[i] === ch.charCodeAt(0));
      if (!looksSqlite) {
        input.value = "";
        showFile();
        return toast("That file isn't a SQLite database — pick a real .db backup", true);
      }
    } catch { /* unreadable -> let the server's check decide */ }
    if (!(await confirmAction({
      eyebrow: "RESTORE",
      title: `Restore from "${file.name}"?`,
      body: `${fmtBackupSize(file.size)}. This replaces the live database with the contents of that file. The current database is saved aside first, so the swap can be undone.`,
      confirmLabel: "Restore",
      danger: true,
    }))) return;
    await withLoading(submit, "Restoring…", async () => {
      input.disabled = true;
      try {
        const res = await fetch("/api/backup/restore-upload", {
          method: "POST",
          headers: { "x-backup-filename": file.name },
          body: await file.arrayBuffer(),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || res.statusText);
        }
        flashAfterReload(`Restored from ${file.name}`, "backup");
        location.reload();
      } catch (err) {
        toast(err.message, true);
        input.value = "";
      } finally {
        input.disabled = false;
      }
    });
    // withLoading re-enables the button unconditionally; re-derive the real
    // state from whether a file is still selected.
    showFile();
  });
}
