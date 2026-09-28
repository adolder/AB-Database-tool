'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const PORT = 3232;
const wizardProfileDir = path.join(os.tmpdir(), 'db-onderhoud-wizard-profile');

let wizardBrowserPid = 0;

// Free the port from a previous, still-running wizard instance before starting a new one.
try {
  cp.execSync(
    'for /f "tokens=5" %a in (\'netstat -ano ^| findstr " :' + PORT + ' "\') do taskkill /f /pid %a',
    { shell: 'cmd.exe', stdio: 'ignore' }
  );
} catch (_) {
  // No previous instance listening on this port.
}

// --- Asset helpers -----------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The menu keuze page must look exactly like Designer.png, so that image is
// rendered as-is; only invisible click zones are layered on top.
const EMBEDDED_IMAGES = require('./embedded-images.cjs');
const designerImageDataUri = EMBEDDED_IMAGES.DESIGNER_IMAGE;
const actoLogoDataUri = EMBEDDED_IMAGES.ACTO_LOGO;
const gbIconDashboardDataUri = EMBEDDED_IMAGES.GB_ICON_DASHBOARD;
const gbIconUserDataUri = EMBEDDED_IMAGES.GB_ICON_USER;
const gbIconAddGroupDataUri = EMBEDDED_IMAGES.GB_ICON_ADD_GROUP;
const gbIconDeleteDataUri = EMBEDDED_IMAGES.GB_ICON_DELETE;
const gbIconGarbageDataUri = EMBEDDED_IMAGES.GB_ICON_GARBAGE;

// Card hit-zones as percentages of the image (1536x1024), measured by pixel-scanning
// the white card regions in Designer.png (not estimated), read left to right.
const MENU_HOTSPOTS = [
  { key: 'anonimiseren', label: 'Database anonimiseren', left: 12.2, top: 48.8, width: 23.9, height: 40.6 },
  { key: 'inrichting', label: 'Specifieke inrichting aanpassen', left: 38.0, top: 48.8, width: 24.2, height: 40.6 },
  { key: 'gebruikers', label: 'Gebruikersbeheer', left: 64.1, top: 48.8, width: 23.9, height: 40.6 }
];

// --- Gebruikersbeheer data -------------------------------------------------

const FLOW_PARAMS_PATH = path.resolve(__dirname, '..', 'params', 'flow-parameters.json');
const PROCESS_BASE_PATH = path.resolve(__dirname, '..', 'processen');

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function getActiveEnvironment() {
  const params = readJsonSafe(FLOW_PARAMS_PATH, {});
  if (!params.connected_at) return 'Geen omgeving geselecteerd';
  const alias = params.alias || [params.branch_id, params.env_key].filter(Boolean).join(' - ');
  return alias || 'Geen omgeving geselecteerd';
}

function isEnvironmentConnected() {
  const params = readJsonSafe(FLOW_PARAMS_PATH, {});
  return !!params.connected_at;
}

function getUserProcesses() {
  return {
    controle: readJsonSafe(path.join(PROCESS_BASE_PATH, 'controle-gebruikers-db.process.json'), { label: 'Gebruikers Controle DB' }),
    toevoegen: readJsonSafe(path.join(PROCESS_BASE_PATH, 'toevoegen-gebruikers.process.json'), { label: 'Gebruikers Toevoegen', sources: [] }),
    deactiveren: readJsonSafe(path.join(PROCESS_BASE_PATH, 'deactiveren-gebruikers.process.json'), { label: 'Gebruikers Deactiveren' })
  };
}

function writeFlowParameters(values) {
  const current = readJsonSafe(FLOW_PARAMS_PATH, {});
  const merged = Object.assign({}, current, values, { updated_at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(FLOW_PARAMS_PATH), { recursive: true });
  fs.writeFileSync(FLOW_PARAMS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// --- Connection config -----------------------------------------------------
// Same method as the old wizard: real credentials live in a local, git-ignored
// connection.json (params/connection.json.example is the committed empty template).
// The password is stored DPAPI-encrypted (Windows Data Protection API, scoped to
// the current Windows user account) via authUserPasswordEncrypted, never in plain
// text. Env vars TDG_APP_USER / TDG_APP_PASSWORD are kept as a fallback/override.

const CONNECTION_CONFIG_PATH = path.resolve(__dirname, '..', 'params', 'connection.json');
const CONNECTION_CONFIG_EXAMPLE_PATH = path.resolve(__dirname, '..', 'params', 'connection.json.example');

// Fixed IAM base URL for the Database Onderhoud environment.
const STANDARD_APP_URL = 'https://twisodev01.acto.nl/indicium/iam';

// Synthetic "connect straight to IAM" entry, always shown first in the branch list.
const IAM_SELECTION_ID = 'IAM';
const IAM_SELECTION_ALIAS = 'Intelligent Application Manager (IAM)';
const IAM_BRANCH_ID = '8896';

let branchDiscoveryRunning = false;
let branchDiscoveryAbortRequested = false;
let discoveredBranchEntries = [];

function readConnectionConfig() {
  const primary = readJsonSafe(CONNECTION_CONFIG_PATH, null);
  if (primary) return primary;
  return readJsonSafe(CONNECTION_CONFIG_EXAMPLE_PATH, { authUser: '', authUserPasswordEncrypted: '' });
}

// Decrypts a DPAPI-protected string (produced by ConvertFrom-SecureString); only
// decryptable on this machine, by this Windows user account.
function decryptDpapiSecret(encrypted) {
  const value = String(encrypted || '').trim();
  if (!value) return '';
  try {
    const result = cp.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '$enc = [Console]::In.ReadLine(); ' +
      '$secure = ConvertTo-SecureString -String $enc; ' +
      '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); ' +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)'
    ], { input: value + '\n', encoding: 'utf8' });
    if (result.status !== 0) return '';
    return String(result.stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function getIamBaseUrl() {
  return STANDARD_APP_URL;
}

function getIamAuthHeader() {
  const cfg = readConnectionConfig();
  const authUser = String(cfg.authUser || process.env.TDG_APP_USER || '').trim();
  let authUserPassword = String(process.env.TDG_APP_PASSWORD || '').trim();
  if (!authUserPassword && cfg.authUserPasswordEncrypted) {
    authUserPassword = decryptDpapiSecret(cfg.authUserPasswordEncrypted);
  }
  if (!authUser || !authUserPassword) return '';
  return 'Basic ' + Buffer.from(authUser + ':' + authUserPassword).toString('base64');
}

function hasConnectionConfig() {
  return !!getIamAuthHeader();
}

// Verifies a branch id is actually reachable on the IAM service before trusting it.
function probeBranchMetadata(baseUrl, authHeader, id) {
  return new Promise(function (resolve) {
    const req = https.get(baseUrl + '/' + id + '/$metadata', {
      headers: { Authorization: authHeader, Accept: 'application/xml' }
    }, function (res) {
      const ok = res.statusCode === 200;
      res.resume();
      res.on('end', function () { resolve(ok); });
    });
    req.on('error', function () { resolve(false); });
    req.setTimeout(5000, function () {
      req.destroy();
      resolve(false);
    });
  });
}

// Fetches every application across every branch in one call (IAM's own gui_appl
// catalog under its own branch, 8896) instead of probing thousands of ids.
function fetchAllGuiApplRows(baseUrl, authHeader) {
  return new Promise(function (resolve) {
    const url = baseUrl + '/' + IAM_BRANCH_ID
      + '/gui_appl?$top=5000&$select=branch_id,gui_appl_id,gui_appl_alias,db_name,active';
    const req = https.get(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}');
          const rows = Array.isArray(parsed.value) ? parsed.value : [];
          resolve(rows
            .filter(function (row) { return row && row.active === true; })
            .map(function (row) {
              const guiApplId = String(row.gui_appl_id || '').trim();
              return {
                id: guiApplId,
                alias: String(row.branch_id || '').trim(),
                dbName: String(row.db_name || '').trim(),
                guiApplId: guiApplId
              };
            })
            .filter(function (b) { return b.id; }));
        } catch (_) {
          resolve([]);
        }
      });
    });
    req.on('error', function () { resolve([]); });
    req.setTimeout(10000, function () {
      req.destroy();
      resolve([]);
    });
  });
}

function normalizeIdentifier(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// A handful of environment names are shared/critical and must stay unselectable.
function isBlockedSelectionName(value) {
  const normalized = normalizeIdentifier(value);
  if (!normalized) return false;
  return normalized === 'evo' || normalized === 'main';
}

function isBlockedSelectionEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  if (isIamEntry(source)) return true;
  return [source.alias, source.dbName, source.guiApplId].some(isBlockedSelectionName);
}

function formatBranchLabel(entry) {
  if (isIamEntry(entry)) return IAM_SELECTION_ALIAS;
  const displayId = String(entry.guiApplId || entry.id || '').trim();
  if (displayId && entry.alias) return displayId + ' - ' + entry.alias;
  if (displayId && entry.dbName) return displayId + ' - ' + entry.dbName;
  if (displayId) return displayId + ' - (alias onbekend)';
  if (entry.alias && entry.dbName) return entry.alias + ' - ' + entry.dbName;
  return entry.alias;
}

function isIamEntry(entry) {
  return normalizeIdentifier(entry.guiApplId) === normalizeIdentifier(IAM_SELECTION_ID)
    || normalizeIdentifier(entry.id) === normalizeIdentifier(IAM_SELECTION_ID)
    || normalizeIdentifier(entry.alias) === normalizeIdentifier(IAM_SELECTION_ALIAS);
}

function buildIamSelectionEntry() {
  return {
    id: IAM_SELECTION_ID,
    alias: IAM_SELECTION_ALIAS,
    dbName: IAM_SELECTION_ALIAS,
    guiApplId: IAM_SELECTION_ID
  };
}

// Dedupes discovered entries, always offers the synthetic IAM entry, and orders
// known preferred environments first (matches the aliases seen in this environment).
function getUniqueBranchEntries() {
  const unique = [];
  const seen = new Set();
  for (const entry of discoveredBranchEntries) {
    const id = String(entry.id || '').trim();
    const alias = String(entry.alias || '').trim();
    const dbName = String(entry.dbName || '').trim();
    const guiApplId = String(entry.guiApplId || '').trim();
    const key = id + '|' + alias + '|' + dbName + '|' + guiApplId;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ id, alias, dbName, guiApplId });
  }

  if (!unique.some(isIamEntry)) unique.unshift(buildIamSelectionEntry());

  // Fixed top order by branch number (MAIN, EVO_ALPHA, EVO_GENOPS, EVO_NSYNC, EVO_BB, EVO_BOD).
  const preferredBranchOrder = ['8013', '8609', '8984', '9110', '9038', '8065'];

  function branchNumber(entry) {
    return String(entry.guiApplId || entry.id || '').trim();
  }

  function branchPriority(entry) {
    if (isIamEntry(entry)) return 0;
    const index = preferredBranchOrder.indexOf(branchNumber(entry));
    return index >= 0 ? index + 1 : preferredBranchOrder.length + 1;
  }

  unique.sort(function (a, b) {
    const diff = branchPriority(a) - branchPriority(b);
    if (diff !== 0) return diff;
    const numA = parseInt(branchNumber(a), 10);
    const numB = parseInt(branchNumber(b), 10);
    const validA = !isNaN(numA);
    const validB = !isNaN(numB);
    if (validA && validB && numA !== numB) return numA - numB;
    if (validA !== validB) return validA ? -1 : 1;
    return formatBranchLabel(a).localeCompare(formatBranchLabel(b));
  });

  return unique;
}

// Single call to IAM's own gui_appl catalog returns every application across
// every branch (Model/Branch/Server/Database naam), so no id-scanning is needed.
async function discoverBranchIdsFromIam() {
  if (branchDiscoveryRunning) return;
  branchDiscoveryRunning = true;
  branchDiscoveryAbortRequested = false;

  try {
    const baseUrl = getIamBaseUrl();
    const authHeader = getIamAuthHeader();
    if (!authHeader) return;

    const rows = await fetchAllGuiApplRows(baseUrl, authHeader);
    if (rows.length) discoveredBranchEntries = rows;
  } finally {
    branchDiscoveryRunning = false;
  }
}

function readJsonBody(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', function () {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', function () { resolve({}); });
  });
}

// --- Shared CSS + client script -----------------------------------------

const SHARED_STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #1f2937;
    min-height: 100vh;
    background: #eaf2fc;
  }
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .menu-page {
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
    background: #1c3f7a;
  }
  .menu-image-wrap {
    position: relative;
    flex: none;
    width: max(100vw, 150vh);
    height: max(100vh, 66.6667vw);
  }
  .menu-image-wrap img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .hotspot {
    position: absolute;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
  }
  .hotspot:hover, .hotspot:focus-visible {
    outline: 2px solid rgba(28, 63, 122, 0.35);
    outline-offset: 2px;
    border-radius: 16px;
  }
  .placeholder-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 40px;
  }
  .placeholder-body h1 { color: #14305c; }
  .back-link { margin-top: 16px; color: #14305c; }
  .menu-exit-fab {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
  }
  .menu-exit-fab:hover, .menu-exit-fab:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .menu-exit-fab svg { width: 28px; height: 28px; }
`;

const SHARED_SCRIPT = `
  function cancelWizard() {
    fetch('/api/cancel', { method: 'POST' }).catch(function () {}).finally(function () {
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        document.body.innerHTML = '<div style="padding:40px;font-family:Segoe UI,Arial,sans-serif;">De wizard is gestopt. U kunt dit venster sluiten.</div>';
      }, 300);
    });
  }
`;

// --- Page renderers -------------------------------------------------------

function renderMenuPage() {
  const hotspotsHtml = MENU_HOTSPOTS.map(function (spot) {
    return '<button class="hotspot" type="button" title="' + escapeHtml(spot.label) + '" '
      + 'style="left:' + spot.left + '%;top:' + spot.top + '%;width:' + spot.width + '%;height:' + spot.height + '%;" '
      + 'data-feature="' + escapeHtml(spot.key) + '"></button>';
  }).join('');

  const imageHtml = '<img src="' + designerImageDataUri + '" alt="Database onderhoud">';

  return `<!DOCTYPE html>
<html lang="nl" class="notranslate" translate="no">
<head>
<meta charset="UTF-8">
<meta name="google" content="notranslate">
<title>Database onderhoud</title>
<style>${SHARED_STYLE}</style>
</head>
<body class="notranslate">
<div class="page menu-page">
  <div class="menu-image-wrap">
    ${imageHtml}
    ${hotspotsHtml}
  </div>
  <button class="menu-exit-fab" type="button" title="Afsluiten" id="menuExitBtn">${GB_ICON_POWER_SVG}</button>
</div>
<script>${SHARED_SCRIPT}</script>
<script>
  document.querySelectorAll('.hotspot').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const feature = btn.getAttribute('data-feature') || '';
      window.location.href = feature === 'gebruikers' ? '/gebruikersbeheer' : ('/placeholder?feature=' + encodeURIComponent(feature));
    });
  });
  document.getElementById('menuExitBtn').addEventListener('click', cancelWizard);
</script>
</body>
</html>`;
}

// --- Gebruikersbeheer shell (sidebar + nav shared across its sub-pages) ----

// Standard power (circle + line) icon, colored so it stands out from the other nav icons.
const GB_ICON_POWER_SVG = '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M12 3v8" stroke="#ff6b57" stroke-width="2.4" stroke-linecap="round"/>'
  + '<path d="M6.5 6.5a8 8 0 1 0 11 0" stroke="#ff6b57" stroke-width="2.4" stroke-linecap="round"/>'
  + '</svg>';

const GB_NAV_ITEMS = [
  { key: 'dashboard', icon: gbIconDashboardDataUri, label: 'Dashboard' },
  { key: 'controle-omgeving', icon: gbIconUserDataUri, label: 'Controleren gebruikers omgeving' },
  { key: 'controle-iam', icon: gbIconUserDataUri, label: 'Controleren gebruikers IAM' },
  { key: 'toevoegen-omgeving', icon: gbIconAddGroupDataUri, label: 'Gebruikers toevoegen omgeving' },
  { key: 'toevoegen-iam', icon: gbIconAddGroupDataUri, label: 'Gebruikers toevoegen IAM' },
  { key: 'deactiveren-omgeving', icon: gbIconDeleteDataUri, label: 'Gebruikers deactiveren omgeving' },
  { key: 'deactiveren-iam', icon: gbIconDeleteDataUri, label: 'Gebruikers deactiveren IAM' },
  { key: 'schonen-iam', icon: gbIconGarbageDataUri, label: 'Gebruiker schonen IAM' },
  { key: 'afsluiten', icon: GB_ICON_POWER_SVG, label: 'Afsluiten' }
];

const GB_ROUTES = {
  'controle-omgeving': '/gebruikersbeheer/controle-omgeving'
};

const GB_SHELL_STYLE = `
  .gb-page { flex-direction: row; min-height: 100vh; background: #f7f9fc; }
  .gb-left { flex: 0 0 295px; width: 295px; display: flex; flex-direction: column; }
  .gb-active-env-badge { position: absolute; top: 24px; right: 40px; font-size: 0.85rem; color: #14305c; background: #eaf2fc; border-radius: 999px; padding: 8px 18px; font-weight: 600; }
  .gb-logo-box { display: flex; align-items: center; gap: 12px; padding: 24px 22px; }
  .gb-logo-img { height: 56px; width: auto; display: block; flex: 0 0 auto; }
  .gb-logo-tagline { font-size: 0.78rem; color: #2f5fa8; font-weight: 700; }
  .gb-rail { position: relative; flex: 1; background: linear-gradient(160deg, #152a52 0%, #1c3f7a 80%); border-top-right-radius: 70px; overflow: hidden; }
  .gb-rail .gb-rail-mark {
    position: absolute;
    left: 50%;
    top: 40%;
    width: 260px;
    height: 260px;
    transform: translate(-50%, -50%) rotate(45deg);
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 10px;
    opacity: 0.08;
  }
  .gb-rail .gb-rail-mark span { background: #fff; border-radius: 24px; }
  .gb-nav { position: relative; z-index: 1; list-style: none; margin: 12px 0 0; padding: 0; }
  .gb-nav-item { display: flex; align-items: center; gap: 12px; padding: 14px 24px; color: #cbd8ee; font-size: 0.95rem; cursor: pointer; border: none; background: none; width: 100%; text-align: left; }
  .gb-nav-icon { width: 1.2em; height: 1.2em; object-fit: contain; flex: 0 0 auto; }
  .gb-nav-item:hover, .gb-nav-item:focus-visible { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .gb-nav-item-active { background: rgba(255, 255, 255, 0.14); color: #fff; font-weight: 700; }
  .gb-right { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .gb-main { flex: 1; padding: 40px; }
  .gb-main h1 { margin: 0 0 4px; font-size: 2rem; color: #14305c; }
  .gb-subtitle { margin: 0 0 24px; color: #5b6b82; font-size: 0.95rem; max-width: 640px; }
  .gb-panel { border: none; border-radius: 12px; overflow: hidden; margin-bottom: 20px; background: #fff; box-shadow: 0 10px 30px rgba(20, 48, 92, 0.08); }
  .gb-panel-title { display: block; padding: 10px 16px; background: #dbeafe; color: #0b3f9c; font-size: 0.9rem; font-weight: 700; }
  .gb-panel-body { padding: 14px 16px; color: #334155; font-size: 0.9rem; }
  .gb-branch-list { margin: 0; padding: 0; list-style: none; max-height: 70vh; overflow-y: auto; }
  .gb-branch-item { margin: 4px 0; }
  .gb-branch-option { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .gb-branch-check { width: 16px; height: 16px; accent-color: #2f5fa8; cursor: pointer; }
  .gb-branch-empty { color: #8a99b3; font-size: 0.85rem; }
  .gb-note { color: #8a99b3; font-size: 0.82rem; margin-top: 10px; }
  .gb-note.error { color: #b91c1c; }
  .gb-note.success { color: #1f8a4c; }
  .gb-actions { display: flex; justify-content: flex-end; gap: 12px; }
  .gb-btn { border-radius: 999px; padding: 10px 24px; font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; background: linear-gradient(135deg, #1c3f7a, #2f5fa8); color: #fff; box-shadow: 0 6px 16px rgba(28, 63, 122, 0.25); }
  .gb-btn:disabled { background: #c7d2e6; color: #fff; box-shadow: none; cursor: not-allowed; }
`;

function renderGbNavHtml(activeKey) {
  return GB_NAV_ITEMS.map(function (item) {
    const activeClass = item.key === activeKey ? ' gb-nav-item-active' : '';
    const iconHtml = item.icon.indexOf('data:image') === 0
      ? '<img class="gb-nav-icon" src="' + item.icon + '" alt="">'
      : item.icon;
    return '<li><button class="gb-nav-item' + activeClass + '" type="button" data-feature="' + item.key + '">' + iconHtml + ' ' + escapeHtml(item.label) + '</button></li>';
  }).join('');
}

const GB_NAV_SCRIPT = `
  document.querySelectorAll('.gb-nav-item[data-feature]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const feature = btn.getAttribute('data-feature');
      if (feature === 'afsluiten') {
        cancelWizard();
        return;
      }
      const routes = ${JSON.stringify(GB_ROUTES)};
      if (feature === 'dashboard') {
        window.location.href = '/menu';
      } else if (routes[feature]) {
        window.location.href = routes[feature];
      } else {
        window.location.href = '/placeholder?feature=' + encodeURIComponent(feature) + '&back=' + encodeURIComponent('/gebruikersbeheer');
      }
    });
  });
`;

function renderGbShell(activeKey, title, subtitle, bodyHtml, extraStyle, extraScript, hideEnvBadge) {
  return `<!DOCTYPE html>
<html lang="nl" class="notranslate" translate="no">
<head>
<meta charset="UTF-8">
<meta name="google" content="notranslate">
<title>${escapeHtml(title)} - Database onderhoud</title>
<style>${SHARED_STYLE}${GB_SHELL_STYLE}${extraStyle || ''}</style>
</head>
<body class="notranslate">
<div class="page gb-page">
  <div class="gb-left">
    <div class="gb-logo-box">
      <img class="gb-logo-img" src="${actoLogoDataUri}" alt="Acto">
      <div class="gb-logo-tagline">Database Onderhoud</div>
    </div>
    <div class="gb-rail">
      <div class="gb-rail-mark"><span></span><span></span><span></span><span></span></div>
      <ul class="gb-nav">
        ${renderGbNavHtml(activeKey)}
      </ul>
    </div>
  </div>
  <div class="gb-right">
    <div class="gb-active-env-badge" id="activeEnvBadge"${hideEnvBadge ? ' style="display:none;"' : ''}>Actieve omgeving: ${escapeHtml(isEnvironmentConnected() ? getActiveEnvironment() : '-')}</div>
    <div class="gb-main">
      <h1>${escapeHtml(title)}</h1>
      <p class="gb-subtitle">${escapeHtml(subtitle)}</p>
      ${bodyHtml}
    </div>
  </div>
</div>
<script>${SHARED_SCRIPT}</script>
<script>${GB_NAV_SCRIPT}</script>
${extraScript ? '<script>' + extraScript + '</script>' : ''}
</body>
</html>`;
}

function renderGebruikersbeheerPage() {
  return renderGbShell('', 'Gebruikersbeheer', 'Beheer gebruikersprocessen voor de actieve omgeving.', '', '', '', true);
}

function renderControleOmgevingPage() {
  const connectionReady = hasConnectionConfig();

  const body = `
      <div class="gb-panel">
        <strong class="gb-panel-title">Beschikbare branches</strong>
        <div class="gb-panel-body" id="branchListWrap">
          <p class="gb-branch-empty">${connectionReady ? 'Bezig met ophalen van omgevingen...' : 'Nog geen verbinding geconfigureerd. Zet TDG_APP_USER en TDG_APP_PASSWORD in de omgeving.'}</p>
        </div>
      </div>

      <div class="gb-actions">
        <button class="gb-btn" type="button" id="connectBtn" disabled>Verbinden</button>
      </div>
      <p id="connectFeedback" class="gb-note" style="display:none;"></p>
  `;

  const script = `
    const connectBtn = document.getElementById('connectBtn');
    const feedback = document.getElementById('connectFeedback');
    const branchListWrap = document.getElementById('branchListWrap');
    const connectionReady = ${connectionReady ? 'true' : 'false'};
    let selectedValue = '';
    let pollActive = connectionReady;

    function escapeHtmlClient(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderBranches(items) {
      if (!items.length) {
        branchListWrap.innerHTML = '<p class="gb-branch-empty">Geen omgevingen gevonden.</p>';
        return;
      }
      const html = '<ul class="gb-branch-list">' + items.map(function (item) {
        const value = escapeHtmlClient(item.value);
        const checked = item.value === selectedValue ? ' checked' : '';
        const disabled = item.blocked ? ' disabled' : '';
        const label = escapeHtmlClient(item.label);
        return '<li class="gb-branch-item"><label class="gb-branch-option">'
          + '<input class="gb-branch-check" type="radio" name="branch" value="' + value + '"' + checked + disabled + '> '
          + '<span>' + label + '</span>'
          + '</label></li>';
      }).join('') + '</ul>';
      branchListWrap.innerHTML = html;
      Array.prototype.slice.call(branchListWrap.querySelectorAll('input[name="branch"]')).forEach(function (chk) {
        chk.addEventListener('change', function () {
          selectedValue = chk.value;
          connectBtn.disabled = false;
        });
      });
    }

    function pollBranches() {
      fetch('/api/gebruikersbeheer/branches', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
        const items = (data && data.items) || [];
        renderBranches(items);
        pollActive = !!(data && data.discoveryRunning);
        if (pollActive) setTimeout(pollBranches, 2500);
      }).catch(function () {
        pollActive = false;
      });
    }

    connectBtn.addEventListener('click', function () {
      if (!selectedValue) return;
      connectBtn.disabled = true;
      fetch('/api/gebruikersbeheer/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: selectedValue })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.status === 'connected') {
          feedback.style.display = 'none';
          const badge = document.getElementById('activeEnvBadge');
          badge.textContent = 'Verbonden met ' + data.alias;
          badge.style.display = '';
        } else {
          feedback.style.display = 'block';
          feedback.className = 'gb-note error';
          feedback.textContent = 'Verbinden mislukt: ' + (data && data.message || 'onbekende fout');
        }
        connectBtn.disabled = false;
      }).catch(function () {
        feedback.style.display = 'block';
        feedback.className = 'gb-note error';
        feedback.textContent = 'Verbinden mislukt.';
        connectBtn.disabled = false;
      });
    });

    // Always poll once on load (even if this HTML was served from a stale cache
    // with an outdated connectionReady snapshot); the API reflects live status.
    pollBranches();
  `;

  return renderGbShell(
    'controle-omgeving',
    'Controleren gebruikers omgeving',
    'Maak eerst verbinding met een omgeving voordat gebruikers gecontroleerd kunnen worden.',
    body,
    '',
    script,
    true
  );
}

function renderPlaceholderPage(featureKey, backHref) {
  const featureLabels = {
    anonimiseren: 'Database anonimiseren',
    inrichting: 'Specifieke inrichting aanpassen',
    gebruikers: 'Gebruikersbeheer',
    'controle-omgeving': 'Controleren gebruikers omgeving',
    'controle-iam': 'Controleren gebruikers IAM',
    'toevoegen-omgeving': 'Gebruikers toevoegen omgeving',
    'toevoegen-iam': 'Gebruikers toevoegen IAM',
    'deactiveren-omgeving': 'Gebruikers deactiveren omgeving',
    'deactiveren-iam': 'Gebruikers deactiveren IAM',
    'schonen-iam': 'Gebruiker schonen IAM'
  };
  const label = featureLabels[featureKey] || 'Deze functie';
  const back = backHref || '/menu';

  return `<!DOCTYPE html>
<html lang="nl" class="notranslate" translate="no">
<head>
<meta charset="UTF-8">
<meta name="google" content="notranslate">
<title>${escapeHtml(label)} - Database onderhoud</title>
<style>${SHARED_STYLE}</style>
</head>
<body class="notranslate">
<div class="page">
  <div class="placeholder-body">
    <h1>${escapeHtml(label)}</h1>
    <p>Deze functie is nog niet ge\u00efmplementeerd.</p>
    <a class="back-link" href="${escapeHtml(back)}">&larr; Terug</a>
  </div>
</div>
<script>${SHARED_SCRIPT}</script>
</body>
</html>`;
}

// --- Browser launch -------------------------------------------------------

function findChromePath() {
  const candidates = [
    path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LocalAppData'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // Ignore and try next.
    }
  }
  return '';
}

function openBrowser(targetUrl) {
  closeStaleWizardBrowser();
  const chromePath = findChromePath();
  if (chromePath) {
    try {
      const child = cp.spawn(
        chromePath,
        ['--new-window', '--start-maximized', '--app=' + targetUrl, '--user-data-dir=' + wizardProfileDir],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      wizardBrowserPid = child.pid;
      return;
    } catch (err) {
      console.error('Kon Chrome niet starten, val terug op standaardbrowser:', err.message);
    }
  }
  try {
    cp.exec('start "" "' + targetUrl + '"');
  } catch (err) {
    console.error('Kon geen browser openen:', err.message);
  }
}

// Close any wizard browser window left open from a previous run (matched by its dedicated profile dir).
function closeStaleWizardBrowser() {
  try {
    // Profile path is passed via env var to avoid cmd/PowerShell quoting and backslash-escaping issues.
    cp.execSync(
      'powershell -NoProfile -NonInteractive -Command "$token=$env:WIZARD_PROFILE_DIR; ' +
      '$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(\'chrome.exe\',\'msedge.exe\') -and ([string]$_.CommandLine).Contains($token) }); ' +
      '$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ' +
      'if ($procs.Count) { Wait-Process -Id $procs.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }"',
      { shell: 'cmd.exe', stdio: 'ignore', env: Object.assign({}, process.env, { WIZARD_PROFILE_DIR: wizardProfileDir }) }
    );
  } catch (_) {
    // Best-effort cleanup; nothing to close.
  }
}

function stopWizardBrowser() {
  if (wizardBrowserPid) {
    try {
      cp.exec('taskkill /PID ' + wizardBrowserPid + ' /T /F');
    } catch (_) {
      // Best effort; ignore failures.
    }
  }
}

// --- HTTP server -----------------------------------------------------------

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (req.method === 'POST' && parsed.pathname === '/api/cancel') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'stopping' }));
    stopWizardBrowser();
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 250);
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/gebruikersbeheer/connect') {
    readJsonBody(req).then(async function (data) {
      const parts = String(data && data.value || '').split('|');
      const branchId = String(parts[0] || '').trim();
      const alias = String(parts[1] || '').trim();
      const dbName = String(parts[2] || '').trim();
      const guiApplId = String(parts[3] || '').trim();
      if (!branchId && !alias) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Geen branch geselecteerd.' }));
        return;
      }
      if (isBlockedSelectionEntry({ id: branchId, alias: alias, dbName: dbName, guiApplId: guiApplId })) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Deze omgeving is afgeschermd.' }));
        return;
      }

      const baseUrl = getIamBaseUrl();
      const authHeader = getIamAuthHeader();
      if (!authHeader) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Geen inloggegevens geconfigureerd (TDG_APP_USER/TDG_APP_PASSWORD).' }));
        return;
      }

      const probeId = branchId === IAM_SELECTION_ID ? IAM_BRANCH_ID : branchId;
      const reachable = await probeBranchMetadata(baseUrl, authHeader, probeId);
      if (!reachable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Omgeving is niet bereikbaar.' }));
        return;
      }

      writeFlowParameters({
        branch_id: branchId,
        gui_appl_id: guiApplId,
        env_key: alias,
        alias: alias || branchId,
        db_name: dbName,
        application_url: baseUrl + '/' + probeId,
        connected_at: new Date().toISOString()
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'connected', alias: alias || branchId }));
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/branches') {
    const items = getUniqueBranchEntries().map(function (entry) {
      return {
        value: [entry.id, entry.alias, entry.dbName, entry.guiApplId].join('|'),
        label: formatBranchLabel(entry),
        blocked: isBlockedSelectionEntry(entry)
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ items: items, discoveryRunning: branchDiscoveryRunning }));
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/menu') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderMenuPage());
    return;
  }

  if (parsed.pathname === '/gebruikersbeheer') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderGebruikersbeheerPage());
    return;
  }

  if (parsed.pathname === '/gebruikersbeheer/controle-omgeving') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderControleOmgevingPage());
    return;
  }

  if (parsed.pathname === '/placeholder') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderPlaceholderPage(String(parsed.searchParams.get('feature') || ''), String(parsed.searchParams.get('back') || '')));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  const targetUrl = 'http://127.0.0.1:' + PORT + '/menu';
  console.log('Database Onderhoud wizard draait op ' + targetUrl);
  discoverBranchIdsFromIam().catch(function (err) {
    console.error('Branch discovery mislukt:', err && err.message);
  });
  openBrowser(targetUrl);
});
