// ---- state ----
let currentLang = "fr";
let vaultPassword = null; // kept only in memory for this session, needed to re-encrypt on every change

// window.go.main.App.<Method> is injected automatically by the Wails runtime
// at startup — no build step / generated bindings required.
const backend = () => window.go.main.App;

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.getElementById("lang-prompt").textContent = t("langPrompt");
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(message, kind) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast " + (kind || "");
  setTimeout(() => { el.className = "toast hidden"; }, 3000);
}

// ---- screen 1: language ----
function buildLangGrid() {
  const grid = document.getElementById("lang-grid");
  grid.innerHTML = "";
  LANGUAGES.forEach((l) => {
    const btn = document.createElement("button");
    btn.textContent = l.label;
    btn.onclick = () => {
      currentLang = l.code;
      applyI18n();
      afterLanguageChosen();
    };
    grid.appendChild(btn);
  });
}

async function afterLanguageChosen() {
  const exists = await backend().HasExistingBase();
  if (exists) {
    showScreen("screen-unlock");
  } else {
    showScreen("screen-base-choice");
  }
}

// ---- screen 2a: create vs import ----
document.getElementById("btn-create-base").onclick = () => showScreen("screen-create-pass");
document.getElementById("btn-import-base").onclick = () => showScreen("screen-import");

// ---- screen 2b: create new vault ----
document.getElementById("btn-confirm-create").onclick = async () => {
  const p1 = document.getElementById("input-new-pass").value;
  const p2 = document.getElementById("input-new-pass-confirm").value;
  const errEl = document.getElementById("create-error");
  errEl.textContent = "";

  if (!p1 || p1 !== p2) {
    errEl.textContent = t("passMismatch");
    return;
  }
  const err = await backend().CreateBase(p1);
  if (err) {
    errEl.textContent = err;
    return;
  }
  vaultPassword = p1;
  await enterMainScreen();
};

// ---- screen 2c: import existing base.cd ----
document.getElementById("btn-confirm-import").onclick = async () => {
  const path = document.getElementById("input-import-path").value;
  const pass = document.getElementById("input-import-pass").value;
  const errEl = document.getElementById("import-error");
  errEl.textContent = "";

  const err = await backend().ImportBase(path, pass);
  if (err) {
    errEl.textContent = err;
    return;
  }
  vaultPassword = pass;
  await enterMainScreen();
};

// ---- screen 3: unlock existing base.cd next to the exe ----
document.getElementById("btn-confirm-unlock").onclick = async () => {
  const pass = document.getElementById("input-unlock-pass").value;
  const errEl = document.getElementById("unlock-error");
  errEl.textContent = "";

  const err = await backend().OpenBase(pass);
  if (err) {
    errEl.textContent = err;
    return;
  }
  vaultPassword = pass;
  await enterMainScreen();
};

// ---- screen 4: main ----
async function enterMainScreen() {
  showScreen("screen-main");
  await refreshServerList();
}

async function refreshServerList() {
  const servers = await backend().ListServers();
  const list = document.getElementById("server-list");
  list.innerHTML = "";

  if (!servers || servers.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = t("noServers");
    empty.style.color = "var(--text-dim)";
    empty.style.cursor = "default";
    list.appendChild(empty);
    return;
  }

  servers.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="srv-name"></span><span class="srv-url"></span>`;
    li.querySelector(".srv-name").textContent = s.name;
    li.querySelector(".srv-url").textContent = s.url;
    li.onclick = () => {
      document.querySelectorAll("#server-list li").forEach((n) => n.classList.remove("active"));
      li.classList.add("active");
      // Actual connection to the Chatto server (GraphQL/NATS) plugs in here.
      document.getElementById("empty-state").textContent = s.name + " — " + s.url;
    };
    list.appendChild(li);
  });
}

// ---- add server modal ----
const modal = document.getElementById("modal-add-server");
document.getElementById("btn-add-server").onclick = () => {
  ["input-server-name", "input-server-url", "input-server-user", "input-server-pass", "input-vault-pass-confirm"]
    .forEach((id) => (document.getElementById(id).value = ""));
  modal.classList.remove("hidden");
};
document.getElementById("btn-cancel-add-server").onclick = () => modal.classList.add("hidden");

document.getElementById("btn-save-server").onclick = async () => {
  const name = document.getElementById("input-server-name").value;
  const url = document.getElementById("input-server-url").value;
  const user = document.getElementById("input-server-user").value;
  const pass = document.getElementById("input-server-pass").value;
  const vaultPassConfirm = document.getElementById("input-vault-pass-confirm").value;

  // Re-confirming the vault password before every write avoids keeping it
  // sitting in memory longer than necessary between screens.
  const check = vaultPassConfirm || vaultPassword;

  const err = await backend().AddServer(name, url, user, pass, check);
  if (err) {
    toast(err, "error");
    return;
  }
  vaultPassword = check;
  modal.classList.add("hidden");
  await refreshServerList();
};

// ---- export ----
document.getElementById("btn-export").onclick = async () => {
  const destPath = prompt(t("baseFilePath") + " (destination)");
  if (!destPath) return;
  const err = await backend().ExportBase(destPath);
  if (err) {
    toast(err, "error");
  } else {
    toast(t("exportSuccess"), "success");
  }
};

// ---- boot ----
buildLangGrid();
applyI18n();
