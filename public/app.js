"use strict";

const SAMPLE_ACCOUNTS = [
  ["SA001", "1001", "Super Admin"],
  ["AD010", "2001", "Admin"],
  ["LD200", "4001", "Lead (IPSi)"],
  ["EN1042", "3001", "Engineer"]
];

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
  inwardFill: null
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

function flash(text, kind) {
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

function options(list, selected, blankLabel) {
  const blank = blankLabel !== undefined ? `<option value="">${esc(blankLabel)}</option>` : "";
  return blank + list.map((item) => {
    const [value, label] = Array.isArray(item) ? item : [item, item];
    return `<option value="${esc(value)}"${String(value) === String(selected ?? "") ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
}

function ownerPill(value) {
  return `<span class="pill ${value === "Wipro-Specific" ? "wipro" : "amd"}">${esc(value)}</span>`;
}

function expiryPill(asset) {
  if (asset.expiry === "expired") return ' <span class="pill bad">Expired</span>';
  if (asset.expiry === "soon") return ' <span class="pill warn">Expiring</span>';
  return "";
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

function tabsFor() {
  const tabs = [["dashboard", "Dashboard"]];
  if (isCustodian()) tabs.push(["inward", "Inward"], ["transfer", "Transfer"]);
  tabs.push(["requests", "Requests"]);
  if (isSuper()) tabs.push(["accounts", "Accounts"], ["teams", "Teams"], ["deleted", "Deleted assets"]);
  tabs.push(["feedback", "Feedback"], ["account", "My account"]);
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
  else {
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
    <div class="demo">${SAMPLE_ACCOUNTS.map(([id, code, label]) =>
      `<button type="button" data-action="fill-login" data-id="${id}" data-code="${code}">${esc(label)} ${id}</button>`).join("")}</div>
    <p class="fine">Development copy: the buttons above fill in sample accounts.</p>` : "";
  return `
    <div class="auth-screen"><section class="card">
      <div class="brand"><div class="mark">IMS</div><div><h1>Hardware Lab IMS</h1>
        <div class="sub">Sign in with your alias ID or company mail ID.</div></div></div>
      <form id="login-form" autocomplete="off">
        <label for="login-id">Alias ID or mail ID</label>
        <input id="login-id" maxlength="120" autocomplete="username" autofocus>
        <label for="login-code">Access code</label>
        <input id="login-code" type="password" maxlength="32" autocomplete="current-password">
        <div class="row"><button class="btn" type="submit">Sign in</button>
          <button class="btn secondary" type="button" data-action="go-register">Request access</button></div>
      </form>
      ${flashHtml()}
      ${demo}
      <p class="fine">${esc(versionText())}</p>
    </section></div>`;
}

function registerHtml() {
  const roles = state.settings ? state.settings.roles : ["User"];
  return `
    <div class="auth-screen"><section class="card">
      <div class="brand"><div class="mark">IMS</div><div><h1>Request access</h1>
        <div class="sub">Use the alias, mail ID and full name exactly as the Super Admin added them to the lab directory.</div></div></div>
      <form id="register-form" autocomplete="off">
        <label for="reg-alias">Alias ID <span class="req">*</span></label><input id="reg-alias" maxlength="32">
        <label for="reg-name">Full name <span class="req">*</span></label><input id="reg-name" maxlength="120">
        <label for="reg-email">Company mail ID <span class="req">*</span></label><input id="reg-email" type="email" maxlength="120">
        <label for="reg-role">Role you need</label><select id="reg-role">${options(roles, "User")}</select>
        <label for="reg-code">Choose an access code (4 to 32 characters) <span class="req">*</span></label>
        <input id="reg-code" type="password" maxlength="32" autocomplete="new-password">
        <label for="reg-confirm">Type the code again <span class="req">*</span></label>
        <input id="reg-confirm" type="password" maxlength="32" autocomplete="new-password">
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
        <div><strong>${esc(me.empId)} · ${esc(me.name)}</strong><p>${esc(me.role)}${me.teamName ? " · " + esc(me.teamName) : ""}</p></div>
        <button class="btn secondary small" type="button" data-action="open-feedback">Give feedback</button>
        <button class="btn secondary small" type="button" data-action="logout">Sign out</button>
      </div>
    </div></header>
    <main class="wrap">
      <nav class="tabs" aria-label="Screens">${tabsFor().map(([id, label]) =>
        `<button type="button" data-action="tab" data-tab="${id}" aria-selected="${state.tab === id || (state.tab === "asset" && id === "dashboard")}">${esc(label)}</button>`).join("")}</nav>
      <section class="panel">${flashHtml()}${body}</section>
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
    case "deleted": return deletedHtml();
    case "feedback": return feedbackHtml();
    case "account": return accountHtml();
    default: return dashboardHtml();
  }
}

function afterPaint() {
  const first = document.querySelector("[data-autofocus]");
  if (first) first.focus();
}

// ---------- dashboard ----------

function filterQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
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
    ? dash.attention.map((a) => `<li><button type="button" data-action="attention" data-go="${esc(a.go || "")}" data-id="${esc(a.id || "")}" data-barcode="${esc(a.barcode || "")}">
        <span class="tag ${esc(a.kind)}">${esc(a.tag)}</span> ${esc(a.text)}</button></li>`).join("")
    : `<li>Nothing needs attention.</li>`;
  const activity = dash.activity
    ? `<div class="box"><h3>Recent activity</h3><ul>${dash.activity.length ? dash.activity.map((r) => `<li>
        <span class="mono">${esc(when(r.when))}</span> <b>${esc(r.barcode)}</b> ${esc(r.action)}:
        ${esc(r.action === "Transfer" ? r.from + " → " + r.to + " (" + r.toStatus + ")" : r.remarks)} · by ${esc(r.by.split(" ")[0])}</li>`).join("")
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
  return `
    <div class="cards">${cards.map(([label, n, kind, owner, status]) => {
      const active = onlyCardFilters && state.filters.owner === owner && state.filters.status === status;
      return `<button type="button" class="kpi ${kind}" data-action="card-filter" data-owner="${esc(owner)}" data-status="${esc(status)}"
        aria-pressed="${active}" title="Show these items in the hardware list"><strong>${n}</strong><span>${esc(label)}</span></button>`;
    }).join("")}</div>
    <div class="duo ${dash.activity ? "" : "single"}">
      <div class="box"><h3>Needs your attention</h3><ul>${attention}</ul>
        <p class="fine">Expiry warnings start ${s.expiryWarnMonths} months before the expiry date.</p></div>
      ${activity}
    </div>
    ${teamTable}
    <h3 id="hardware-list">Hardware list</h3>
    <form id="filter-form" class="filters">
      <div><label for="f-owner">Ownership</label><select id="f-owner" data-filter>${options(s.owners, f.owner, "All")}</select></div>
      <div><label for="f-status">Status</label><select id="f-status" data-filter>${options(s.statuses, f.status, "All")}</select></div>
      <div><label for="f-type">Type</label><select id="f-type" data-filter>${options(s.assetTypes, f.type, "All")}</select></div>
      <div><label for="f-team">Team</label><select id="f-team" data-filter ${showTeams ? "" : "disabled"}>${options(teamChoices, f.team, "All")}</select></div>
      <div><label for="f-search">Search</label><input id="f-search" value="${esc(f.search)}" placeholder="Barcode, serial, model, person, invoice"></div>
      <div><button class="btn" type="submit">Search</button></div>
    </form>
    <div class="row">${exportLinks}</div>
    <p class="sub">${assets.length} item(s). Select a barcode to see details${isCustodian() ? ", edit or see its history" : ""}.</p>
    <div class="scroll"><table><thead><tr><th>Barcode</th><th>Ownership</th><th>Type</th><th>Model</th><th>Serial</th>
      <th>Status</th><th>Holder</th><th>Team</th><th>Location</th></tr></thead><tbody>
      ${assets.map((a) => `<tr>
        <td><button class="linkish mono" type="button" data-action="open-asset" data-barcode="${esc(a.barcode)}">${esc(a.barcode)}</button></td>
        <td>${ownerPill(a.ownership)}</td><td>${esc(a.assetType)}</td><td>${esc(a.model)}</td><td class="mono">${esc(a.serialNo)}</td>
        <td>${esc(a.status)}${expiryPill(a)}</td>
        <td>${a.holderId ? esc(a.holderId) + "<br><span class='fine'>" + esc(a.holderName) + "</span>" : "-"}</td>
        <td>${esc(a.teamName)}</td><td>${esc(a.place)}</td></tr>`).join("") || `<tr><td colspan="9">No hardware matches.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- asset details ----------

function detailsFormHtml(prefix, a, fixedOwnership) {
  const s = state.settings;
  return `
    <div class="grid3">
      ${fixedOwnership ? "" : `<div><label for="${prefix}-owner">Ownership <span class="req">*</span></label>
        <select id="${prefix}-owner">${options(s.owners, a.ownership)}</select></div>`}
      <div><label for="${prefix}-type">Asset type <span class="req">*</span></label>
        <select id="${prefix}-type">${options(s.assetTypes, a.assetType, "Choose")}</select></div>
      <div><label for="${prefix}-model">Model</label><input id="${prefix}-model" maxlength="80" value="${esc(a.model)}"></div>
      <div><label for="${prefix}-make">Make</label><input id="${prefix}-make" maxlength="80" value="${esc(a.make)}"></div>
      <div><label for="${prefix}-mfr">Manufacturer</label><input id="${prefix}-mfr" maxlength="80" value="${esc(a.manufacturer)}"></div>
      <div><label for="${prefix}-serial">Manufacturer serial no.</label><input id="${prefix}-serial" maxlength="80" value="${esc(a.serialNo)}"></div>
      <div><label for="${prefix}-rev">Capacity / revision</label><input id="${prefix}-rev" maxlength="80" value="${esc(a.capacityRev)}"></div>
      <div><label for="${prefix}-room">Storage room <span class="req">*</span></label>
        <select id="${prefix}-room">${options(s.rooms, a.room, "Choose")}</select></div>
      <div><label for="${prefix}-location">Cupboard / shelf (for example CPU cupboard 3)</label><input id="${prefix}-location" maxlength="80" value="${esc(a.location)}"></div>
      <div><label for="${prefix}-bond">Bond No. (from the AMD label)</label><input id="${prefix}-bond" maxlength="40" value="${esc(a.bondNo)}" placeholder="For example 266/2026-27 or NA"></div>
      <div><label for="${prefix}-expiry">Expiry date (optional)</label><input id="${prefix}-expiry" type="date" value="${esc(a.expiryDate)}"></div>
      <div class="span-3"><label for="${prefix}-desc">Description (the text printed on the label)</label><input id="${prefix}-desc" maxlength="500" value="${esc(a.description)}"></div>
    </div>`;
}

function readDetails(prefix) {
  return {
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
    ["Status", esc(a.status) + expiryPill(a)], ["Holder", a.holderId ? esc(a.holderId + " " + a.holderName) : "Nobody (in the cage)"],
    ["Team", esc(a.teamName)], ["Where now", esc(a.place)],
    ["Kept in (when free)", esc([a.room, a.location].filter(Boolean).join(", "))], ["Expiry date", esc(a.expiryDate || "Not set")],
    ["Invoice / PO", esc([a.invoiceNo, a.poNumber].filter(Boolean).join(" / "))], ["Bond No.", esc(a.bondNo)],
    ["Arrived", esc(a.arrivalDate)]];
  let html = `
    <div class="row"><button class="btn secondary small" type="button" data-action="tab" data-tab="dashboard">← Back to the list</button></div>
    <h2 class="mono">${esc(a.barcode)}</h2>
    <dl class="details">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v || "-"}</dd>`).join("")}</dl>`;
  if (isCustodian()) {
    html += `
      <h3>Edit details</h3>
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
      <h3>Delete (Super Admin only)</h3>
      <p class="sub">The item is hidden from every list and the deletion is logged. It can be restored from Deleted assets.</p>
      <form id="delete-form" data-barcode="${esc(a.barcode)}" class="grid">
        <div><label for="del-reason">Reason <span class="req">*</span></label><input id="del-reason" maxlength="300" placeholder="For example: entered twice by mistake"></div>
        <div><label>&nbsp;</label><button class="btn danger" type="submit">Delete ${esc(a.barcode)}</button></div>
      </form>`;
  }
  return html;
}

// ---------- inward (consignments) ----------

async function inwardHtml() {
  const s = state.settings;
  const list = await api("GET", "/api/consignments");
  const today = new Date().toISOString().slice(0, 10);
  return `
    <h2>Inward by consignment</h2>
    <p class="sub">Step 1: record the package (invoice, PO, date, number of items). Step 2: upload the scanned documents. Step 3: scan each item.</p>
    <div class="duo wide-left">
      <div>
        <h3>Consignments</h3>
        <div class="scroll"><table><thead><tr><th>Invoice</th><th>PO</th><th>Arrived</th><th>Items</th><th>Documents</th><th>Ownership</th></tr></thead><tbody>
        ${list.map((c) => `<tr class="clickable" data-action="open-consignment" data-id="${c.id}">
          <td><b>${esc(c.invoiceNo)}</b></td><td>${esc(c.poNumber)}</td><td>${esc(c.receivedDate)}</td>
          <td>${c.scannedItems} of ${c.expectedItems} ${c.scannedItems >= c.expectedItems ? '<span class="pill ok">Done</span>' : '<span class="pill warn">Open</span>'}</td>
          <td>${c.documentCount ? c.documentCount : '<span class="pill bad">None</span>'}</td><td>${ownerPill(c.ownership)}</td></tr>`).join("")
          || `<tr><td colspan="6">No consignments yet.</td></tr>`}
        </tbody></table></div>
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

async function consignmentHtml() {
  const { consignment: c, documents, items } = await api("GET", "/api/consignments/" + state.consignmentId);
  const full = c.scannedItems >= c.expectedItems;
  const canScan = !full;
  const fill = state.inwardFill || {};
  const noDocs = !documents.length;
  const scanNote = full ? "All items are scanned. Raise the number of items above if more came in this package."
    : noDocs ? "Upload the scanned invoice or delivery note first. If there is no document yet, tick \"No document yet\" below and give the reason."
    : "";
  const noDocBlock = noDocs ? `
            <div class="box warn-box">
              <label class="check"><input id="it-nodoc" type="checkbox" ${fill.noDocumentReason ? "checked" : ""}> No document yet: add items now, upload the document later</label>
              <label for="it-nodoc-reason">Reason (at least ${state.settings.noDocumentReasonMin} characters)</label>
              <input id="it-nodoc-reason" maxlength="200" value="${esc(fill.noDocumentReason || "")}" placeholder="For example: invoice is with the purchase team">
              <p class="fine">The reason is saved in each item's history, and this consignment stays under "Needs your attention" until a document is uploaded.</p>
            </div>` : "";
  return `
    <div class="row"><button class="btn secondary small" type="button" data-action="close-consignment">← All consignments</button></div>
    <h2>Invoice ${esc(c.invoiceNo)} · PO ${esc(c.poNumber)}</h2>
    <dl class="details">
      <dt>Received</dt><dd>${esc(c.receivedDate)}</dd>
      <dt>Ownership</dt><dd>${ownerPill(c.ownership)}</dd>
      <dt>Supplier</dt><dd>${esc(c.supplier || "-")}</dd>
      <dt>Recorded by</dt><dd>${esc(c.createdBy + " " + c.createdByName)} on ${esc(when(c.createdAt))}</dd>
      <dt>Progress</dt><dd><progress max="${c.expectedItems}" value="${c.scannedItems}"></progress> ${c.scannedItems} of ${c.expectedItems} items scanned</dd>
    </dl>
    <form id="consignment-edit" class="grid3">
      <div><label for="ce-count">Number of items</label><input id="ce-count" type="number" min="1" max="1000" value="${c.expectedItems}"></div>
      <div><label for="ce-supplier">Supplier</label><input id="ce-supplier" maxlength="120" value="${esc(c.supplier)}"></div>
      <div><label for="ce-remarks">Remarks</label><input id="ce-remarks" maxlength="500" value="${esc(c.remarks)}"></div>
      <div class="span-3"><button class="btn secondary small" type="submit">Save consignment changes</button></div>
    </form>
    <div class="steps">
      <div class="step">
        <h3>Documents (invoice, delivery note)</h3>
        <ul>${documents.map((d) => `<li><a href="/api/documents/${d.id}" target="_blank" rel="noopener">${esc(d.name)}</a>
          <span class="fine">${Math.ceil(d.size / 1024)} KB · ${esc(d.uploadedBy)} · ${esc(when(d.uploadedAt))}</span></li>`).join("") || "<li>No documents yet.</li>"}</ul>
        <form id="doc-form" class="row">
          <input id="doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">
          <button class="btn" type="submit">Upload</button>
        </form>
        <p class="fine">PDF, JPG or PNG, up to 10 MB each.</p>
      </div>
      <div class="step ${canScan ? "" : "off"}">
        <h3>Scan an item</h3>
        <p class="sub">${esc(scanNote || "Scan the barcode and press Enter. Known details fill in automatically.")}</p>
        <form id="item-form">
          <fieldset ${canScan ? "" : "disabled"} class="plain">
            ${noDocBlock}
            <label for="it-barcode">Barcode <span class="req">*</span></label><input id="it-barcode" maxlength="64" class="mono" value="${esc(fill.barcode || "")}" ${canScan ? "data-autofocus" : ""} placeholder="Scan, or type it, for example EMBLAB30890">
            ${detailsFormHtml("it", { ...fill, room: fill.room || state.settings.rooms[0], ownership: c.ownership }, true)}
            <label for="it-holder">Give to (alias ID, optional)</label><input id="it-holder" maxlength="32" placeholder="Leave blank to keep it in its storage room">
            <div class="row"><button class="btn" type="submit">Save item</button>
              <button class="btn secondary" type="button" data-action="clear-item">Clear</button></div>
          </fieldset>
        </form>
      </div>
    </div>
    <h3>Items in this consignment</h3>
    <div class="scroll"><table><thead><tr><th>Barcode</th><th>Type</th><th>Model</th><th>Serial</th><th>Status</th><th>Holder</th><th>Scanned</th></tr></thead><tbody>
      ${items.map((i) => `<tr><td class="mono">${i.deleted ? esc(i.barcode) + ' <span class="pill bad">Deleted</span>'
        : `<button class="linkish mono" type="button" data-action="open-asset" data-barcode="${esc(i.barcode)}">${esc(i.barcode)}</button>`}</td>
        <td>${esc(i.assetType)}</td><td>${esc(i.model)}</td><td class="mono">${esc(i.serialNo)}</td><td>${esc(i.status)}</td>
        <td>${esc(i.holderId || "-")}</td><td>${esc(i.createdBy)} · ${esc(when(i.createdAt))}</td></tr>`).join("") || `<tr><td colspan="7">No items yet.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- transfer ----------

async function transferHtml() {
  const s = state.settings;
  let summary = `<p class="sub">Scan or type a barcode and press Enter.</p>`;
  let history = "";
  const a = state.transferAsset;
  if (a) {
    summary = `<dl class="details">
      <dt>Item</dt><dd>${ownerPill(a.ownership)} ${esc(a.assetType)} · ${esc(a.model || "no model")}</dd>
      <dt>Current holder</dt><dd>${a.holderId ? esc(a.holderId + " " + a.holderName) + " (" + esc(a.teamName) + ")" : "Nobody (in the cage)"}</dd>
      <dt>Status</dt><dd>${esc(a.status)}${expiryPill(a)}</dd>
      <dt>Where now</dt><dd>${esc(a.place || "-")}</dd></dl>`;
    history = `<h3>History of ${esc(a.barcode)}</h3>${historyTable(state.transferHistory || [])}`;
  }
  return `
    <h2>Transfer</h2>
    <div class="duo">
      <form id="transfer-form">
        <label for="tr-barcode">Barcode <span class="req">*</span></label>
        <input id="tr-barcode" class="mono" maxlength="64" value="${esc(a ? a.barcode : "")}" data-autofocus>
        ${summary}
        <label for="tr-status">New status <span class="req">*</span></label>
        <select id="tr-status">${options(s.statuses, "Assigned to Engineer")}</select>
        <label for="tr-holder">Give to (alias ID)</label><input id="tr-holder" maxlength="32" placeholder="Needed for Assigned to Engineer">
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
  return "Needs " + (r.assetType || "hardware") + " - " + r.details + (r.barcode ? " → given " + r.barcode : "");
}

async function requestsHtml() {
  const s = state.settings;
  const [requests, assets] = await Promise.all([api("GET", "/api/requests"), api("GET", "/api/assets")]);
  const mineHeld = assets.filter((a) => a.holderId === state.me.empId);
  const prefill = state.requestPrefill || {};
  const kind = prefill.kind || "Need";
  const form = `
    <form id="request-form" class="box">
      <h3>New request</h3>
      <label for="rq-kind">What do you need? <span class="req">*</span></label>
      <select id="rq-kind">${options([["Need", "I need hardware"], ["Return", "Please take back an item I hold"]], kind)}</select>
      <div id="rq-need" class="${kind === "Need" ? "" : "hidden"}">
        <label for="rq-type">Type of hardware</label><select id="rq-type">${options(s.assetTypes, "", "Any / not sure")}</select>
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
  const handleTable = isCustodian() ? `
    <h3>Open requests to handle (${open.length})</h3>
    <p class="sub">Approving makes the transfer and logs it. For "Needs hardware", enter the barcode of a free item from the cage.</p>
    <div class="scroll"><table><thead><tr><th>Asked</th><th>Person</th><th>Request</th><th>Handle</th></tr></thead><tbody>
      ${open.map((r) => `<tr><td class="mono">${esc(when(r.createdAt))}</td>
        <td>${esc(r.empId)} ${esc(r.empName)}<br><span class="fine">${esc(r.teamName || "No team")}</span></td>
        <td>${esc(requestText(r))}</td>
        <td>
          ${r.kind === "Need" ? `<input id="rq-give-${r.id}" class="mono" maxlength="64" placeholder="Barcode to give">` : ""}
          <input id="rq-note-${r.id}" maxlength="300" placeholder="Note (needed to reject)">
          <div class="row">
            <button class="btn small" type="button" data-action="approve-request" data-id="${r.id}">${r.kind === "Return" ? "Approve: back to cage" : "Approve and assign"}</button>
            <button class="btn danger small" type="button" data-action="reject-request" data-id="${r.id}">Reject</button>
          </div>
        </td></tr>`).join("") || `<tr><td colspan="4">No open requests.</td></tr>`}
    </tbody></table></div>` : "";
  const listRows = isCustodian() ? done : requests;
  const listTable = `
    <h3>${isCustodian() ? "Earlier requests" : "My requests"}</h3>
    <div class="scroll"><table><thead><tr><th>Asked</th>${isCustodian() ? "<th>Person</th>" : ""}<th>Request</th><th>Status</th><th>Decided by</th><th>Note</th><th></th></tr></thead><tbody>
      ${listRows.map((r) => `<tr><td class="mono">${esc(when(r.createdAt))}</td>
        ${isCustodian() ? `<td>${esc(r.empId)} ${esc(r.empName)}</td>` : ""}
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

// ---------- accounts, teams, deleted ----------

async function accountsHtml() {
  const [users, teams, directory] = await Promise.all([api("GET", "/api/users"), api("GET", "/api/teams"), api("GET", "/api/directory")]);
  const s = state.settings;
  const picked = users.find((u) => u.empId === state.selectedUser);
  const teamOptions = teams.map((t) => [String(t.id), t.name]);
  const editor = picked ? `
    <form id="user-form" class="box" data-id="${esc(picked.empId)}">
      <h3>${esc(picked.empId)} · ${esc(picked.name)}</h3>
      <p class="sub">${esc(picked.email)} · asked for ${esc(picked.requestedRole)} · ${esc(picked.state)}</p>
      <label for="us-role">Role</label><select id="us-role">${options(s.roles, picked.role)}</select>
      <label for="us-team">Team</label><select id="us-team">${options(teamOptions, picked.teamId, "No team")}</select>
      <label><input id="us-active" type="checkbox" ${picked.state === "Active" || picked.state === "Pending" ? "checked" : ""}> Approve / active</label>
      <div class="row"><button class="btn" type="submit">Save</button>
        ${picked.state === "Pending" ? `<button class="btn danger" type="button" data-action="reject-user" data-id="${esc(picked.empId)}">Reject request</button>` : ""}</div>
    </form>` : `<div class="box"><p class="sub">Select an account to approve it, change the role or team, or turn it off.</p></div>`;
  return `
    <h2>Accounts</h2>
    <div class="duo wide-left">
      <div class="scroll"><table><thead><tr><th>Alias</th><th>Name</th><th>Mail ID</th><th>Role</th><th>Team</th><th>State</th></tr></thead><tbody>
        ${users.map((u) => `<tr class="clickable ${u.empId === state.selectedUser ? "picked" : ""}" data-action="pick-user" data-id="${esc(u.empId)}">
          <td class="mono">${esc(u.empId)}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.teamName || "-")}</td>
          <td><span class="pill ${u.state === "Active" ? "ok" : u.state === "Pending" ? "warn" : "muted"}">${esc(u.state)}</span></td></tr>`).join("")}
      </tbody></table></div>
      ${editor}
    </div>
    <h3>Lab directory (people allowed to request access)</h3>
    <div class="duo">
      <form id="directory-form" class="box">
        <h3>Add or update one person</h3>
        <div class="grid">
          <div><label for="dir-alias">Alias ID <span class="req">*</span></label><input id="dir-alias" maxlength="32"></div>
          <div><label for="dir-email">Mail ID <span class="req">*</span></label><input id="dir-email" maxlength="120"></div>
          <div><label for="dir-name">Full name <span class="req">*</span></label><input id="dir-name" maxlength="120"></div>
          <div><label for="dir-team">Team</label><select id="dir-team">${options(teamOptions, "", "No team")}</select></div>
        </div>
        <div class="row"><button class="btn" type="submit">Save to directory</button></div>
      </form>
      <form id="import-form" class="box">
        <h3>Import many people</h3>
        <label for="imp-text">One person per line: alias, mail ID, full name, team (team is optional)</label>
        <textarea id="imp-text" placeholder="EN3001, name.surname@company.com, Full Name, IPSi"></textarea>
        <div class="row"><button class="btn" type="submit">Import</button></div>
      </form>
    </div>
    <div class="scroll"><table><thead><tr><th>Alias</th><th>Name</th><th>Mail ID</th><th>Team</th><th>Account</th></tr></thead><tbody>
      ${directory.map((d) => `<tr><td class="mono">${esc(d.alias)}</td><td>${esc(d.name)}</td><td>${esc(d.email)}</td><td>${esc(d.teamName || "-")}</td>
        <td>${d.hasAccount ? "Yes" : "Not yet"}</td></tr>`).join("")}
    </tbody></table></div>
    ${state.settings.showSampleAccounts ? `
      <h3>Reset sample data (development copy only)</h3>
      <form id="reset-form" class="grid"><div><label for="reset-confirm">Type RESET</label><input id="reset-confirm" maxlength="5"></div>
        <div><label>&nbsp;</label><button class="btn danger" type="submit">Restore sample data</button></div></form>` : ""}`;
}

async function teamsHtml() {
  const [teams, users] = await Promise.all([api("GET", "/api/teams"), api("GET", "/api/users")]);
  const leads = users.filter((u) => u.role !== "User" && u.state === "Active").map((u) => [u.empId, u.empId + " " + u.name + " (" + u.role + ")"]);
  const picked = teams.find((t) => t.id === state.selectedTeam);
  return `
    <h2>Teams</h2>
    <p class="sub">A Lead Admin sees the hardware of every person in the teams they lead. Set a person's team on the Accounts screen.</p>
    <div class="duo wide-left">
      <div class="scroll"><table><thead><tr><th>Team</th><th>Lead</th><th class="right">Active members</th></tr></thead><tbody>
        ${teams.map((t) => `<tr class="clickable ${t.id === state.selectedTeam ? "picked" : ""}" data-action="pick-team" data-id="${t.id}">
          <td><b>${esc(t.name)}</b></td><td>${esc(t.leadId ? t.leadId + " " + t.leadName : "Not set")}</td><td class="right">${t.members}</td></tr>`).join("")
          || `<tr><td colspan="3">No teams yet.</td></tr>`}
      </tbody></table></div>
      <form id="team-form" class="box" data-id="${picked ? picked.id : ""}">
        <h3>${picked ? "Edit " + esc(picked.name) : "Add a team"}</h3>
        <label for="tm-name">Team name <span class="req">*</span></label><input id="tm-name" maxlength="80" value="${esc(picked ? picked.name : "")}">
        <label for="tm-lead">Lead Admin</label><select id="tm-lead">${options(leads, picked ? picked.leadId : "", "Not set")}</select>
        <div class="row"><button class="btn" type="submit">${picked ? "Save team" : "Add team"}</button>
          ${picked ? `<button class="btn secondary" type="button" data-action="pick-team" data-id="">New team</button>` : ""}</div>
      </form>
    </div>`;
}

async function deletedHtml() {
  const rows = await api("GET", "/api/assets/deleted");
  return `
    <h2>Deleted assets</h2>
    <p class="sub">Deleted items are hidden from every list. Restore puts an item back exactly as it was.</p>
    <div class="scroll"><table><thead><tr><th>Barcode</th><th>Type</th><th>Model</th><th>Deleted</th><th>By</th><th>Reason</th><th></th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td class="mono">${esc(a.barcode)}</td><td>${esc(a.assetType)}</td><td>${esc(a.model)}</td>
        <td>${esc(when(a.deletedAt))}</td><td>${esc(a.deletedBy)}</td><td>${esc(a.deleteReason)}</td>
        <td><button class="btn secondary small" type="button" data-action="restore" data-barcode="${esc(a.barcode)}">Restore</button></td></tr>`).join("")
        || `<tr><td colspan="7">Nothing has been deleted.</td></tr>`}
    </tbody></table></div>`;
}

// ---------- feedback ----------

function feedbackFormHtml(idPrefix) {
  const s = state.settings;
  return `
    <form id="${idPrefix}-form" data-feedback>
      <p class="sub">Sent with your name (${esc(state.me.name)}), mail ID (${esc(state.me.email)}) and the time.</p>
      <label for="${idPrefix}-kind">Type <span class="req">*</span></label>
      <select id="${idPrefix}-kind">${options(s.feedbackKinds, "", "Choose")}</select>
      <label for="${idPrefix}-title">Title <span class="req">*</span> <span class="counter short" data-count-for="${idPrefix}-title" data-min="${s.feedbackTitleMin}">0 / ${s.feedbackTitleMin} minimum</span></label>
      <input id="${idPrefix}-title" maxlength="150">
      <label for="${idPrefix}-desc">Description <span class="req">*</span> <span class="counter short" data-count-for="${idPrefix}-desc" data-min="${s.feedbackDescriptionMin}">0 / ${s.feedbackDescriptionMin} minimum</span></label>
      <textarea id="${idPrefix}-desc" maxlength="4000"></textarea>
      <label for="${idPrefix}-shot">Screenshot (optional, PNG or JPG, up to 5 MB)</label>
      <input id="${idPrefix}-shot" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg">
      <div class="row"><button class="btn" type="submit">Send feedback</button>
        ${idPrefix === "fbm" ? `<button class="btn secondary" type="button" data-action="close-modal">Cancel</button>` : ""}</div>
      <div id="${idPrefix}-status" class="status"></div>
    </form>`;
}

async function feedbackHtml() {
  let list = "";
  if (isCustodian()) {
    const rows = await api("GET", "/api/feedback");
    list = `
      <h3>Feedback received</h3>
      <div class="scroll"><table><thead><tr><th>When</th><th>Type</th><th>Title and description</th><th>From</th><th>Screenshot</th><th>Status</th></tr></thead><tbody>
        ${rows.map((f) => `<tr><td class="mono">${esc(when(f.createdAt))}</td><td>${esc(f.kind)}</td>
          <td><b>${esc(f.title)}</b><br>${esc(f.description)}${f.screen ? `<br><span class="fine">Screen: ${esc(f.screen)}</span>` : ""}</td>
          <td>${esc(f.person)}<br><span class="fine">${esc(f.email)} · ${esc(f.role)}</span></td>
          <td>${f.hasScreenshot ? `<a href="/api/feedback/${f.id}/screenshot" target="_blank" rel="noopener">Open</a>` : "-"}</td>
          <td><select data-feedback-status="${f.id}">${options(state.settings.feedbackStatuses, f.status)}</select></td></tr>`).join("")
          || `<tr><td colspan="6">No feedback yet.</td></tr>`}
      </tbody></table></div>`;
  }
  return `<h2>Feedback</h2><div class="duo ${list ? "" : "single"}"><div class="box">${feedbackFormHtml("fb")}</div></div>${list}`;
}

function openFeedbackModal() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-back" data-action="close-modal-back"><div class="modal" role="dialog" aria-label="Give feedback">
      <h2>Give feedback</h2>${feedbackFormHtml("fbm")}</div></div>`;
  document.getElementById("fbm-kind").focus();
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

// ---------- my account ----------

async function accountHtml() {
  const me = await api("GET", "/api/me");
  state.me = me;
  return `
    <h2>My account</h2>
    <dl class="details">
      <dt>Alias ID</dt><dd>${esc(me.empId)}</dd><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Mail ID</dt><dd>${esc(me.email)}</dd>
      <dt>Role</dt><dd>${esc(me.role)}</dd><dt>Team</dt><dd>${esc(me.teamName || "No team")}</dd>
      <dt>Team lead</dt><dd>${esc(me.lead || "-")}</dd>
      ${me.ledTeams.length ? `<dt>Teams I lead</dt><dd>${esc(me.ledTeams.join(", "))}</dd>` : ""}
    </dl>
    <h3>Change access code</h3>
    <form id="code-form" class="grid3">
      <div><label for="cc-current">Current code</label><input id="cc-current" type="password" maxlength="32" autocomplete="current-password"></div>
      <div><label for="cc-next">New code</label><input id="cc-next" type="password" maxlength="32" autocomplete="new-password"></div>
      <div><label for="cc-confirm">New code again</label><input id="cc-confirm" type="password" maxlength="32" autocomplete="new-password"></div>
      <div><button class="btn" type="submit">Change code</button></div>
    </form>`;
}

// ---------- actions ----------

async function go(tab) {
  state.tab = tab;
  state.flash = null;
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
  state.flash = null;
  await paint();
}

async function loadTransfer(barcode) {
  const code = barcode.toUpperCase().replace(/\s+/g, "");
  try {
    const data = await api("GET", "/api/assets/" + encodeURIComponent(code));
    state.transferAsset = data.asset;
    state.transferHistory = data.history || [];
    state.flash = { text: "Item loaded. Choose the new status and record the transfer.", kind: "good" };
  } catch (error) {
    state.transferAsset = null;
    state.transferHistory = [];
    state.flash = { text: error.message.includes("not in your list") ? "Barcode " + code + " is not in the lab list. Use Inward to add it." : error.message, kind: "bad" };
  }
  await paint();
}

async function suggestInward() {
  const barcode = val("it-barcode").toUpperCase().replace(/[\s*]+/g, "");
  setVal("it-barcode", barcode);
  if (!barcode) return;
  try {
    const data = await api("GET", "/api/assets/suggest?barcode=" + encodeURIComponent(barcode)
      + "&consignment=" + encodeURIComponent(state.consignmentId || ""));
    if (data.existing) {
      flash(barcode + " is already on file (" + data.existing.model + "). Open it from the Dashboard to edit it.", "bad");
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
    if (f.room) setVal("it-room", f.room);
    fillIfEmpty("it-location", f.location);
    flash(data.source ? "New barcode. Details were filled from " + data.source + ". Check them and add the serial number."
      : "New barcode. Fill in the details from the label.", "good");
    document.getElementById("it-serial").focus();
  } catch (error) {
    flash(error.message, "bad");
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

const submitHandlers = {
  async "login-form"() {
    await api("POST", "/api/login", { login: val("login-id"), code: val("login-code") });
    await startApp();
  },
  async "register-form"() {
    const result = await api("POST", "/api/register", {
      alias: val("reg-alias"), name: val("reg-name"), email: val("reg-email"), requestedRole: val("reg-role"),
      code: val("reg-code"), confirm: val("reg-confirm")
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
    if (!window.confirm("Delete " + barcode + "? It can be restored later from Deleted assets.")) return;
    const result = await api("POST", "/api/assets/" + encodeURIComponent(barcode) + "/delete", { reason: val("del-reason") });
    state.tab = "dashboard";
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "consignment-form"() {
    const result = await api("POST", "/api/consignments", {
      invoiceNo: val("cn-invoice"), poNumber: val("cn-po"), receivedDate: val("cn-date"), expectedItems: Number(val("cn-count")),
      ownership: val("cn-owner"), supplier: val("cn-supplier"), remarks: val("cn-remarks")
    });
    state.consignmentId = result.id;
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "consignment-edit"() {
    const result = await api("PUT", "/api/consignments/" + state.consignmentId, {
      expectedItems: Number(val("ce-count")), supplier: val("ce-supplier"), remarks: val("ce-remarks")
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "doc-form"() {
    const file = await readFile("doc-file", 10);
    if (!file) throw new Error("Choose a PDF, JPG or PNG file first.");
    flash("Uploading...", "");
    const result = await api("POST", "/api/consignments/" + state.consignmentId + "/documents", { file });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "item-form"() {
    const details = readDetails("it");
    delete details.ownership;
    const noDoc = document.getElementById("it-nodoc");
    const noDocumentReason = noDoc && noDoc.checked ? val("it-nodoc-reason").trim() : "";
    if (noDoc && !noDoc.checked) {
      throw new Error("Upload the scanned document first, or tick \"No document yet\" and give the reason.");
    }
    const result = await api("POST", "/api/consignments/" + state.consignmentId + "/items", {
      barcode: val("it-barcode"), holderId: val("it-holder"), noDocumentReason, ...details
    });
    const keep = { assetType: details.assetType, manufacturer: details.manufacturer, make: details.make, model: details.model,
      capacityRev: details.capacityRev, description: details.description, bondNo: details.bondNo, room: details.room,
      location: details.location, expiryDate: details.expiryDate, noDocumentReason };
    state.inwardFill = keep;
    state.flash = { text: result.message + " Scan the next barcode.", kind: "good" };
    await paint();
  },
  async "transfer-form"() {
    const a = state.transferAsset;
    const typed = val("tr-barcode").toUpperCase().replace(/\s+/g, "");
    if (!a || a.barcode !== typed) return loadTransfer(typed);
    const result = await api("POST", "/api/assets/" + encodeURIComponent(a.barcode) + "/transfer", {
      status: val("tr-status"), holderId: val("tr-holder"), remarks: val("tr-remarks"), revision: a.revision
    });
    await loadTransfer(a.barcode);
    flash(result.message, "good");
  },
  async "user-form"(form) {
    const result = await api("PUT", "/api/users/" + encodeURIComponent(form.dataset.id), {
      role: val("us-role"), teamId: val("us-team"), active: document.getElementById("us-active").checked
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "directory-form"() {
    const result = await api("POST", "/api/directory", {
      alias: val("dir-alias"), email: val("dir-email"), name: val("dir-name"), teamId: val("dir-team")
    });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "import-form"() {
    const result = await api("POST", "/api/directory/import", { text: val("imp-text") });
    state.flash = { text: result.message + (result.problems.length ? " " + result.problems.join(" ") : ""), kind: result.problems.length ? "bad" : "good" };
    await paint();
  },
  async "reset-form"() {
    const result = await api("POST", "/api/dev/reset", { confirm: val("reset-confirm") });
    state.selectedUser = "";
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "team-form"(form) {
    const body = { name: val("tm-name"), leadId: val("tm-lead") };
    const result = form.dataset.id
      ? await api("PUT", "/api/teams/" + form.dataset.id, body)
      : await api("POST", "/api/teams", body);
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "request-form"() {
    const kind = val("rq-kind");
    const result = await api("POST", "/api/requests", {
      kind, assetType: val("rq-type"), barcode: kind === "Return" ? val("rq-barcode") : "", details: val("rq-details")
    });
    state.requestPrefill = null;
    state.flash = { text: result.message, kind: "good" };
    await paint();
  },
  async "code-form"() {
    const result = await api("POST", "/api/me/code", { current: val("cc-current"), next: val("cc-next"), confirm: val("cc-confirm") });
    state.flash = { text: result.message, kind: "good" };
    await paint();
  }
};

async function sendFeedback(prefix) {
  const statusNode = document.getElementById(prefix + "-status");
  const say = (text, kind) => { statusNode.textContent = text; statusNode.className = "status " + kind; };
  try {
    const s = state.settings;
    const title = val(prefix + "-title").trim();
    const description = val(prefix + "-desc").trim();
    if (!val(prefix + "-kind")) throw new Error("Choose a feedback type.");
    if (title.length < s.feedbackTitleMin) throw new Error("The title must be at least " + s.feedbackTitleMin + " characters.");
    if (description.length < s.feedbackDescriptionMin) throw new Error("The description must be at least " + s.feedbackDescriptionMin + " characters.");
    const screenshot = await readFile(prefix + "-shot", 5);
    say("Sending...", "");
    const result = await api("POST", "/api/feedback", {
      kind: val(prefix + "-kind"), title, description, screenshot, screen: state.tab
    });
    if (prefix === "fbm") {
      closeModal();
      flash(result.message, "good");
    } else {
      state.flash = { text: result.message, kind: "good" };
      await paint();
    }
  } catch (error) {
    say(error.message, "bad");
  }
}

const clickHandlers = {
  "fill-login"(el) { setVal("login-id", el.dataset.id); setVal("login-code", el.dataset.code); },
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
    if (el.dataset.go === "inward" && el.dataset.id) { state.consignmentId = Number(el.dataset.id); state.tab = "inward"; state.flash = null; return paint(); }
    if (el.dataset.go) return go(el.dataset.go);
    return null;
  },
  "open-consignment"(el) { state.consignmentId = Number(el.dataset.id); state.inwardFill = null; state.flash = null; return paint(); },
  "close-consignment"() { state.consignmentId = null; state.flash = null; return paint(); },
  "clear-item"() { state.inwardFill = null; state.flash = null; return paint(); },
  "pick-user"(el) { state.selectedUser = el.dataset.id; state.flash = null; return paint(); },
  "pick-team"(el) { state.selectedTeam = el.dataset.id ? Number(el.dataset.id) : null; state.flash = null; return paint(); },
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
    flash("Saving a backup...", "");
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
    const result = await api("POST", "/api/requests/" + id + "/approve", { barcode: val("rq-give-" + id), note: val("rq-note-" + id) });
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
  "open-feedback"() { openFeedbackModal(); },
  "close-modal"() { closeModal(); },
  "close-modal-back"(el, event) { if (event.target === el) closeModal(); }
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

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  if (form.dataset.feedback !== undefined) return sendFeedback(form.id.replace("-form", ""));
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
  if (target.id === "it-model") suggestModel("it");
  if (target.id === "rq-kind") {
    document.getElementById("rq-need").classList.toggle("hidden", target.value !== "Need");
    document.getElementById("rq-return").classList.toggle("hidden", target.value !== "Return");
  }
  if (target.dataset.feedbackStatus) {
    try {
      const result = await api("PUT", "/api/feedback/" + target.dataset.feedbackStatus, { status: target.value });
      flash(result.message, "good");
    } catch (error) {
      flash(error.message, "bad");
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if (event.key !== "Enter") return;
  if (event.target.id === "it-barcode") {
    event.preventDefault();
    suggestInward();
  }
  if (event.target.id === "tr-barcode") {
    event.preventDefault();
    loadTransfer(event.target.value);
  }
});

document.addEventListener("input", (event) => {
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
    state.view = "app";
  } catch {
    state.view = "login";
  }
  paint();
})();
