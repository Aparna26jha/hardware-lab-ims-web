"use strict";

const SAMPLE_ACCOUNTS = [
  ["sa001@lab.example", "Lab@1001", "Super Admin"],
  ["ad010@lab.example", "Lab@2001", "Admin"],
  ["ld200@lab.example", "Lab@4001", "Lead (IPSi)"],
  ["en1042@lab.example", "Lab@3001", "Engineer"]
];

const UPDATE_SECONDS = 20;

const state = {
  settings: null,
  me: null,
  view: "login",
  tab: "dashboard",
  filters: { owner: "", status: "", type: "", team: "", search: "" },
  barcode: "",
  consignmentId: null,
  selectedUser: "",
  selectedTeam: null,
  flash: null,
  transferAsset: null,
  inwardFill: null,
  foundCodes: null,
  scrollTo: "",
  teams: [],
  pendingLead: "",
  updatesSince: "",
  seenUpdates: new Set()
};

// ---------- helpers ----------

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

async function api(method, url, body) {
  const options = { method, headers: { "X-IMS": "1" }, credentials: "same-origin" };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.view === "app") {
    state.me = null;
    state.view = "login";
    state.flash = { text: data.error || "Please sign in again.", kind: "bad" };
    paint();
  }
  if (!response.ok) throw new Error(data.error || "The server did not answer. Check the connection.");
  return data;
}

function val(id) {
  const node = document.getElementById(id);
  return node ? node.value : "";
}

function setVal(id, value) {
  const node = document.getElementById(id);
  if (node) node.value = value ?? "";
}

function fillIfEmpty(id, value) {
  const node = document.getElementById(id);
  if (node && !node.value && value) node.value = value;
}

function downloadCsv(name, rows) {
  const cell = (value) => {
    const text = String(value ?? "");
    return /^[=+\-@]/.test(text) ? `"'${text.replace(/"/g, '""')}"` : `"${text.replace(/"/g, '""')}"`;
  };
  const blob = new Blob(["\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function checked(id) {
  const node = document.getElementById(id);
  return !!node && node.checked;
}

// ---------- pop-up notifications ----------

const TOAST_TITLES = { good: "Done", bad: "Something needs fixing", warn: "Please check", info: "Update" };
const TOAST_ICONS = { good: "✓", bad: "!", warn: "!", info: "i" };
const TOAST_MAX = 5;

// A toast with a handover stays until the person accepts or rejects the item (or closes it).
function toast(text, kind = "info", title = "", go = "", handover = null) {
  const root = document.getElementById("toast-root");
  if (!root || !text) return;
  const node = document.createElement("div");
  const type = TOAST_TITLES[kind] ? kind : "info";
  node.className = "toast " + type + (go ? " clickable" : "") + (handover ? " sticky" : "");
  node.setAttribute("role", type === "bad" ? "alert" : "status");
  if (go) node.dataset.go = go;
  const buttons = handover ? `<div class="toast-actions">
      <button class="btn small" type="button" data-action="accept-handover" data-id="${handover.id}">Accept</button>
      <button class="btn danger small" type="button" data-action="decline-handover-ask" data-id="${handover.id}" data-barcode="${esc(handover.barcode)}">Reject</button>
    </div>` : "";
  node.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type]}</span>
    <div class="toast-body"><strong>${esc(title || TOAST_TITLES[type])}</strong><span>${esc(text)}</span>${buttons}</div>
    <button class="toast-close" type="button" aria-label="Close">×</button>${handover ? "" : `<span class="toast-timer ${type}"></span>`}`;
  root.prepend(node);
  while (root.children.length > TOAST_MAX) root.lastElementChild.remove();
  const close = () => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 250);
  };
  node.querySelector(".toast-close").addEventListener("click", (event) => { event.stopPropagation(); close(); });
  node.addEventListener("click", (event) => {
    if (event.target.closest("[data-action]")) {
      if (event.target.closest("[data-action='accept-handover']")) close();
      return;
    }
    if (node.dataset.go && state.view === "app") go(node.dataset.go);
    close();
  });
  if (!handover) setTimeout(close, type === "bad" ? 9000 : 6000);
}

function closeHandoverToasts(id) {
  document.querySelectorAll(`.toast [data-id="${id}"]`).forEach((button) => button.closest(".toast").remove());
}

async function showWaitingHandovers() {
  try {
    const waiting = await api("GET", "/api/handovers/mine");
    for (const h of waiting.slice(0, 3)) {
      const key = "ho-new-" + h.id;
      if (state.seenUpdates.has(key)) continue;
      state.seenUpdates.add(key);
      toast(h.givenBy + " is giving you " + h.barcode + " (" + h.item + "). Accept it when you have it in hand.",
        "info", "Item waiting for you", "dashboard", { id: h.id, barcode: h.barcode });
    }
  } catch {
    // The dashboard still lists them.
  }
}

function flash(text, kind) {
  if (state.view === "app") {
    toast(text, kind);
    return;
  }
  state.flash = { text, kind };
  const node = document.getElementById("flash");
  if (node) {
    node.textContent = text;
    node.className = "status " + (kind || "");
  }
}

function flashHtml() {
  const f = state.flash || { text: "", kind: "" };
  return `<div id="flash" class="status ${esc(f.kind)}" role="status">${esc(f.text)}</div>`;
}

async function checkUpdates() {
  if (state.view !== "app" || document.visibilityState !== "visible") return;
  try {
    const data = await api("GET", "/api/updates?since=" + encodeURIComponent(state.updatesSince));
    state.updatesSince = data.now;
    const fresh = data.items.filter((item) => !state.seenUpdates.has(item.key));
    fresh.forEach((item) => state.seenUpdates.add(item.key));
    fresh.slice(0, 4).forEach((item) => toast(item.text, item.kind, item.title, item.go,
      item.handoverId ? { id: item.handoverId, barcode: item.barcode } : null));
    if (fresh.length > 4) toast((fresh.length - 4) + " more updates. Open the Dashboard to see them.", "info", "More updates", "dashboard");
  } catch {
    // The next check tries again.
  }
}

// ---------- dropdowns that can grow ----------

const ADD_LABELS = {
  assetType: "+ Add a new asset type…",
  room: "+ Add a new storage room…",
  team: "+ Add a new team…"
};

function options(list, selected, blankLabel) {
  const blank = blankLabel !== undefined ? `<option value="">${esc(blankLabel)}</option>` : "";
  return blank + list.map((item) => {
    const [value, label] = Array.isArray(item) ? item : [item, item];
    return `<option value="${esc(value)}"${String(value) === String(selected ?? "") ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
}

function listItems(list) {
  if (list === "assetType") return state.settings.assetTypes;
  if (list === "room") return state.settings.rooms;
  return state.teams.map((t) => [String(t.id), t.name]);
}

// A dropdown whose last option lets the person add a new value on the spot.
function addableSelect(id, list, selected, blankLabel) {
  return `<select id="${id}" data-add-list="${list}" data-blank="${esc(blankLabel ?? "")}" data-prev="${esc(selected ?? "")}">
      ${options(listItems(list), selected, blankLabel)}<option value="__add__">${esc(ADD_LABELS[list])}</option></select>
    <div class="add-inline hidden" id="${id}-add">
      <input id="${id}-new" maxlength="${list === "team" ? 80 : 40}" placeholder="Type the new name" data-add-for="${id}">
      <button class="btn small" type="button" data-action="add-choice" data-for="${id}">Add</button>
      <button class="btn secondary small" type="button" data-action="cancel-choice" data-for="${id}">Cancel</button>
    </div>`;
}

function refreshAddableSelects(list, pickFor, pickValue) {
  document.querySelectorAll(`select[data-add-list="${list}"]`).forEach((select) => {
    const value = select.id === pickFor ? pickValue : select.value === "__add__" ? select.dataset.prev : select.value;
    select.innerHTML = options(listItems(list), value, select.dataset.blank || undefined)
      + `<option value="__add__">${esc(ADD_LABELS[list])}</option>`;
    select.dataset.prev = value;
  });
}

async function addChoice(selectId) {
  const select = document.getElementById(selectId);
  const list = select.dataset.addList;
  const value = val(selectId + "-new").trim();
  if (!value) throw new Error("Type the new name first.");
  if (list === "team") {
    const result = await api("POST", "/api/teams", { name: value });
    state.teams = await api("GET", "/api/teams");
    refreshAddableSelects(list, selectId, String(result.id));
    toast(result.message, "good", "Team added");
  } else {
    const result = await api("POST", "/api/choices", { list, value });
    state.settings.assetTypes = result.assetTypes;
    state.settings.rooms = result.rooms;
    refreshAddableSelects(list, selectId, result.value);
    toast(result.message, "good", "Added to the list");
  }
  document.getElementById(selectId + "-add").classList.add("hidden");
}

function cancelChoice(selectId) {
  const select = document.getElementById(selectId);
  select.value = select.dataset.prev || "";
  document.getElementById(selectId + "-add").classList.add("hidden");
}

// ---------- small pieces ----------

function ownerPill(value) {
  return `<span class="pill ${value === "Wipro-Specific" ? "wipro" : "amd"}">${esc(value)}</span>`;
}

function expiryPill(asset) {
  if (asset.expiry === "expired") return ' <span class="pill bad">Expired</span>';
  if (asset.expiry === "soon") return ' <span class="pill warn">Expiring</span>';
  return "";
}

function pendingPill(asset) {
  return asset.pending ? ` <span class="pill warn" title="${esc(asset.pending.email)}">Waiting for ${esc(asset.pending.name)} to accept</span>` : "";
}

function personHtml(name, email) {
  if (!name && !email) return "-";
  return esc(name || email) + (email && name ? `<br><span class="fine">${esc(email)}</span>` : "");
}

function when(raw) {
  return String(raw || "").replace("T", " ").slice(0, 16);
}

function isCustodian() {
  return !!state.me && (state.me.role === "Admin" || state.me.role === "Super Admin");
}

function isSuper() {
  return !!state.me && state.me.role === "Super Admin";
}

function iconButtons(barcode) {
  if (!isCustodian()) return "";
  return `<span class="icons">
    <button class="icon-btn" type="button" data-action="edit-asset" data-barcode="${esc(barcode)}" title="Edit ${esc(barcode)}" aria-label="Edit ${esc(barcode)}">✏️</button>
    ${isSuper() ? `<button class="icon-btn" type="button" data-action="delete-asset" data-barcode="${esc(barcode)}" title="Delete ${esc(barcode)}" aria-label="Delete ${esc(barcode)}">🗑️</button>` : ""}
  </span>`;
}

function readFile(inputId, maxMegabytes) {
  const input = document.getElementById(inputId);
  const file = input && input.files && input.files[0];
  if (!file) return Promise.resolve(null);
  if (file.size > maxMegabytes * 1024 * 1024) return Promise.reject(new Error("The file is larger than " + maxMegabytes + " MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] || "" });
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function peopleList(people) {
  return `<datalist id="people-list">${people.map((p) =>
    `<option value="${esc(p.email)}">${esc(p.name + (p.teamName ? " · " + p.teamName : ""))}</option>`).join("")}</datalist>`;
}

function tabsFor() {
  const tabs = [["dashboard", "Dashboard"]];
  if (isCustodian()) tabs.push(["inward", "Inward"], ["transfer", "Transfer"]);
  tabs.push(["requests", "Requests"]);
  if (isSuper()) tabs.push(["accounts", "Accounts"], ["teams", "Teams"], ["deleted", "Delete history"]);
  if (isCustodian()) tabs.push(["feedback", "Feedback received"]);
  tabs.push(["account", "My account"]);
  return tabs;
}

function roleHint() {
  const role = state.me.role;
  if (role === "User") return "Engineer view: the hardware assigned to you.";
  if (role === "Lead Admin") return "Lead view: hardware held by you and your team, plus what is free in the cage.";
  if (role === "Super Admin") return "Super Admin: everything, plus accounts, teams, delete and backup.";
  return "Inventory custodian: inward, transfer and the full lab list.";
}

// ---------- screens ----------

let paintCount = 0;

async function paint() {
  const root = document.getElementById("app");
  const mine = ++paintCount;
  if (state.view === "login") root.innerHTML = loginHtml();
  else if (state.view === "register") root.innerHTML = registerHtml();
  else if (state.view === "first-password") root.innerHTML = firstPasswordHtml();
  else {
    if (state.flash) {
      toast(state.flash.text, state.flash.kind);
      state.flash = null;
    }
    root.innerHTML = shellHtml(`<p class="sub">Loading...</p>`);
    let body;
    try {
      body = await tabHtml();
    } catch (error) {
      body = `<p class="status bad">${esc(error.message)}</p>`;
    }
    // A newer screen was asked for while this one was loading.
    if (mine !== paintCount || state.view !== "app") return;
    root.innerHTML = shellHtml(body);
    afterPaint();
  }
}

function versionText() {
  const s = state.settings;
  return s ? "Hardware Lab IMS v" + s.version + " · " + s.environment : "";
}

function loginHtml() {
  const demo = state.settings && state.settings.showSampleAccounts ? `
    <div class="demo">${SAMPLE_ACCOUNTS.map(([email, password, label]) =>
      `<button type="button" data-action="fill-login" data-email="${esc(email)}" data-password="${esc(password)}">${esc(label)}</button>`).join("")}</div>
    <p class="fine">Development copy: the buttons above fill in sample accounts.</p>` : "";
  return `
    <div class="auth-screen"><section class="card">
      <div class="brand"><div class="mark">IMS</div><div><h1>Hardware Lab IMS</h1>
        <div class="sub">Sign in with your mail ID and password.</div></div></div>
      <form id="login-form" autocomplete="on">
        <label for="login-email">Mail ID</label>
        <input id="login-email" type="email" maxlength="120" autocomplete="username" placeholder="name@wipro.com" autofocus>
        <label for="login-password">Password</label>
        <input id="login-password" type="password" maxlength="64" autocomplete="current-password">
        <div class="row"><button class="btn" type="submit">Sign in</button>
          <button class="btn secondary" type="button" data-action="go-register">Request access</button></div>
      </form>
      ${flashHtml()}
      ${demo}
      <p class="fine">${esc(versionText())}</p>
      <p class="credit">Developed by <strong>Aparna Jha</strong></p>
    </section></div>`;
}

function firstPasswordHtml() {
  const min = state.settings ? state.settings.passwordMin : 8;
  return `
    <div class="auth-screen"><section class="card">
      <div class="brand"><div class="mark">IMS</div><div><h1>Choose your own password</h1>
        <div class="sub">Welcome, ${esc(state.me.name)}. You signed in with a first password. Choose your own before you start.</div></div></div>
      <form id="first-password-form" autocomplete="off">
        <label for="fp-current">First password (the one you were given) <span class="req">*</span></label>
        <input id="fp-current" type="password" maxlength="64" autocomplete="current-password">
        <label for="fp-next">New password (at least ${min} characters) <span class="req">*</span></label>
        <input id="fp-next" type="password" maxlength="64" autocomplete="new-password">
        <label for="fp-confirm">New password again <span class="req">*</span></label>
        <input id="fp-confirm" type="password" maxlength="64" autocomplete="new-password">
        <div class="row"><button class="btn" type="submit">Save and continue</button>
          <button class="btn secondary" type="button" data-action="logout">Sign out</button></div>
      </form>
      ${flashHtml()}
      <p class="fine">${esc(versionText())}</p>
    </section></div>`;
}

function registerHtml() {
  const s = state.settings || { roles: ["User"], passwordMin: 8 };
  const selfAdd = s.showSampleAccounts ? `
        <p class="fine">Not on the lab directory yet? Fill in your full name and Emp ID as well, and you will be added.</p>
        <label for="reg-name">Full name</label>
        <input id="reg-name" maxlength="120" autocomplete="name">
        <label for="reg-emp">Emp ID</label>
        <input id="reg-emp" maxlength="32">` : "";
  return `
    <div class="auth-screen"><section class="card">
      <div class="brand"><div class="mark">IMS</div><div><h1>Request access</h1>
        <div class="sub">Use the mail ID the Super Admin added to the lab directory.</div></div></div>
      <form id="register-form" autocomplete="off">
        <label for="reg-email">Mail ID <span class="req">*</span></label>
        <input id="reg-email" type="email" maxlength="120" placeholder="name@wipro.com" autocomplete="username">${selfAdd}
        <label for="reg-role">Role you need</label><select id="reg-role">${options(s.roles, "User")}</select>
        <label for="reg-password">Choose a password (at least ${s.passwordMin} characters) <span class="req">*</span></label>
        <input id="reg-password" type="password" maxlength="64" autocomplete="new-password">
        <label for="reg-confirm">Type the password again <span class="req">*</span></label>
        <input id="reg-confirm" type="password" maxlength="64" autocomplete="new-password">
        <div class="row"><button class="btn" type="submit">Send request</button>
          <button class="btn secondary" type="button" data-action="go-login">Back to sign in</button></div>
      </form>
      ${flashHtml()}
    </section></div>`;
}

function shellHtml(body) {
  const me = state.me;
  const env = state.settings && state.settings.environment !== "production"
    ? `<span class="env">${esc(state.settings.environment.toUpperCase())}</span>` : "";
  return `
    <header class="app"><div class="wrap">
      <div><h1>Hardware Lab IMS ${env}</h1><p>${esc(roleHint())}</p></div>
      <div class="who">
        <div><strong>${esc(me.name)}</strong><p>${esc(me.email)} · ${esc(me.role)}${me.teamName ? " · " + esc(me.teamName) : ""}</p></div>
        <button class="btn secondary small" type="button" data-action="open-feedback">Give feedback</button>
        <button class="btn secondary small" type="button" data-action="logout">Sign out</button>
      </div>
    </div></header>
    <main class="wrap">
      <nav class="tabs" aria-label="Screens">${tabsFor().map(([id, label]) =>
        `<button type="button" data-action="tab" data-tab="${id}" aria-selected="${state.tab === id || (state.tab === "asset" && id === "dashboard")}">${esc(label)}</button>`).join("")}</nav>
      <section class="panel">${body}</section>
      <footer class="version">${esc(versionText())}</footer>
    </main>`;
}

async function tabHtml() {
  switch (state.tab) {
    case "asset": return assetHtml();
    case "inward": return state.consignmentId ? consignmentHtml() : inwardHtml();
    case "transfer": return transferHtml();
    case "requests": return requestsHtml();
    case "accounts": return accountsHtml();
    case "teams": return teamsHtml();
    case "deleted": return deleteHistoryHtml();
    case "feedback": return feedbackHtml();
    case "account": return accountHtml();
    default: return dashboardHtml();
  }
}

function afterPaint() {
  const first = document.querySelector("[data-autofocus]");
  if (first) {
    first.focus();
    if (first.dataset.select !== undefined) first.select();
  }
  if (state.scrollTo) {
    const target = document.getElementById(state.scrollTo);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    state.scrollTo = "";
  }
}

// ---------- dashboard ----------

function filterQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
}

function handoverBox(handovers) {
  if (!handovers.length) return "";
  return `
    <div class="box accept-box" id="accept-box">
      <h3>Waiting for you to accept (${handovers.length})</h3>
      <p class="sub">Accept when you have the item in hand. It moves to your list only after you accept.</p>
      <ul>${handovers.map((h) => `<li>
        <div><b class="mono">${esc(h.barcode)}</b> · ${esc(h.item)} ${ownerPill(h.ownership)}<br>
          <span class="fine">From ${esc(h.fromName)} · offered by ${esc(h.givenBy)} on ${esc(when(h.createdAt))}${h.remarks ? " · " + esc(h.remarks) : ""}</span></div>
        <div class="row tight">
          <button class="btn small" type="button" data-action="accept-handover" data-id="${h.id}">Accept</button>
          <input id="ho-note-${h.id}" maxlength="300" placeholder="Reason, if you reject">
          <button class="btn danger small" type="button" data-action="decline-handover" data-id="${h.id}">Reject</button>
        </div></li>`).join("")}</ul>
    </div>`;
}

async function dashboardHtml() {
  const s = state.settings;
  const showTeams = state.me.role !== "User";
  const [dash, assets, teams] = await Promise.all([
    api("GET", "/api/dashboard"),
    api("GET", "/api/assets?" + filterQuery()),
    showTeams ? api("GET", "/api/teams") : Promise.resolve([])
  ]);
  const c = dash.counts;
  // [label, count, colour, ownership filter, status filter]
  const cards = [["Total", c.total, "", "", ""], ["Available", c.available, "", "", "Available in Lab"],
    ["Assigned", c.assigned, "", "", "Assigned to Engineer"], ["Under maintenance", c.maintenance, "", "", "Under Maintenance"],
    ["AMD-Specific", c.amd, "amd", "AMD-Specific", ""], ["Wipro-Specific", c.wipro, "wipro", "Wipro-Specific", ""]];
  const onlyCardFilters = !state.filters.type && !state.filters.team && !state.filters.search;
  const attention = dash.attention.length
    ? dash.attention.map((a) => `<li class="${a.kind === "bad" ? "bad" : ""}"><button type="button" data-action="attention" data-go="${esc(a.go || "")}" data-id="${esc(a.id || "")}" data-barcode="${esc(a.barcode || "")}">
        <span class="tag ${esc(a.kind)}">${esc(a.tag)}</span> ${esc(a.text)}</button></li>`).join("")
    : `<li>Nothing needs attention.</li>`;
  const activity = dash.activity
    ? `<div class="box"><h3>Recent activity</h3><ul>${dash.activity.length ? dash.activity.map((r) => `<li>
        <span class="mono">${esc(when(r.when))}</span> <b>${esc(r.barcode)}</b> ${esc(r.action)}:
        ${esc(r.action === "Transfer" ? r.from + " → " + r.to + " (" + r.toStatus + ")" : r.remarks)} · by ${esc(r.byName)}</li>`).join("")
        : "<li>No activity yet.</li>"}</ul></div>` : "";
  const teamTable = dash.teams ? `
    <h3>Assets by team</h3>
    <div class="scroll"><table><thead><tr><th>Team</th><th>Lead</th><th class="right">Items held</th><th class="right">AMD</th>
      <th class="right">Wipro</th><th class="right">Under maintenance</th></tr></thead><tbody>
      ${dash.teams.map((t) => `<tr class="clickable" data-action="team-filter" data-team="${esc(t.teamId)}">
        <td><b>${esc(t.team)}</b></td><td>${esc(t.lead)}</td><td class="right">${t.held}</td><td class="right">${t.amd}</td>
        <td class="right">${t.wipro}</td><td class="right">${t.maintenance}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="fine">Select a row to list that team's hardware below.</p>` : "";
  const teamChoices = [["cage", "In cage"], ...teams.map((t) => [String(t.id), t.name])];
  if (isCustodian()) teamChoices.push(["none", "No team"]);
  const f = state.filters;
  const exportLinks = `
    <a class="btn secondary small" href="/api/export/inventory.csv?${esc(filterQuery())}">Export list (CSV)</a>
    ${isCustodian() ? `<a class="btn secondary small" href="/api/export/audit.csv">Export audit (CSV)</a>` : ""}
    ${isSuper() ? `<button class="btn secondary small" type="button" data-action="backup">Back up now</button>
      <span class="fine">Last backup: ${esc(dash.lastBackup ? when(dash.lastBackup) : "none yet")}</span>` : ""}`;
  const actions = isCustodian();
  return `
    ${handoverBox(dash.handovers)}
    <div class="cards">${cards.map(([label, n, kind, owner, status]) => {
      const active = onlyCardFilters && state.filters.owner === owner && state.filters.status === status;
      return `<button type="button" class="kpi ${kind}" data-action="card-filter" data-owner="${esc(owner)}" data-status="${esc(status)}"
        aria-pressed="${active}" title="Show these items in the hardware list"><strong>${n}</strong><span>${esc(label)}</span></button>`;
    }).join("")}</div>
    <div class="duo ${dash.activity ? "" : "single"}">
      <div class="box"><h3>Needs your attention</h3><ul>${attention}</ul>
        <p class="fine">Red lines need action first. Expiry warnings start ${s.expiryWarnMonths} months before the expiry date.</p></div>
      ${activity}
    </div>
    ${teamTable}
    <h3 id="hardware-list">Hardware list</h3>
    <form id="filter-form" class="filters">
      <div><label for="f-owner">Ownership</label><select id="f-owner" data-filter>${options(s.owners, f.owner, "All")}</select></div>
      <div><label for="f-status">Status</label><select id="f-status" data-filter>${options(s.statuses, f.status, "All")}</select></div>
      <div><label for="f-type">Type</label><select id="f-type" data-filter>${options(s.assetTypes, f.type, "All")}</select></div>
      <div><label for="f-team">Team</label><select id="f-team" data-filter ${showTeams ? "" : "disabled"}>${options(teamChoices, f.team, "All")}</select></div>
      <div><label for="f-search">Search</label><input id="f-search" value="${esc(f.search)}" placeholder="Barcode, serial, model, person, mail ID, invoice"></div>
      <div><button class="btn" type="submit">Search</button></div>
    </form>
    <div class="row">${exportLinks}</div>
    <p class="sub">${assets.length} item(s). Select a barcode to see details${actions ? ", or use ✏️ to edit" + (isSuper() ? " and 🗑️ to delete" : "") : ""}.</p>
    <div class="scroll"><table><thead><tr><th>Barcode</th><th>Ownership</th><th>Type</th><th>Model</th><th>Serial</th>
      <th>Status</th><th>Holder</th><th>Team</th><th>Location</th>${actions ? "<th>Actions</th>" : ""}</tr></thead><tbody>
      ${assets.map((a) => `<tr>
        <td><button class="linkish mono" type="button" data-action="open-asset" data-barcode="${esc(a.barcode)}">${esc(a.barcode)}</button></td>
        <td>${ownerPill(a.ownership)}</td><td>${esc(a.assetType)}</td><td>${esc(a.model)}</td><td class="mono">${esc(a.serialNo)}</td>
        <td>${esc(a.status)}${expiryPill(a)}${pendingPill(a)}</td>
        <td>${a.holderId ? personHtml(a.holderName, a.holderEmail) : "-"}</td>
        <td>${esc(a.teamName)}</td><td>${esc(a.place)}</td>${actions ? `<td>${iconButtons(a.barcode)}</td>` : ""}</tr>`).join("")
        || `<tr><td colspan="${actions ? 10 : 9}">No hardware matches.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- asset details ----------

function detailsFormHtml(prefix, a, fixedOwnership) {
  const s = state.settings;
  return `
    <div class="grid3">
      ${fixedOwnership ? "" : `<div><label for="${prefix}-owner">Ownership <span class="req">*</span></label>
        <select id="${prefix}-owner">${options(s.owners, a.ownership)}</select></div>`}
      <div><label for="${prefix}-type">Asset type <span class="req">*</span></label>${addableSelect(prefix + "-type", "assetType", a.assetType, "Choose")}</div>
      <div><label for="${prefix}-model">Model</label><input id="${prefix}-model" maxlength="80" value="${esc(a.model)}"></div>
      <div><label for="${prefix}-make">Make</label><input id="${prefix}-make" maxlength="80" value="${esc(a.make)}"></div>
      <div><label for="${prefix}-mfr">Manufacturer</label><input id="${prefix}-mfr" maxlength="80" value="${esc(a.manufacturer)}"></div>
      <div><label for="${prefix}-serial">Manufacturer serial no.</label><input id="${prefix}-serial" maxlength="80" value="${esc(a.serialNo)}"></div>
      <div><label for="${prefix}-rev">Capacity / revision</label><input id="${prefix}-rev" maxlength="80" value="${esc(a.capacityRev)}"></div>
      <div><label for="${prefix}-room">Storage room <span class="req">*</span></label>${addableSelect(prefix + "-room", "room", a.room, "Choose")}</div>
      <div><label for="${prefix}-location">Cupboard / shelf (for example CPU cupboard 3)</label><input id="${prefix}-location" maxlength="80" value="${esc(a.location)}"></div>
      <div><label for="${prefix}-bond">Bond No. (from the AMD label)</label><input id="${prefix}-bond" maxlength="40" value="${esc(a.bondNo)}" placeholder="For example 266/2026-27 or NA"></div>
      <div><label for="${prefix}-expiry">Expiry date (optional)</label><input id="${prefix}-expiry" type="date" value="${esc(a.expiryDate)}"></div>
      <div class="span-3"><label for="${prefix}-desc">Description (the text printed on the label)</label><input id="${prefix}-desc" maxlength="500" value="${esc(a.description)}"></div>
    </div>`;
}

function readDetails(prefix) {
  const details = {
    ownership: val(prefix + "-owner"),
    assetType: val(prefix + "-type"),
    model: val(prefix + "-model"),
    make: val(prefix + "-make"),
    manufacturer: val(prefix + "-mfr"),
    serialNo: val(prefix + "-serial"),
    capacityRev: val(prefix + "-rev"),
    room: val(prefix + "-room"),
    location: val(prefix + "-location"),
    bondNo: val(prefix + "-bond"),
    expiryDate: val(prefix + "-expiry"),
    description: val(prefix + "-desc")
  };
  if (!details.assetType || details.assetType === "__add__") throw new Error("Choose an asset type, or add a new one.");
  if (!details.room || details.room === "__add__") throw new Error("Choose a storage room: pick at least one option, or add a new one.");
  return details;
}

function historyTable(rows) {
  if (!rows.length) return `<p class="sub">No history yet.</p>`;
  return `<div class="scroll"><table><thead><tr><th>When</th><th>Action</th><th>From</th><th>To</th><th>Status</th><th>By</th><th>Remarks</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono">${esc(when(r.when))}</td><td>${esc(r.action)}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td>
      <td>${esc(r.fromStatus && r.fromStatus !== r.toStatus ? r.fromStatus + " → " + r.toStatus : r.toStatus)}</td>
      <td>${esc(r.by)}</td><td>${esc(r.remarks)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function assetHtml() {
  const { asset: a, history } = await api("GET", "/api/assets/" + encodeURIComponent(state.barcode));
  const rows = [["Ownership", ownerPill(a.ownership)], ["Type", esc(a.assetType)], ["Model", esc(a.model)],
    ["Make / manufacturer", esc([a.make, a.manufacturer].filter(Boolean).join(" / "))], ["Serial no.", esc(a.serialNo)],
    ["Capacity / revision", esc(a.capacityRev)], ["Description", esc(a.description)],
    ["Status", esc(a.status) + expiryPill(a)],
    ["Holder", a.holderId ? personHtml(a.holderName, a.holderEmail) : "Nobody (in the cage)"],
    ["Team", esc(a.teamName)], ["Where now", esc(a.place)],
    ["Kept in (when free)", esc([a.room, a.location].filter(Boolean).join(", "))], ["Expiry date", esc(a.expiryDate || "Not set")],
    ["Invoice / PO", esc([a.invoiceNo, a.poNumber].filter(Boolean).join(" / "))], ["Bond No.", esc(a.bondNo)],
    ["Arrived", esc(a.arrivalDate)]];
  if (a.pending) {
    rows.push(["Offered to", personHtml(a.pending.name, a.pending.email) + ` <span class="pill warn">Waiting for them to accept</span>`
      + (isCustodian() ? ` <button class="btn secondary small" type="button" data-action="cancel-handover" data-id="${a.pending.id}">Cancel the offer</button>` : "")]);
  }
  let html = `
    <div class="row"><button class="btn secondary small" type="button" data-action="tab" data-tab="dashboard">← Back to the list</button></div>
    <h2 class="mono">${esc(a.barcode)}</h2>
    <dl class="details">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v || "-"}</dd>`).join("")}</dl>`;
  if (isCustodian()) {
    html += `
      <h3 id="edit-heading">✏️ Edit details</h3>
      <form id="edit-form" data-revision="${a.revision}" data-barcode="${esc(a.barcode)}">
        ${detailsFormHtml("ed", a, false)}
        <div class="row"><button class="btn" type="submit">Save details</button>
          <button class="btn secondary" type="button" data-action="transfer-this" data-barcode="${esc(a.barcode)}">Transfer this item</button></div>
      </form>
      <h3>History</h3>${historyTable(history)}`;
  }
  if (a.holderId === state.me.empId) {
    html += `<div class="row"><button class="btn secondary" type="button" data-action="ask-return" data-barcode="${esc(a.barcode)}">Ask to return this item</button></div>`;
  }
  if (isSuper()) {
    html += `
      <h3 id="delete-heading">🗑️ Delete (Super Admin only)</h3>
      <p class="sub">The item is hidden from every list and the deletion goes into Delete history, where it can be restored.</p>
      <form id="delete-form" data-barcode="${esc(a.barcode)}" class="grid">
        <div><label for="del-reason">Reason <span class="req">*</span></label><input id="del-reason" maxlength="300" placeholder="For example: entered twice by mistake"></div>
        <div><label>&nbsp;</label><button class="btn danger" type="submit">Delete ${esc(a.barcode)}</button></div>
      </form>`;
  }
  return html;
}

function openDeleteModal(barcode) {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-back" data-action="close-modal-back"><div class="modal" role="dialog" aria-label="Delete ${esc(barcode)}">
      <h2>🗑️ Delete ${esc(barcode)}</h2>
      <p class="sub">The item is hidden from every list. The deletion goes into Delete history, where a Super Admin can restore it.</p>
      <form id="delete-modal-form" data-barcode="${esc(barcode)}">
        <label for="dm-reason">Reason <span class="req">*</span></label>
        <input id="dm-reason" maxlength="300" placeholder="For example: entered twice by mistake">
        <div class="row"><button class="btn danger" type="submit">Delete</button>
          <button class="btn secondary" type="button" data-action="close-modal">Cancel</button></div>
      </form></div></div>`;
  document.getElementById("dm-reason").focus();
}

// ---------- inward (consignments) ----------

async function inwardHtml() {
  const s = state.settings;
  const list = await api("GET", "/api/consignments");
  const today = new Date().toISOString().slice(0, 10);
  return `
    <h2>Inward by consignment</h2>
    <p class="sub">Step 1: record the package (invoice, PO, date, number of items). Step 2: upload the scanned documents. Step 3: scan each item, or let the barcodes be read from the uploaded document.</p>
    <div class="duo wide-left">
      <div>
        <h3>Consignments</h3>
        <div class="scroll"><table><thead><tr><th>Invoice</th><th>PO</th><th>Arrived</th><th>Items</th><th>Documents</th><th>Ownership</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr class="clickable ${c.documentCount ? "" : "bad-row"}" data-action="open-consignment" data-id="${c.id}">
          <td><b>${esc(c.invoiceNo)}</b></td><td>${esc(c.poNumber)}</td><td>${esc(c.receivedDate)}</td>
          <td>${c.scannedItems} of ${c.expectedItems} ${c.scannedItems >= c.expectedItems ? '<span class="pill ok">Done</span>' : '<span class="pill warn">Open</span>'}</td>
          <td>${c.documentCount ? c.documentCount : '<span class="pill bad">No document</span>'}</td><td>${ownerPill(c.ownership)}</td>
          <td><button class="icon-btn" type="button" data-action="edit-consignment" data-id="${c.id}" title="Edit ${esc(c.invoiceNo)}" aria-label="Edit ${esc(c.invoiceNo)}">✏️</button></td></tr>`).join("")
          || `<tr><td colspan="7">No consignments yet.</td></tr>`}
        </tbody></table></div>
        <p class="fine">Red rows have no document uploaded yet.</p>
      </div>
      <form id="consignment-form" class="box">
        <h3>New consignment</h3>
        <label for="cn-invoice">Invoice number <span class="req">*</span></label><input id="cn-invoice" maxlength="64" data-autofocus>
        <label for="cn-po">PO number <span class="req">*</span></label><input id="cn-po" maxlength="64">
        <div class="grid">
          <div><label for="cn-date">Date received <span class="req">*</span></label><input id="cn-date" type="date" value="${today}"></div>
          <div><label for="cn-count">Number of items <span class="req">*</span></label><input id="cn-count" type="number" min="1" max="1000" value="1"></div>
        </div>
        <label for="cn-owner">Ownership <span class="req">*</span></label><select id="cn-owner">${options(s.owners, "", "Choose")}</select>
        <label for="cn-supplier">Supplier</label><input id="cn-supplier" maxlength="120">
        <label for="cn-remarks">Remarks</label><input id="cn-remarks" maxlength="500">
        <div class="row"><button class="btn" type="submit">Create consignment</button></div>
      </form>
    </div>`;
}

function foundCodesHtml(c, remaining) {
  const found = state.foundCodes;
  if (!found) return "";
  if (!found.codes.length) {
    return `<div class="box warn-box" id="found-box"><b>No barcodes were found in ${esc(found.source)}.</b>
      <p class="fine">The reader understands Code 39 barcodes such as the AMD labels. Use a sharp, close photo or a scan, or paste the barcodes below.</p></div>`;
  }
  return `
    <div class="box found-box" id="found-box">
      <h3>${found.codes.length} barcode(s) found in ${esc(found.source)}</h3>
      <ul class="chips">${found.codes.map((code) => `<li class="mono">${esc(code)}</li>`).join("")}</ul>
      <p class="fine">Each one is added as an item with the asset type, storage room, Bond No. and other details filled in the form below. ${remaining} place(s) left in this consignment.</p>
      <div class="row"><button class="btn" type="button" data-action="add-found">Add ${Math.min(found.codes.length, remaining)} item(s)</button>
        <button class="btn secondary" type="button" data-action="clear-found">Clear</button></div>
    </div>`;
}

async function consignmentHtml() {
  const [{ consignment: c, documents, items }, people] = await Promise.all([
    api("GET", "/api/consignments/" + state.consignmentId), api("GET", "/api/people")]);
  const full = c.scannedItems >= c.expectedItems;
  const canScan = !full;
  if (!state.inwardFill) state.inwardFill = {};
  const fill = state.inwardFill;
  if (canScan && !fill.barcode && !fill.noNext) {
    const next = await api("GET", "/api/assets/next-barcode?consignment=" + c.id).catch(() => ({ barcode: "" }));
    fill.barcode = next.barcode;
    fill.noNext = true;
  }
  const noDocs = !documents.length;
  const scanNote = full ? "All items are scanned. Raise the number of items above if more came in this package."
    : "Scan the barcode (it replaces the suggested number) and press Enter. Known details fill in automatically.";
  const docState = noDocs ? `
    <div class="box warn-box attention-box">
      <label class="check"><input id="it-nodoc" type="checkbox" checked disabled> No document yet <span class="pill bad">Attention</span></label>
      <p class="fine">Ticked automatically because no document is uploaded. It clears by itself once you upload one. This consignment shows in red on the Dashboard until then.</p>
      <label for="it-nodoc-reason">Reason (optional)</label>
      <input id="it-nodoc-reason" maxlength="200" value="${esc(fill.noDocumentReason || "")}" placeholder="For example: invoice is with the purchase team">
    </div>` : `
    <div class="box ok-box"><label class="check"><input type="checkbox" disabled> No document yet</label>
      <span class="pill ok">Document uploaded: Yes</span></div>`;
  return `
    <div class="row"><button class="btn secondary small" type="button" data-action="close-consignment">← All consignments</button></div>
    <h2>Invoice ${esc(c.invoiceNo)} · PO ${esc(c.poNumber)} ${noDocs ? '<span class="pill bad">No document</span>' : ""}</h2>
    <dl class="details">
      <dt>Received</dt><dd>${esc(c.receivedDate)}</dd>
      <dt>Ownership</dt><dd>${ownerPill(c.ownership)}</dd>
      <dt>Supplier</dt><dd>${esc(c.supplier || "-")}</dd>
      <dt>Recorded by</dt><dd>${esc(c.createdByName || c.createdBy)} on ${esc(when(c.createdAt))}</dd>
      <dt>Progress</dt><dd><progress max="${c.expectedItems}" value="${c.scannedItems}"></progress> ${c.scannedItems} of ${c.expectedItems} items scanned</dd>
    </dl>
    <h3 id="consignment-edit-heading">✏️ Edit this consignment</h3>
    <form id="consignment-edit" class="grid3 box">
      <div><label for="ce-invoice">Invoice number</label><input id="ce-invoice" maxlength="64" value="${esc(c.invoiceNo)}"></div>
      <div><label for="ce-po">PO number</label><input id="ce-po" maxlength="64" value="${esc(c.poNumber)}"></div>
      <div><label for="ce-date">Date received</label><input id="ce-date" type="date" value="${esc(c.receivedDate)}"></div>
      <div><label for="ce-count">Number of items</label><input id="ce-count" type="number" min="1" max="1000" value="${c.expectedItems}"></div>
      <div><label for="ce-owner">Ownership</label><select id="ce-owner" ${c.scannedItems ? "disabled" : ""}>${options(state.settings.owners, c.ownership)}</select></div>
      <div><label for="ce-supplier">Supplier</label><input id="ce-supplier" maxlength="120" value="${esc(c.supplier)}"></div>
      <div class="span-3"><label for="ce-remarks">Remarks</label><input id="ce-remarks" maxlength="500" value="${esc(c.remarks)}"></div>
      <div class="span-3 row"><button class="btn secondary small" type="submit">Save consignment changes</button>
        <span class="fine">Only Admins and Super Admins can edit. A new PO number or date is copied to the items already scanned.</span></div>
    </form>
    <div class="steps">
      <div class="step">
        <h3>Documents (invoice, delivery note, barcode sheet)</h3>
        <ul>${documents.map((d) => `<li><a href="/api/documents/${d.id}" target="_blank" rel="noopener">${esc(d.name)}</a>
          <span class="fine">${Math.ceil(d.size / 1024)} KB · ${esc(d.uploadedBy)} · ${esc(when(d.uploadedAt))}</span></li>`).join("") || "<li>No documents yet.</li>"}</ul>
        <form id="doc-form" class="row">
          <input id="doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">
          <button class="btn" type="submit">Upload and read barcodes</button>
        </form>
        <p class="fine">PDF, JPG or PNG, up to 10 MB. Barcodes in the file (for example a photo of several AMD labels) are read and listed below, ready to add.</p>
        <form id="paste-form">
          <label for="paste-codes">Or paste barcodes (one per line)</label>
          <textarea id="paste-codes" class="mono short" placeholder="EMBLAB30890&#10;EMBLAB30891"></textarea>
          <div class="row"><button class="btn secondary small" type="submit">Use these barcodes</button></div>
        </form>
        ${foundCodesHtml(c, c.expectedItems - c.scannedItems)}
      </div>
      <div class="step ${canScan ? "" : "off"}">
        <h3>Scan an item</h3>
        <p class="sub">${esc(scanNote)}</p>
        <form id="item-form">
          <fieldset ${canScan ? "" : "disabled"} class="plain">
            ${docState}
            <label for="it-barcode">Barcode <span class="req">*</span></label>
            <div class="row tight"><input id="it-barcode" maxlength="64" class="mono grow" value="${esc(fill.barcode || "")}" ${canScan ? "data-autofocus data-select" : ""} placeholder="Scan, or type it, for example EMBLAB30890">
              <button class="btn secondary small" type="button" data-action="next-barcode" title="Fill the next number after the last item">Next number</button></div>
            ${detailsFormHtml("it", { ...fill, ownership: c.ownership }, true)}
            <label for="it-holder">Give to (mail ID, optional)</label>
            <input id="it-holder" type="email" maxlength="120" list="people-list" placeholder="Leave blank to keep it in its storage room. The person must accept it.">
            ${peopleList(people)}
            <div class="row"><button class="btn" type="submit">Save item</button>
              <button class="btn secondary" type="button" data-action="clear-item">Clear</button></div>
          </fieldset>
        </form>
      </div>
    </div>
    <h3>Items in this consignment</h3>
    <div class="scroll"><table><thead><tr><th>Barcode</th><th>Type</th><th>Model</th><th>Serial</th><th>Bond No.</th><th>Where</th><th>Holder</th><th>Scanned</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr><td class="mono">${i.deleted ? esc(i.barcode) + ' <span class="pill bad">Deleted</span>'
        : `<button class="linkish mono" type="button" data-action="open-asset" data-barcode="${esc(i.barcode)}">${esc(i.barcode)}</button>`}</td>
        <td>${esc(i.assetType)}</td><td>${esc(i.model)}</td><td class="mono">${esc(i.serialNo)}</td><td>${esc(i.bondNo)}</td><td>${esc(i.place)}</td>
        <td>${esc(i.holderName || "-")}${i.pendingName ? ` <span class="pill warn">Waiting for ${esc(i.pendingName)}</span>` : ""}</td>
        <td>${esc(i.createdBy)} · ${esc(when(i.createdAt))}</td><td>${i.deleted ? "" : iconButtons(i.barcode)}</td></tr>`).join("")
        || `<tr><td colspan="9">No items yet.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- transfer ----------

async function transferHtml() {
  const s = state.settings;
  const [people, assets] = await Promise.all([api("GET", "/api/people"), api("GET", "/api/assets")]);
  let summary = `<p class="sub">Scan, type or pick a barcode. The details load at once.</p>`;
  let history = "";
  const a = state.transferAsset;
  if (a) {
    summary = `<dl class="details">
      <dt>Item</dt><dd>${ownerPill(a.ownership)} ${esc(a.assetType)} · ${esc(a.model || "no model")}</dd>
      <dt>Current holder</dt><dd>${a.holderId ? personHtml(a.holderName, a.holderEmail) + " (" + esc(a.teamName) + ")" : "Nobody (in the cage)"}</dd>
      <dt>Status</dt><dd>${esc(a.status)}${expiryPill(a)}${pendingPill(a)}</dd>
      <dt>Where now</dt><dd>${esc(a.place || "-")}</dd></dl>`;
    history = `<h3>History of ${esc(a.barcode)}</h3>${historyTable(state.transferHistory || [])}`;
  }
  return `
    <h2>Transfer</h2>
    <p class="sub">Giving an item to a person waits until that person accepts it on their Dashboard. Moving it to the cage, maintenance or scrap happens at once.</p>
    <div class="duo">
      <form id="transfer-form">
        <label for="tr-barcode">Barcode <span class="req">*</span></label>
        <input id="tr-barcode" class="mono" maxlength="64" list="asset-list" value="${esc(a ? a.barcode : "")}" data-autofocus>
        <datalist id="asset-list">${assets.map((x) => `<option value="${esc(x.barcode)}">${esc([x.assetType, x.model, x.holderName || "in cage"].filter(Boolean).join(" · "))}</option>`).join("")}</datalist>
        ${summary}
        <label for="tr-status">New status <span class="req">*</span></label>
        <select id="tr-status">${options(s.statuses, "Assigned to Engineer")}</select>
        <label for="tr-holder">Give to (mail ID)</label>
        <input id="tr-holder" type="email" maxlength="120" list="people-list" placeholder="name@wipro.com, needed for Assigned to Engineer">
        ${peopleList(people)}
        <label for="tr-remarks">Remarks</label><input id="tr-remarks" maxlength="500" placeholder="Needed when scrapping or returning">
        <div class="row"><button class="btn" type="submit" ${a ? "" : "disabled"}>Record transfer</button></div>
      </form>
      <div>${history}</div>
    </div>`;
}

// ---------- hardware requests ----------

function requestStatePill(status) {
  const kind = { Open: "warn", Approved: "ok", Rejected: "bad", Cancelled: "muted" }[status] || "muted";
  return `<span class="pill ${kind}">${esc(status)}</span>`;
}

function requestText(r) {
  if (r.kind === "Return") return "Return " + r.barcode + (r.item ? " (" + r.item + ")" : "") + (r.details ? " - " + r.details : "");
  const count = r.quantity > 1 ? r.quantity + " × " : "";
  return "Needs " + count + (r.assetType || "hardware") + (r.barcode && !r.given ? " (" + r.barcode + ")" : "")
    + (r.given ? " (given: " + r.given + ")" : "") + " - " + r.details;
}

// Free items of the requested type first; the rest stay one click away.
function giveChoicesHtml(r, available) {
  const box = (a) => `<label class="check"><input type="checkbox" data-give="${r.id}" data-max="${r.quantity}" value="${esc(a.barcode)}"${a.barcode === r.barcode ? " checked" : ""}>
    <span><b class="mono">${esc(a.barcode)}</b> · ${esc([a.model, a.make, a.place].filter(Boolean).join(" · ") || a.assetType)}</span></label>`;
  const typed = r.type && r.type !== "Other";
  const match = typed ? available.filter((a) => a.assetType === r.type) : available;
  const rest = typed ? available.filter((a) => a.assetType !== r.type) : [];
  const heading = typed ? `Free ${r.type} items (${match.length})` : `Free items (${match.length})`;
  return `<div class="give-list">
      <div class="fine"><b>${esc(heading)}</b> · tick ${r.quantity > 1 ? "up to " + r.quantity : "one"}</div>
      ${match.map(box).join("") || `<div class="fine">No free ${esc(typed ? r.type : "")} items in the cage right now.</div>`}
      ${rest.length ? `<details><summary class="fine">Other free items (${rest.length})</summary>${rest.map(box).join("")}</details>` : ""}
    </div>`;
}

function availableLabel(a) {
  return a.barcode + " · " + [a.assetType, a.model, a.place].filter(Boolean).join(" · ");
}

async function requestsHtml() {
  const s = state.settings;
  const [requests, assets, available] = await Promise.all([
    api("GET", "/api/requests"), api("GET", "/api/assets"), api("GET", "/api/assets/available")]);
  const mineHeld = assets.filter((a) => a.holderId === state.me.empId);
  const prefill = state.requestPrefill || {};
  const kind = prefill.kind || "Need";
  const form = `
    <form id="request-form" class="box">
      <h3>New request</h3>
      <label for="rq-kind">What do you need? <span class="req">*</span></label>
      <select id="rq-kind">${options([["Need", "I need hardware"], ["Return", "Please take back an item I hold"]], kind)}</select>
      <div id="rq-need" class="${kind === "Need" ? "" : "hidden"}">
        <label for="rq-pick">Pick a free item from the cage (optional)</label>
        <select id="rq-pick">${options(available.map((a) => [a.barcode, availableLabel(a)]), "", available.length ? "Any suitable item" : "Nothing is free right now")}</select>
        <div id="rq-pick-info" class="fine"></div>
        <label for="rq-type">Type of hardware</label><select id="rq-type">${options(s.assetTypes, "", "Any / not sure")}</select>
        <div id="rq-other-wrap" class="hidden"><label for="rq-other">You chose Other: what do you need? <span class="req">*</span></label>
          <input id="rq-other" maxlength="80" placeholder="For example: USB-C to HDMI adapter"></div>
        <div id="rq-qty-wrap"><label for="rq-qty">How many? <span class="req">*</span></label>
          <input id="rq-qty" type="number" min="1" max="20" value="1"></div>
      </div>
      <div id="rq-return" class="${kind === "Return" ? "" : "hidden"}">
        <label for="rq-barcode">Item to return <span class="req">*</span></label>
        <select id="rq-barcode">${options(mineHeld.map((a) => [a.barcode, a.barcode + " · " + (a.model || a.assetType)]), prefill.barcode || "",
          mineHeld.length ? "Choose" : "No items are assigned to you")}</select>
      </div>
      <label for="rq-details">Details <span id="rq-details-hint">(what you need, why, and by when)</span></label>
      <textarea id="rq-details" maxlength="500"></textarea>
      <div class="row"><button class="btn" type="submit">Send request</button></div>
    </form>`;
  const open = requests.filter((r) => r.status === "Open");
  const done = requests.filter((r) => r.status !== "Open");
  const freeList = `<datalist id="free-list">${available.map((a) => `<option value="${esc(a.barcode)}">${esc(availableLabel(a))}</option>`).join("")}</datalist>`;
  const handleTable = isCustodian() ? `
    <h3>Open requests to handle (${open.length})</h3>
    <p class="sub">Approving a return puts the item back in the cage. Approving a need offers the item to the engineer, who accepts it on their Dashboard. Pick a free item from the list, or scan its barcode.</p>
    ${freeList}
    <div class="scroll"><table><thead><tr><th>Asked</th><th>Person</th><th>Request</th><th>Handle</th></tr></thead><tbody>
      ${open.map((r) => `<tr><td class="mono">${esc(when(r.createdAt))}</td>
        <td>${personHtml(r.empName, r.email)}<br><span class="fine">${esc(r.teamName || "No team")}</span></td>
        <td>${esc(requestText(r))}${r.note ? `<br><span class="fine">${esc(r.note)}</span>` : ""}</td>
        <td>
          ${r.kind === "Need" ? giveChoicesHtml(r, available) + `<input id="rq-give-${r.id}" class="mono" maxlength="64" list="free-list" placeholder="Or scan / type a barcode">` : ""}
          <input id="rq-note-${r.id}" maxlength="300" placeholder="Note (needed to reject)">
          <div class="row">
            <button class="btn small" type="button" data-action="approve-request" data-id="${r.id}">${r.kind === "Return" ? "Approve: back to cage" : "Approve and offer"}</button>
            <button class="btn danger small" type="button" data-action="reject-request" data-id="${r.id}">Reject</button>
          </div>
        </td></tr>`).join("") || `<tr><td colspan="4">No open requests.</td></tr>`}
    </tbody></table></div>` : "";
  const listRows = isCustodian() ? done : requests;
  const listTable = `
    <h3>${isCustodian() ? "Earlier requests" : "My requests"}</h3>
    <div class="scroll"><table><thead><tr><th>Asked</th>${isCustodian() ? "<th>Person</th>" : ""}<th>Request</th><th>Status</th><th>Decided by</th><th>Note</th><th></th></tr></thead><tbody>
      ${listRows.map((r) => `<tr><td class="mono">${esc(when(r.createdAt))}</td>
        ${isCustodian() ? `<td>${personHtml(r.empName, r.email)}</td>` : ""}
        <td>${esc(requestText(r))}</td><td>${requestStatePill(r.status)}</td>
        <td>${esc(r.decidedBy)}${r.decidedAt ? "<br><span class='fine'>" + esc(when(r.decidedAt)) + "</span>" : ""}</td><td>${esc(r.note)}</td>
        <td>${r.status === "Open" && r.empId === state.me.empId
          ? `<button class="btn secondary small" type="button" data-action="cancel-request" data-id="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="7">No requests yet.</td></tr>`}
    </tbody></table></div>`;
  return `
    <h2>Requests</h2>
    <p class="sub">${isCustodian() ? "Engineers and leads ask here for hardware, or ask you to take an item back."
      : "Ask the lab custodians for hardware, or ask them to take back an item. You can follow the answer here."}</p>
    ${isCustodian() ? handleTable : `<div class="duo">${form}<div></div></div>`}
    ${listTable}`;
}

// ---------- accounts, teams, delete history ----------

async function accountsHtml() {
  const [users, teams, directory] = await Promise.all([api("GET", "/api/users"), api("GET", "/api/teams"), api("GET", "/api/directory")]);
  state.teams = teams;
  const s = state.settings;
  const picked = users.find((u) => u.empId === state.selectedUser);
  const editor = picked ? `
    <form id="user-form" class="box" data-id="${esc(picked.empId)}">
      <h3>${esc(picked.name)}</h3>
      <p class="sub">${esc(picked.email)} · Emp ID ${esc(picked.empId)} · asked for ${esc(picked.requestedRole)} · ${esc(picked.state)}</p>
      <label for="us-role">Role</label><select id="us-role">${options(s.roles, picked.role)}</select>
      <label for="us-team">Team</label>${addableSelect("us-team", "team", picked.teamId, "No team")}
      <label class="check"><input id="us-active" type="checkbox" ${picked.state === "Active" || picked.state === "Pending" ? "checked" : ""}> Approve / active</label>
      <div class="row"><button class="btn" type="submit">Save</button>
        ${picked.state === "Pending" ? `<button class="btn danger" type="button" data-action="reject-user" data-id="${esc(picked.empId)}">Reject request</button>` : ""}
        ${picked.empId !== state.me.empId ? `<button class="btn secondary" type="button" data-action="new-first-password" data-id="${esc(picked.empId)}">Give a new first password</button>` : ""}</div>
    </form>` : `<div class="box"><p class="sub">Select an account to approve it, change the role or team, or turn it off.</p></div>`;
  const waiting = users.filter((u) => u.state === "Pending").length;
  const withAccount = new Set(users.flatMap((u) => [u.empId, u.email]));
  const noAccount = directory.filter((d) => !withAccount.has(d.empId) && !withAccount.has(d.email)).length;
  return `
    <h2>Accounts</h2>
    ${noAccount ? `<div class="box ok-box"><span>${noAccount} people on the lab directory have no account yet.</span>
      <button class="btn small" type="button" data-action="create-all-users">Create accounts with first passwords</button>
      <span class="fine">Downloads a file with each person's first password. Give each person only their own row; they choose their own password at the first sign-in.</span></div>` : ""}
    ${waiting ? `<div class="box ok-box"><span>${waiting} access request(s) waiting.</span>
      <button class="btn small" type="button" data-action="approve-all-users">Approve all waiting as User</button></div>` : ""}
    <div class="duo wide-left">
      <div class="scroll"><table><thead><tr><th>Name</th><th>Mail ID</th><th>Emp ID</th><th>Role</th><th>Team</th><th>State</th></tr></thead><tbody>
        ${users.map((u) => `<tr class="clickable ${u.empId === state.selectedUser ? "picked" : ""}" data-action="pick-user" data-id="${esc(u.empId)}">
          <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td class="mono">${esc(u.empId)}</td><td>${esc(u.role)}</td><td>${esc(u.teamName || "-")}</td>
          <td><span class="pill ${u.state === "Active" ? "ok" : u.state === "Pending" ? "warn" : "muted"}">${esc(u.state)}</span></td></tr>`).join("")}
      </tbody></table></div>
      ${editor}
    </div>
    <h3>Lab directory (people allowed to request access)</h3>
    <div class="duo">
      <form id="directory-form" class="box">
        <h3>Add or update one person</h3>
        <div class="grid">
          <div><label for="dir-email">Mail ID <span class="req">*</span></label><input id="dir-email" type="email" maxlength="120"></div>
          <div><label for="dir-name">Full name <span class="req">*</span></label><input id="dir-name" maxlength="120"></div>
          <div><label for="dir-emp">Emp ID <span class="req">*</span></label><input id="dir-emp" maxlength="32"></div>
          <div><label for="dir-team">Team</label>${addableSelect("dir-team", "team", "", "No team")}</div>
        </div>
        <div class="row"><button class="btn" type="submit">Save to directory</button></div>
      </form>
      <form id="import-form" class="box">
        <h3>Import many people</h3>
        <label for="imp-text">In Excel, select the columns Name, Team, Emp ID and Email Address with their heading row, copy, and paste here. Or type one person per line: Emp ID, mail ID, full name, team.</label>
        <textarea id="imp-text" placeholder="Name&#9;Team&#9;Emp ID&#9;Email Address"></textarea>
        <p class="fine">Teams that do not exist yet are created. People already in the directory are updated.</p>
        <div class="row"><button class="btn" type="submit">Import</button></div>
      </form>
    </div>
    <div class="scroll"><table><thead><tr><th>Name</th><th>Mail ID</th><th>Emp ID</th><th>Team</th><th>Account</th></tr></thead><tbody>
      ${directory.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.email)}</td><td class="mono">${esc(d.empId)}</td><td>${esc(d.teamName || "-")}</td>
        <td>${d.hasAccount ? esc(d.role) : "Not yet"}</td></tr>`).join("")}
    </tbody></table></div>
    ${state.settings.showSampleAccounts ? `
      <h3>Reset sample data (development copy only)</h3>
      <form id="reset-form" class="grid"><div><label for="reset-confirm">Type RESET</label><input id="reset-confirm" maxlength="5"></div>
        <div><label>&nbsp;</label><button class="btn danger" type="submit">Restore sample data</button></div></form>` : ""}`;
}

async function teamsHtml() {
  const [teams, users, directory] = await Promise.all([api("GET", "/api/teams"), api("GET", "/api/users"), api("GET", "/api/directory")]);
  state.teams = teams;
  const leads = users.filter((u) => u.role !== "User" && u.state === "Active").map((u) => [u.empId, u.name + " (" + u.role + ")"]);
  const picked = teams.find((t) => t.id === state.selectedTeam);
  const leadValue = state.pendingLead || (picked ? picked.leadId : "");
  state.pendingLead = "";
  const candidates = directory.filter((d) => !leads.some(([id]) => id === d.empId));
  const members = picked ? directory.filter((d) => d.teamId === picked.id) : [];
  const others = picked ? directory.filter((d) => d.teamId !== picked.id) : [];
  const memberBlock = picked ? `
    <div class="box" id="members-box">
      <h3>People in ${esc(picked.name)} (${members.length})</h3>
      <p class="sub">The lead of this team sees the hardware of everyone listed here.</p>
      <ul class="members">${members.map((m) => `<li><label class="check"><input type="checkbox" data-member="${esc(m.empId)}"> ${esc(m.name)}
        <span class="fine">${esc(m.email)}</span></label></li>`).join("") || "<li>Nobody yet.</li>"}</ul>
      ${members.length ? `<div class="row"><button class="btn danger small" type="button" data-action="remove-members">Take ticked people out of this team</button></div>` : ""}
      <label for="tm-add-filter">Add people to ${esc(picked.name)}</label>
      <input id="tm-add-filter" placeholder="Type to filter by name, mail ID or team">
      <select id="tm-add" multiple size="8">${others.map((d) => `<option value="${esc(d.empId)}" data-search="${esc((d.name + " " + d.email + " " + d.teamName).toLowerCase())}">${esc(d.name + " · " + d.email + (d.teamName ? " · now in " + d.teamName : ""))}</option>`).join("")}</select>
      <p class="fine">Hold Ctrl to pick several people.</p>
      <div class="row"><button class="btn small" type="button" data-action="add-members">Add the selected people</button></div>
    </div>` : "";
  return `
    <h2>Teams</h2>
    <p class="sub">A Lead Admin sees the hardware of every person in their own team and in the teams they lead. Pick a team to choose its lead and its people.</p>
    <div class="duo wide-left">
      <div class="scroll"><table><thead><tr><th>Team</th><th>Lead</th><th class="right">People</th></tr></thead><tbody>
        ${teams.map((t) => `<tr class="clickable ${t.id === state.selectedTeam ? "picked" : ""}" data-action="pick-team" data-id="${t.id}">
          <td><b>${esc(t.name)}</b></td><td>${esc(t.lead || "Not set")}</td><td class="right">${t.members}</td></tr>`).join("")
          || `<tr><td colspan="3">No teams yet.</td></tr>`}
      </tbody></table></div>
      <div>
        <form id="team-form" class="box" data-id="${picked ? picked.id : ""}">
          <h3>${picked ? "Edit " + esc(picked.name) : "Add a team"}</h3>
          <label for="tm-name">Team name <span class="req">*</span></label><input id="tm-name" maxlength="80" value="${esc(picked ? picked.name : "")}">
          <label for="tm-lead">Lead Admin</label>
          <select id="tm-lead">${options(leads, leadValue, "Not set")}<option value="__lead__">+ Make another person a lead…</option></select>
          <div id="tm-lead-add" class="add-inline column hidden">
            <label for="tm-lead-person">Person from the lab directory</label>
            <select id="tm-lead-person">${options(candidates.map((d) => [d.empId, d.name + " · " + d.email + (d.hasAccount ? "" : " (no account yet)")]), "", "Choose")}</select>
            <label for="tm-lead-password">First password (only for someone without an account, at least ${state.settings.passwordMin} characters)</label>
            <input id="tm-lead-password" type="password" maxlength="64" autocomplete="new-password">
            <div class="row"><button class="btn small" type="button" data-action="make-lead">Make Lead Admin</button>
              <button class="btn secondary small" type="button" data-action="cancel-lead">Cancel</button></div>
          </div>
          <div class="row"><button class="btn" type="submit">${picked ? "Save team" : "Add team"}</button>
            ${picked ? `<button class="btn secondary" type="button" data-action="pick-team" data-id="">New team</button>` : ""}</div>
        </form>
        ${memberBlock}
      </div>
    </div>`;
}

async function deleteHistoryHtml() {
  const rows = await api("GET", "/api/assets/delete-history");
  return `
    <h2>Delete history</h2>
    <p class="sub">Every deletion, newest first. A deleted item is hidden from every list until it is restored. Restore puts it back exactly as it was.</p>
    <div class="scroll"><table><thead><tr><th>Deleted</th><th>Barcode</th><th>Item</th><th>By</th><th>Reason</th><th>Now</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.stillDeleted ? "bad-row" : ""}"><td class="mono">${esc(when(r.when))}</td><td class="mono">${esc(r.barcode)}</td>
        <td>${esc([r.assetType, r.model].filter(Boolean).join(" · "))}</td><td>${esc(r.by)}</td><td>${esc(r.reason)}</td>
        <td>${r.stillDeleted
          ? `<span class="pill bad">Deleted</span> <button class="btn secondary small" type="button" data-action="restore" data-barcode="${esc(r.barcode)}">Restore</button>`
          : r.restoredAt ? `<span class="pill ok">Restored</span> <span class="fine">${esc(when(r.restoredAt))} by ${esc(r.restoredBy)}</span>` : "-"}</td></tr>`).join("")
        || `<tr><td colspan="6">Nothing has been deleted.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- feedback ----------

function feedbackFormHtml() {
  const s = state.settings;
  return `
    <form id="fbm-form" data-feedback>
      <p class="sub">Sent with your name (${esc(state.me.name)}), mail ID (${esc(state.me.email)}) and the time.</p>
      <label for="fbm-kind">Type <span class="req">*</span></label>
      <select id="fbm-kind">${options(s.feedbackKinds, "", "Choose")}</select>
      <div id="fbm-other-wrap" class="hidden"><label for="fbm-other">You chose Other: what is it about? <span class="req">*</span></label>
        <input id="fbm-other" maxlength="80"></div>
      <label for="fbm-title">Title <span class="req">*</span> <span class="counter short" data-count-for="fbm-title" data-min="${s.feedbackTitleMin}">0 / ${s.feedbackTitleMin} minimum</span></label>
      <input id="fbm-title" maxlength="150">
      <label for="fbm-desc">Description <span class="req">*</span> <span class="counter short" data-count-for="fbm-desc" data-min="${s.feedbackDescriptionMin}">0 / ${s.feedbackDescriptionMin} minimum</span></label>
      <textarea id="fbm-desc" maxlength="4000"></textarea>
      <label for="fbm-shot">Screenshot (optional, PNG or JPG, up to 5 MB)</label>
      <input id="fbm-shot" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg">
      <div class="row"><button class="btn" type="submit">Send feedback</button>
        <button class="btn secondary" type="button" data-action="close-modal">Cancel</button></div>
      <div id="fbm-status" class="status"></div>
    </form>`;
}

async function feedbackHtml() {
  const rows = await api("GET", "/api/feedback");
  return `
    <h2>Feedback received</h2>
    <p class="sub">Everyone sends feedback with the Give feedback button at the top of the page.</p>
    <div class="scroll"><table><thead><tr><th>When</th><th>Type</th><th>Title and description</th><th>From</th><th>Screenshot</th><th>Status</th></tr></thead><tbody>
      ${rows.map((f) => `<tr><td class="mono">${esc(when(f.createdAt))}</td><td>${esc(f.kind)}</td>
        <td><b>${esc(f.title)}</b><br>${esc(f.description)}${f.screen ? `<br><span class="fine">Screen: ${esc(f.screen)}</span>` : ""}</td>
        <td>${esc(f.person)}<br><span class="fine">${esc(f.email)} · ${esc(f.role)}</span></td>
        <td>${f.hasScreenshot ? `<a href="/api/feedback/${f.id}/screenshot" target="_blank" rel="noopener">Open</a>` : "-"}</td>
        <td><select data-feedback-status="${f.id}">${options(state.settings.feedbackStatuses, f.status)}</select></td></tr>`).join("")
        || `<tr><td colspan="6">No feedback yet.</td></tr>`}
    </tbody></table></div>`;
}

function openFeedbackModal() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-back" data-action="close-modal-back"><div class="modal" role="dialog" aria-label="Give feedback">
      <h2>Give feedback</h2>${feedbackFormHtml()}</div></div>`;
  document.getElementById("fbm-kind").focus();
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

// ---------- my account ----------

async function accountHtml() {
  const me = await api("GET", "/api/me");
  state.me = me;
  const min = state.settings.passwordMin;
  return `
    <h2>My account</h2>
    <dl class="details">
      <dt>Name</dt><dd>${esc(me.name)}</dd><dt>Mail ID</dt><dd>${esc(me.email)}</dd><dt>Emp ID</dt><dd>${esc(me.empId)}</dd>
      <dt>Role</dt><dd>${esc(me.role)}</dd><dt>Team</dt><dd>${esc(me.teamName || "No team")}</dd>
      <dt>Team lead</dt><dd>${esc(me.lead || "-")}</dd>
      ${me.ledTeams.length ? `<dt>Teams I lead</dt><dd>${esc(me.ledTeams.join(", "))}</dd>` : ""}
    </dl>
    <h3>Change password</h3>
    <form id="password-form" class="grid3">
      <div><label for="pw-current">Current password</label><input id="pw-current" type="password" maxlength="64" autocomplete="current-password"></div>
      <div><label for="pw-next">New password (at least ${min} characters)</label><input id="pw-next" type="password" maxlength="64" autocomplete="new-password"></div>
      <div><label for="pw-confirm">New password again</label><input id="pw-confirm" type="password" maxlength="64" autocomplete="new-password"></div>
      <div><button class="btn" type="submit">Change password</button></div>
    </form>`;
}

// ---------- actions ----------

async function go(tab) {
  state.tab = tab;
  if (tab !== "inward") state.consignmentId = null;
  await paint();
  window.scrollTo(0, 0);
}

function showHardwareList() {
  const heading = document.getElementById("hardware-list");
  if (heading) heading.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startApp() {
  state.me = await api("GET", "/api/me");
  state.view = "app";
  state.tab = "dashboard";
  state.filters = { owner: "", status: "", type: "", team: "", search: "" };
  state.updatesSince = "";
  if (state.me.mustChange) {
    state.view = "first-password";
    state.flash = null;
    await paint();
    return;
  }
  state.flash = { text: "Welcome, " + state.me.name + ".", kind: "good" };
  await paint();
  checkUpdates();
  showWaitingHandovers();
}

async function loadTransfer(barcode) {
  const code = barcode.toUpperCase().replace(/[\s*]+/g, "");
  try {
    const data = await api("GET", "/api/assets/" + encodeURIComponent(code));
    state.transferAsset = data.asset;
    state.transferHistory = data.history || [];
    state.flash = { text: code + " loaded. Choose the new status and record the transfer.", kind: "info" };
  } catch (error) {
    state.transferAsset = null;
    state.transferHistory = [];
    state.flash = { text: error.message.includes("not in your list") ? "Barcode " + code + " is not in the lab list. Use Inward to add it." : error.message, kind: "bad" };
  }
  await paint();
}

async function suggestInward(quiet) {
  const barcode = val("it-barcode").toUpperCase().replace(/[\s*]+/g, "");
  setVal("it-barcode", barcode);
  if (!barcode) return;
  try {
    const data = await api("GET", "/api/assets/suggest?barcode=" + encodeURIComponent(barcode)
      + "&consignment=" + encodeURIComponent(state.consignmentId || ""));
    if (data.existing) {
      toast(barcode + " is already on file (" + (data.existing.model || data.existing.assetType) + "). Open it from the Dashboard to edit it.", "bad");
      return;
    }
    const f = data.fill;
    if (f.assetType && !val("it-type")) setVal("it-type", f.assetType);
    fillIfEmpty("it-mfr", f.manufacturer);
    fillIfEmpty("it-make", f.make);
    fillIfEmpty("it-model", f.model);
    fillIfEmpty("it-rev", f.capacityRev);
    fillIfEmpty("it-desc", f.description);
    fillIfEmpty("it-bond", f.bondNo);
    if (f.room && !val("it-room")) setVal("it-room", f.room);
    fillIfEmpty("it-location", f.location);
    if (!quiet) {
      toast(data.source ? "Details were filled from " + data.source + ". Check them and add the serial number."
        : "New barcode. Fill in the details from the label.", "info", "New barcode " + barcode);
    }
    document.getElementById("it-serial").focus();
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function suggestModel(prefix) {
  const model = val(prefix + "-model").trim();
  if (!model) return;
  const found = await api("GET", "/api/assets/model-suggest?model=" + encodeURIComponent(model)).catch(() => null);
  if (!found) return;
  if (!val(prefix + "-type")) setVal(prefix + "-type", found.assetType);
  fillIfEmpty(prefix + "-mfr", found.manufacturer);
  fillIfEmpty(prefix + "-make", found.make);
  fillIfEmpty(prefix + "-rev", found.capacityRev);
}

function keepFill(details, extra) {
  return {
    assetType: details.assetType, manufacturer: details.manufacturer, make: details.make, model: details.model,
    capacityRev: details.capacityRev, description: details.description, bondNo: details.bondNo, room: details.room,
    location: details.location, expiryDate: details.expiryDate, noDocumentReason: val("it-nodoc-reason").trim(), ...extra
  };
}

const submitHandlers = {
  async "login-form"() {
    await api("POST", "/api/login", { email: val("login-email"), password: val("login-password") });
    await startApp();
  },
  async "register-form"() {
    const result = await api("POST", "/api/register", {
      email: val("reg-email"), requestedRole: val("reg-role"), password: val("reg-password"), confirm: val("reg-confirm"),
      name: val("reg-name"), empId: val("reg-emp")
    });
    state.view = "login";
    state.flash = { text: result.message, kind: "good" };
    paint();
  },
  async "filter-form"() {
    state.filters.search = val("f-search").trim();
    await paint();
  },
  async "edit-form"(form) {
    const result = await api("PUT", "/api/assets/" + encodeURIComponent(form.dataset.barcode),
      { ...readDetails("ed"), revision: Number(form.dataset.revision) });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "delete-form"(form) {
    const barcode = form.dataset.barcode;
    if (!window.confirm("Delete " + barcode + "? It can be restored later from Delete history.")) return;
    const result = await api("POST", "/api/assets/" + encodeURIComponent(barcode) + "/delete", { reason: val("del-reason") });
    state.tab = "dashboard";
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "decline-modal-form"(form) {
    const result = await api("POST", "/api/handovers/" + form.dataset.id + "/decline", { note: val("dcl-note") });
    closeModal();
    closeHandoverToasts(form.dataset.id);
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "delete-modal-form"(form) {
    const result = await api("POST", "/api/assets/" + encodeURIComponent(form.dataset.barcode) + "/delete", { reason: val("dm-reason") });
    closeModal();
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "consignment-form"() {
    const result = await api("POST", "/api/consignments", {
      invoiceNo: val("cn-invoice"), poNumber: val("cn-po"), receivedDate: val("cn-date"), expectedItems: Number(val("cn-count")),
      ownership: val("cn-owner"), supplier: val("cn-supplier"), remarks: val("cn-remarks")
    });
    state.consignmentId = result.id;
    state.inwardFill = null;
    state.foundCodes = null;
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "consignment-edit"() {
    const result = await api("PUT", "/api/consignments/" + state.consignmentId, {
      invoiceNo: val("ce-invoice"), poNumber: val("ce-po"), receivedDate: val("ce-date"), expectedItems: Number(val("ce-count")),
      ownership: val("ce-owner"), supplier: val("ce-supplier"), remarks: val("ce-remarks")
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "doc-form"() {
    const input = document.getElementById("doc-file");
    const picked = input && input.files && input.files[0];
    const file = await readFile("doc-file", 10);
    if (!file) throw new Error("Choose a PDF, JPG or PNG file first.");
    toast("Reading barcodes and uploading " + file.name + "...", "info", "Please wait");
    let codes = [];
    try {
      codes = await window.BarcodeReader.readFile(picked);
    } catch {
      codes = [];
    }
    const result = await api("POST", "/api/consignments/" + state.consignmentId + "/documents", { file });
    state.foundCodes = { codes, source: file.name };
    state.flash = { text: result.message + (codes.length ? " " + codes.length + " barcode(s) found: check them and press Add." : ""), kind: "good" };
    state.scrollTo = "found-box";
    await paint();
  },
  async "paste-form"() {
    const codes = [...new Set(val("paste-codes").toUpperCase().split(/[\s,;]+/).map((code) => code.replace(/\*/g, "")).filter(Boolean))];
    if (!codes.length) throw new Error("Paste at least one barcode.");
    state.foundCodes = { codes, source: "the pasted list" };
    state.scrollTo = "found-box";
    await paint();
  },
  async "item-form"() {
    const details = readDetails("it");
    delete details.ownership;
    const barcode = val("it-barcode");
    const result = await api("POST", "/api/consignments/" + state.consignmentId + "/items", {
      barcode, holderEmail: val("it-holder"), noDocumentReason: val("it-nodoc-reason").trim(), ...details
    });
    const next = await api("GET", "/api/assets/next-barcode?after=" + encodeURIComponent(barcode)).catch(() => ({ barcode: "" }));
    state.inwardFill = keepFill(details, { barcode: next.barcode, noNext: true });
    state.flash = { text: result.message + (next.barcode ? " Next number " + next.barcode + " is ready; scan a label to replace it." : ""), kind: "good" };
    await paint();
  },
  async "transfer-form"() {
    const a = state.transferAsset;
    const typed = val("tr-barcode").toUpperCase().replace(/[\s*]+/g, "");
    if (!a || a.barcode !== typed) return loadTransfer(typed);
    const result = await api("POST", "/api/assets/" + encodeURIComponent(a.barcode) + "/transfer", {
      status: val("tr-status"), holderEmail: val("tr-holder"), remarks: val("tr-remarks"), revision: a.revision
    });
    await loadTransfer(a.barcode);
    toast(result.message, "good");
  },
  async "user-form"(form) {
    const team = val("us-team");
    const result = await api("PUT", "/api/users/" + encodeURIComponent(form.dataset.id), {
      role: val("us-role"), teamId: team === "__add__" ? "" : team, active: checked("us-active")
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "directory-form"() {
    const team = val("dir-team");
    const result = await api("POST", "/api/directory", {
      empId: val("dir-emp"), email: val("dir-email"), name: val("dir-name"), teamId: team === "__add__" ? "" : team
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "import-form"() {
    const result = await api("POST", "/api/directory/import", { text: val("imp-text") });
    if (result.problems.length) toast(result.problems.slice(0, 5).join(" "), "bad", result.problems.length + " line(s) skipped");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "reset-form"() {
    const result = await api("POST", "/api/dev/reset", { confirm: val("reset-confirm") });
    state.selectedUser = "";
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "team-form"(form) {
    const lead = val("tm-lead");
    const body = { name: val("tm-name"), leadId: lead === "__lead__" ? "" : lead };
    const result = form.dataset.id
      ? await api("PUT", "/api/teams/" + form.dataset.id, body)
      : await api("POST", "/api/teams", body);
    if (result.id) state.selectedTeam = result.id;
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "request-form"() {
    const kind = val("rq-kind");
    const result = await api("POST", "/api/requests", {
      kind, assetType: val("rq-type"), otherText: val("rq-other"), barcode: kind === "Return" ? val("rq-barcode") : val("rq-pick"),
      quantity: Number(val("rq-qty")) || 0, details: val("rq-details")
    });
    state.requestPrefill = null;
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "first-password-form"() {
    await api("POST", "/api/me/password", { current: val("fp-current"), next: val("fp-next"), confirm: val("fp-confirm") });
    await startApp();
  },
  async "password-form"() {
    const result = await api("POST", "/api/me/password", { current: val("pw-current"), next: val("pw-next"), confirm: val("pw-confirm") });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  }
};

async function sendFeedback() {
  const statusNode = document.getElementById("fbm-status");
  const say = (text, kind) => { statusNode.textContent = text; statusNode.className = "status " + kind; };
  try {
    const s = state.settings;
    const kind = val("fbm-kind");
    const title = val("fbm-title").trim();
    const description = val("fbm-desc").trim();
    if (!kind) throw new Error("Choose a feedback type.");
    if (kind === "Other" && val("fbm-other").trim().length < s.otherMin) throw new Error("You chose Other: say what it is about.");
    if (title.length < s.feedbackTitleMin) throw new Error("The title must be at least " + s.feedbackTitleMin + " characters.");
    if (description.length < s.feedbackDescriptionMin) throw new Error("The description must be at least " + s.feedbackDescriptionMin + " characters.");
    const screenshot = await readFile("fbm-shot", 5);
    say("Sending...", "");
    const result = await api("POST", "/api/feedback", {
      kind, otherText: val("fbm-other"), title, description, screenshot, screen: state.tab
    });
    closeModal();
    toast(result.message, "good", "Feedback sent");
  } catch (error) {
    say(error.message, "bad");
    toast(error.message, "bad");
  }
}

const clickHandlers = {
  "fill-login"(el) { setVal("login-email", el.dataset.email); setVal("login-password", el.dataset.password); },
  "go-register"() { state.view = "register"; state.flash = null; paint(); },
  "go-login"() { state.view = "login"; state.flash = null; paint(); },
  async logout() {
    await api("POST", "/api/logout").catch(() => {});
    state.me = null;
    state.view = "login";
    state.flash = { text: "Signed out.", kind: "good" };
    closeModal();
    paint();
  },
  tab(el) { return go(el.dataset.tab); },
  "open-asset"(el) { state.barcode = el.dataset.barcode; return go("asset"); },
  "edit-asset"(el) { state.barcode = el.dataset.barcode; state.scrollTo = "edit-heading"; return go("asset"); },
  "delete-asset"(el) { openDeleteModal(el.dataset.barcode); },
  "transfer-this"(el) { state.tab = "transfer"; return loadTransfer(el.dataset.barcode); },
  async "team-filter"(el) {
    state.filters.team = el.dataset.team;
    await paint();
    showHardwareList();
  },
  async "card-filter"(el) {
    state.filters = { owner: el.dataset.owner, status: el.dataset.status, type: "", team: "", search: "" };
    await paint();
    showHardwareList();
  },
  attention(el) {
    if (el.dataset.barcode) { state.barcode = el.dataset.barcode; return go("asset"); }
    if (el.dataset.go === "inward" && el.dataset.id) {
      state.consignmentId = Number(el.dataset.id);
      state.inwardFill = null;
      state.foundCodes = null;
      state.tab = "inward";
      return paint();
    }
    if (el.dataset.go) return go(el.dataset.go);
    return null;
  },
  "open-consignment"(el) {
    state.consignmentId = Number(el.dataset.id);
    state.inwardFill = null;
    state.foundCodes = null;
    return paint();
  },
  "edit-consignment"(el) {
    state.consignmentId = Number(el.dataset.id);
    state.inwardFill = null;
    state.foundCodes = null;
    state.scrollTo = "consignment-edit-heading";
    return paint();
  },
  "close-consignment"() { state.consignmentId = null; state.foundCodes = null; return paint(); },
  "clear-item"() { state.inwardFill = null; return paint(); },
  async "next-barcode"() {
    const typed = val("it-barcode").toUpperCase().replace(/[\s*]+/g, "");
    const next = await api("GET", "/api/assets/next-barcode?consignment=" + state.consignmentId
      + (typed ? "&after=" + encodeURIComponent(typed) : ""));
    if (!next.barcode) throw new Error("There is no earlier barcode ending in a number to count on from. Scan or type the first one.");
    setVal("it-barcode", next.barcode);
    toast("Next number: " + next.barcode + (next.after ? " (after " + next.after + ")" : "") + ".", "info", "Barcode filled");
    await suggestInward(true);
  },
  async "add-found"() {
    const details = readDetails("it");
    delete details.ownership;
    const result = await api("POST", "/api/consignments/" + state.consignmentId + "/items/bulk", {
      barcodes: state.foundCodes.codes, noDocumentReason: val("it-nodoc-reason").trim(), ...details
    });
    if (result.skipped.length) toast(result.skipped.slice(0, 4).join(" "), "warn", result.skipped.length + " barcode(s) skipped");
    state.foundCodes = null;
    state.inwardFill = keepFill(details, {});
    state.flash = { text: result.message, kind: result.added.length ? "good" : "warn" };
    await paint();
  },
  "clear-found"() { state.foundCodes = null; return paint(); },
  "pick-user"(el) { state.selectedUser = el.dataset.id; return paint(); },
  "pick-team"(el) { state.selectedTeam = el.dataset.id ? Number(el.dataset.id) : null; return paint(); },
  async "create-all-users"() {
    if (!window.confirm("Create a User account with a first password for everyone on the lab directory who has none? "
      + "A file with the passwords downloads once; keep it private.")) return;
    const result = await api("POST", "/api/users/create-all");
    if (result.accounts.length) {
      downloadCsv("IMS_first_passwords.csv", [["Name", "Team", "Emp ID", "Mail ID", "First password"],
        ...result.accounts.map((a) => [a.name, a.team, a.empId, a.email, a.password])]);
    }
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "new-first-password"(el) {
    if (!window.confirm("Give this person a new first password? Their current password stops working.")) return;
    const result = await api("POST", "/api/users/" + encodeURIComponent(el.dataset.id) + "/new-password");
    window.prompt("New first password. Copy it and give it only to this person:", result.password);
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "approve-all-users"() {
    if (!window.confirm("Approve every waiting request as User? Give Admin or Lead roles afterwards, one by one.")) return;
    const result = await api("POST", "/api/users/approve-all");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "reject-user"(el) {
    const result = await api("POST", "/api/users/" + encodeURIComponent(el.dataset.id) + "/reject");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async restore(el) {
    const result = await api("POST", "/api/assets/" + encodeURIComponent(el.dataset.barcode) + "/restore");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async backup() {
    toast("Saving a backup...", "info", "Please wait");
    const result = await api("POST", "/api/backup");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  "ask-return"(el) {
    state.requestPrefill = { kind: "Return", barcode: el.dataset.barcode };
    return go("requests");
  },
  async "approve-request"(el) {
    const id = el.dataset.id;
    const barcodes = [...document.querySelectorAll(`[data-give="${id}"]:checked`)].map((box) => box.value);
    const result = await api("POST", "/api/requests/" + id + "/approve", { barcodes, barcode: val("rq-give-" + id), note: val("rq-note-" + id) });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "reject-request"(el) {
    const id = el.dataset.id;
    const result = await api("POST", "/api/requests/" + id + "/reject", { note: val("rq-note-" + id) });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "cancel-request"(el) {
    const result = await api("POST", "/api/requests/" + el.dataset.id + "/cancel");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "accept-handover"(el) {
    const result = await api("POST", "/api/handovers/" + el.dataset.id + "/accept");
    closeHandoverToasts(el.dataset.id);
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  "decline-handover-ask"(el) {
    document.getElementById("modal-root").innerHTML = `
      <div class="modal-back" data-action="close-modal-back"><div class="modal" role="dialog" aria-label="Reject ${esc(el.dataset.barcode)}">
        <h2>Reject ${esc(el.dataset.barcode)}</h2>
        <p class="sub">The item stays where it is, and the Admin sees your reason.</p>
        <form id="decline-modal-form" data-id="${esc(el.dataset.id)}">
          <label for="dcl-note">Reason <span class="req">*</span></label>
          <input id="dcl-note" maxlength="300" placeholder="For example: not the model I asked for">
          <div class="row"><button class="btn danger" type="submit">Reject</button>
            <button class="btn secondary" type="button" data-action="close-modal">Cancel</button></div>
        </form>
      </div></div>`;
    document.getElementById("dcl-note").focus();
  },
  async "decline-handover"(el) {
    const result = await api("POST", "/api/handovers/" + el.dataset.id + "/decline", { note: val("ho-note-" + el.dataset.id) });
    closeHandoverToasts(el.dataset.id);
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "cancel-handover"(el) {
    const result = await api("POST", "/api/handovers/" + el.dataset.id + "/cancel");
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  "add-choice"(el) { return addChoice(el.dataset.for); },
  "cancel-choice"(el) { cancelChoice(el.dataset.for); },
  async "make-lead"() {
    const empId = val("tm-lead-person");
    if (!empId) throw new Error("Choose the person who should lead.");
    const result = await api("POST", "/api/users/make-lead", { empId, password: val("tm-lead-password") });
    state.pendingLead = result.empId;
    state.flash = { text: result.message + " Press Save team to make them the lead.", kind: "good" };
    await paint();
  },
  "cancel-lead"() {
    setVal("tm-lead", "");
    document.getElementById("tm-lead-add").classList.add("hidden");
  },
  async "add-members"() {
    const add = [...document.getElementById("tm-add").selectedOptions].map((option) => option.value);
    if (!add.length) throw new Error("Select at least one person in the list.");
    const result = await api("POST", "/api/teams/" + state.selectedTeam + "/members", { add });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "remove-members"() {
    const remove = [...document.querySelectorAll("[data-member]:checked")].map((box) => box.dataset.member);
    if (!remove.length) throw new Error("Tick at least one person to take out.");
    const result = await api("POST", "/api/teams/" + state.selectedTeam + "/members", { remove });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  "open-feedback"() { openFeedbackModal(); },
  "close-modal"() { closeModal(); },
  "close-modal-back"(el, event) { if (event.target === el) closeModal(); }
};

const EYE_OPEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SHUT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>`;

// Every password box gets an eye button that shows or hides what was typed.
function addPasswordEyes(root) {
  for (const input of root.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = "1";
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.replaceWith(wrap);
    wrap.innerHTML = `<button type="button" class="pw-eye" data-action="toggle-password" aria-label="Show password" title="Show password">${EYE_OPEN}</button>`;
    wrap.prepend(input);
  }
}

new MutationObserver(() => addPasswordEyes(document.body)).observe(document.body, { childList: true, subtree: true });

clickHandlers["toggle-password"] = (el) => {
  const input = el.parentElement.querySelector("input");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  el.innerHTML = show ? EYE_SHUT : EYE_OPEN;
  el.title = show ? "Hide password" : "Show password";
  el.setAttribute("aria-label", el.title);
  input.focus();
};

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const handler = clickHandlers[el.dataset.action];
  if (!handler) return;
  if (el.tagName === "A") event.preventDefault();
  try {
    await handler(el, event);
  } catch (error) {
    flash(error.message, "bad");
  }
});

// The first visible field marked * that is still empty, with a message naming it.
function missingRequired(form) {
  for (const label of form.querySelectorAll("label[for]")) {
    if (!label.querySelector(".req")) continue;
    const field = document.getElementById(label.htmlFor);
    if (!field || field.disabled || !field.getClientRects().length) continue;
    const value = field.value.trim();
    if (value && !value.startsWith("__")) continue;
    const name = label.firstChild.textContent.trim();
    if (field.tagName === "SELECT") {
      const choices = [...field.options].filter((o) => o.value && !o.value.startsWith("__")).map((o) => o.text);
      const text = choices.length && choices.length <= 4
        ? name + ": choose one of the following - " + choices.join(" or ") + "."
        : name + ": choose an option from the list" + (field.dataset.addList ? ", or add a new one." : ".");
      return { field, text };
    }
    return { field, text: name + " is required. Please fill it in." };
  }
  return null;
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  const missing = missingRequired(form);
  if (missing) {
    toast(missing.text, "warn", "Required field");
    missing.field.focus();
    return;
  }
  if (form.dataset.feedback !== undefined) return sendFeedback();
  const handler = submitHandlers[form.id];
  if (!handler) return;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await handler(form);
  } catch (error) {
    flash(error.message, "bad");
  } finally {
    if (button && document.body.contains(button)) button.disabled = false;
  }
});

const REQUIRED_CHOICE = { "it-room": "storage room", "ed-room": "storage room", "it-type": "asset type", "ed-type": "asset type" };

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.matches("[data-filter]")) {
    state.filters.owner = val("f-owner");
    state.filters.status = val("f-status");
    state.filters.type = val("f-type");
    state.filters.team = val("f-team");
    state.filters.search = val("f-search").trim();
    await paint();
  }
  if (target.dataset.addList) {
    const box = document.getElementById(target.id + "-add");
    if (target.value === "__add__") {
      box.classList.remove("hidden");
      document.getElementById(target.id + "-new").focus();
    } else {
      box.classList.add("hidden");
      target.dataset.prev = target.value;
    }
  }
  if (REQUIRED_CHOICE[target.id] && !target.value) {
    toast("Choose a " + REQUIRED_CHOICE[target.id] + ": pick at least one option, or add a new one.", "warn", "Choose an option");
  }
  if (target.id === "tm-lead") {
    document.getElementById("tm-lead-add").classList.toggle("hidden", target.value !== "__lead__");
  }
  if (target.id === "it-model") suggestModel("it");
  if (target.id === "rq-kind") {
    document.getElementById("rq-need").classList.toggle("hidden", target.value !== "Need");
    document.getElementById("rq-return").classList.toggle("hidden", target.value !== "Return");
  }
  if (target.id === "rq-type") document.getElementById("rq-other-wrap").classList.toggle("hidden", target.value !== "Other");
  if (target.id === "fbm-kind") document.getElementById("fbm-other-wrap").classList.toggle("hidden", target.value !== "Other");
  if (target.id === "rq-pick") {
    const option = target.selectedOptions[0];
    document.getElementById("rq-pick-info").textContent = target.value ? "Chosen: " + option.textContent : "";
    document.getElementById("rq-qty-wrap").classList.toggle("hidden", !!target.value);
    if (target.value) setVal("rq-qty", "1");
    if (target.value) {
      const type = option.textContent.split(" · ")[1] || "";
      if (state.settings.assetTypes.includes(type)) setVal("rq-type", type);
      document.getElementById("rq-other-wrap").classList.toggle("hidden", val("rq-type") !== "Other");
    }
  }
  if (target.dataset.give && target.checked) {
    const max = Number(target.dataset.max) || 1;
    if (document.querySelectorAll(`[data-give="${target.dataset.give}"]:checked`).length > max) {
      target.checked = false;
      toast("This request is for " + max + " item(s). Untick one first.", "warn", "Too many items");
    }
  }
  if (target.id === "tr-barcode" && target.value.trim()) loadTransfer(target.value);
  if (target.dataset.feedbackStatus) {
    try {
      const result = await api("PUT", "/api/feedback/" + target.dataset.feedbackStatus, { status: target.value });
      toast(result.message, "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }
});

// A box with a suggestion list only offers entries matching its text, so once something is chosen the
// list seems gone. Clicking a filled box empties it to show the whole list; leaving it without
// choosing puts the old value back.
function restoreListBox(input) {
  if (input.dataset.was === undefined) return;
  if (!input.value) input.value = input.dataset.was;
  input.placeholder = input.dataset.hint || "";
  delete input.dataset.was;
  delete input.dataset.hint;
}

document.addEventListener("mousedown", (event) => {
  const input = event.target.closest && event.target.closest("input[list]");
  document.querySelectorAll("input[data-was]").forEach((other) => { if (other !== input) restoreListBox(other); });
  if (!input || !input.value || input.dataset.was !== undefined) return;
  input.dataset.was = input.value;
  input.dataset.hint = input.placeholder;
  input.placeholder = input.value;
  input.value = "";
});

document.addEventListener("focusout", (event) => {
  if (event.target.matches && event.target.matches("input[list]")) restoreListBox(event.target);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if (event.key !== "Enter") return;
  if (event.target.id === "it-barcode") {
    event.preventDefault();
    suggestInward(false);
  }
  if (event.target.id === "tr-barcode") {
    event.preventDefault();
    loadTransfer(event.target.value);
  }
  if (event.target.dataset.addFor) {
    event.preventDefault();
    addChoice(event.target.dataset.addFor).catch((error) => toast(error.message, "bad"));
  }
});

document.addEventListener("input", (event) => {
  const list = event.target.list;
  if (event.target.id === "tr-barcode" && list && [...list.options].some((o) => o.value === event.target.value)) {
    loadTransfer(event.target.value);
    return;
  }
  if (event.target.id === "tm-add-filter") {
    const words = event.target.value.trim().toLowerCase();
    document.querySelectorAll("#tm-add option").forEach((option) => {
      option.hidden = !!words && !option.dataset.search.includes(words);
    });
    return;
  }
  const counter = document.querySelector(`[data-count-for="${event.target.id}"]`);
  if (!counter) return;
  const length = event.target.value.trim().length;
  const min = Number(counter.dataset.min);
  counter.textContent = length + " / " + min + " minimum";
  counter.classList.toggle("short", length < min);
});

(async function boot() {
  try {
    state.settings = await api("GET", "/api/settings");
  } catch (error) {
    state.flash = { text: "The server is not answering: " + error.message, kind: "bad" };
  }
  try {
    state.me = await api("GET", "/api/me");
    state.view = state.me.mustChange ? "first-password" : "app";
  } catch {
    state.view = "login";
  }
  await paint();
  if (state.view === "app") {
    checkUpdates();
    showWaitingHandovers();
  }
  setInterval(checkUpdates, UPDATE_SECONDS * 1000);
})();
