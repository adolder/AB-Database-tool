'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const dns = require('dns');

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
const gbIconPenDataUri = EMBEDDED_IMAGES.GB_ICON_PEN;
const gbIconSaveButtonDataUri = EMBEDDED_IMAGES.GB_ICON_SAVE_BUTTON;

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

// Clears the active environment connection (used when the wizard is shut down via Afsluiten).
function disconnectEnvironment() {
  if (!isEnvironmentConnected()) return;
  writeFlowParameters({
    branch_id: '',
    gui_appl_id: '',
    env_key: '',
    alias: '',
    db_name: '',
    application_url: '',
    connected_at: ''
  });
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

// Mutable IAM application URL/id (editable via "Configuratie IAM gegevens"; changes
// mainly needed after an IAM upgrade, which typically renumbers the application id).
const IAM_APP_CONFIG_PATH = path.resolve(__dirname, '..', 'params', 'iam-config.json');
const IAM_APP_CONFIG_EXAMPLE_PATH = path.resolve(__dirname, '..', 'params', 'iam-config.json.example');

function readIamAppConfig() {
  const fallback = { applicationUrl: STANDARD_APP_URL, applicationId: IAM_BRANCH_ID };
  const primary = readJsonSafe(IAM_APP_CONFIG_PATH, null);
  if (primary) return Object.assign({}, fallback, primary);
  return Object.assign({}, fallback, readJsonSafe(IAM_APP_CONFIG_EXAMPLE_PATH, {}));
}

function writeIamAppConfig(values) {
  const current = readIamAppConfig();
  const merged = Object.assign({}, current, values);
  fs.mkdirSync(path.dirname(IAM_APP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(IAM_APP_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function getIamApplicationId() {
  return String(readIamAppConfig().applicationId || IAM_BRANCH_ID).trim();
}


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

// Encrypts a plain-text secret with DPAPI (same approach as set-connection-password.cjs),
// so the password is never written to disk in plain text.
function encryptDpapiSecret(plainText) {
  const value = String(plainText || '');
  if (!value) return '';
  const result = cp.spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$plain = [Console]::In.ReadLine(); ' +
    '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force; ' +
    'ConvertFrom-SecureString -SecureString $secure'
  ], { input: value + '\n', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || 'DPAPI-encryptie mislukt.'));
  return String(result.stdout || '').trim();
}

function writeConnectionConfig(values) {
  const current = readJsonSafe(CONNECTION_CONFIG_PATH, { authUser: '', authUserPasswordEncrypted: '' });
  const merged = Object.assign({}, current, values);
  fs.mkdirSync(path.dirname(CONNECTION_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONNECTION_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function getIamBaseUrl() {
  return String(readIamAppConfig().applicationUrl || STANDARD_APP_URL).replace(/\/+$/, '');
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
// catalog under its own application id) instead of probing thousands of ids.
function fetchAllGuiApplRows(baseUrl, authHeader) {
  return new Promise(function (resolve) {
    const url = baseUrl + '/' + getIamApplicationId()
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

// --- Environment user overview (for "Controleren gebruikers omgeving") -----

function fetchJsonFromUrl(url, authHeader, timeoutMs) {
  return new Promise(function (resolve) {
    const req = https.get(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(timeoutMs || 10000, function () { req.destroy(); resolve(null); });
  });
}

// Returns { ok, status, body } — ok is only true for 2xx; body is parsed JSON (or raw text if parsing fails).
function postJsonToUrl(url, authHeader, payload, timeoutMs) {
  return new Promise(function (resolve) {
    const data = JSON.stringify(payload || {});
    let target;
    try { target = new URL(url); } catch (_) { resolve({ ok: false, status: 0, body: null }); return; }
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = body; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', function (err) { resolve({ ok: false, status: 0, body: { message: String(err && err.message || 'Netwerkfout.') }, headers: {} }); });
    req.setTimeout(timeoutMs || 20000, function () { req.destroy(); resolve({ ok: false, status: 0, body: { message: 'Time-out.' }, headers: {} }); });
    req.write(data);
    req.end();
  });
}

// Indicium/TSF puts the real failure details (business rule, duplicate key, ...) in the base64-encoded
// 'tsfmessages' response header, not in the (usually empty) response body. Decodes that into a Dutch message.
function friendlyTsfErrorMessage(result, fallback) {
  const raw = result && result.headers && (result.headers.tsfmessages || result.headers.Tsfmessages);
  if (!raw) return fallback;
  let msg;
  try { msg = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')); } catch (_) { return fallback; }
  const params = {};
  (msg.NamedParameters || []).forEach(function (p) { if (p && p.Key) params[p.Key] = p.Value; });
  if (msg.MessageID === 'err_dupl_key_row') {
    const index = String(params.index || '').toLowerCase();
    if (index.indexOf('login_name') !== -1) return 'Gebruikersnaam bestaat al in deze omgeving.';
    if (index.indexOf('mail') !== -1) return 'E-mailadres bestaat al in deze omgeving.';
    return 'Deze waarde bestaat al (' + (params.index || params.table || 'onbekende index') + ').';
  }
  return String(msg.RawMessage || msg.MessageID || fallback);
}

function fetchTextFromUrl(url, authHeader, timeoutMs) {
  return new Promise(function (resolve) {
    const req = https.get(url, {
      headers: { Authorization: authHeader, Accept: 'application/xml' }
    }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(''); return; }
        resolve(body);
      });
    });
    req.on('error', function () { resolve(''); });
    req.setTimeout(timeoutMs || 12000, function () { req.destroy(); resolve(''); });
  });
}

function parseXmlAttributes(raw) {
  const attrs = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(String(raw || ''))) !== null) {
    attrs[String(match[1] || '')] = String(match[2] || '');
  }
  return attrs;
}

function parseEntitySetsFromMetadata(xml) {
  const out = [];
  const re = /<EntitySet\s+([^>]*?)\/?>(?:\s*<\/EntitySet>)?/g;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    const name = String(attrs.Name || '').trim();
    const entityType = String(attrs.EntityType || '').trim();
    if (!name || !entityType) continue;
    out.push({ name: name, entityType: entityType });
  }
  return out;
}

function isEmployeeLikeEntitySet(set) {
  const name = normalizeIdentifier(set && set.name || '');
  const typeName = normalizeIdentifier((set && set.entityType || '').split('.').pop() || '');
  const tokens = ['employee', 'employees', 'medewerker', 'medewerkers', 'werknemer', 'werknemers', 'usr', 'user', 'users', 'gebruiker', 'gebruikers'];
  return tokens.some(function (token) {
    return name === token || typeName === token || name.indexOf(token) !== -1 || typeName.indexOf(token) !== -1;
  });
}

function parseUserRowsResponse(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.value)) return parsed.value;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (Array.isArray(parsed.results)) return parsed.results;
  return [];
}

function pickUserFieldValue(row, keys) {
  const src = row && typeof row === 'object' ? row : {};
  for (const key of keys) {
    const value = src[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  const sourceKeys = Object.keys(src);
  for (const key of keys) {
    const needle = normalizeIdentifier(key);
    if (!needle) continue;
    for (const candidateKey of sourceKeys) {
      const normalized = normalizeIdentifier(candidateKey);
      if (!normalized) continue;
      if (normalized === needle || normalized.indexOf(needle) !== -1 || needle.indexOf(normalized) !== -1) {
        const value = src[candidateKey];
        if (value == null) continue;
        const text = String(value).trim();
        if (text) return text;
      }
    }
  }
  return '';
}

function findUserFieldValue(row, keys) {
  const src = row && typeof row === 'object' ? row : {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const value = src[key];
      return { found: true, value: value == null ? '' : String(value).trim() };
    }
  }
  const sourceKeys = Object.keys(src);
  for (const key of keys) {
    const needle = normalizeIdentifier(key);
    if (!needle) continue;
    for (const candidateKey of sourceKeys) {
      const normalized = normalizeIdentifier(candidateKey);
      if (normalized === needle) {
        const value = src[candidateKey];
        return { found: true, value: value == null ? '' : String(value).trim() };
      }
    }
  }
  return { found: false, value: '' };
}

function normalizeUserActiveValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value > 0 ? 1 : 0;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return 0;
  return (text === '1' || text === 'true' || text === 'yes' || text === 'y' || text === 'ja') ? 1 : 0;
}

function normalizeUserActiveFromEndOn(row) {
  const src = row && typeof row === 'object' ? row : {};
  const endOn = findUserFieldValue(src, ['end_on', 'endon', 'einddatum', 'end_date']);
  if (!endOn.found) {
    // IAM usr responses often omit null properties entirely, so a missing end_on
    // means active rather than unknown for IAM-shaped rows.
    const looksLikeIamUsr = Object.prototype.hasOwnProperty.call(src, 'usr_id')
      || Object.prototype.hasOwnProperty.call(src, 'authentication_type')
      || Object.prototype.hasOwnProperty.call(src, 'begin_on');
    return looksLikeIamUsr ? 1 : null;
  }
  if (!endOn.value) return 1;
  const parsedDate = new Date(endOn.value);
  if (Number.isNaN(parsedDate.getTime())) return null;
  return parsedDate.getTime() < Date.now() ? 0 : 1;
}

// Trimmed port of the old wizard's employee-row mapping (Relation ID, Login_naam, Mailadres, Actief).
function mapUserRowsForTable(rows) {
  return (Array.isArray(rows) ? rows : []).map(function (raw) {
    const safeRow = raw && typeof raw === 'object' ? raw : {};
    const id = pickUserFieldValue(safeRow, ['employee_id', 'id', 'user_id', 'usr_id', 'employee_code', 'code']);
    const loginName = pickUserFieldValue(safeRow, ['login_name', 'user_name', 'username', 'login', 'usr_id', 'display_name', 'employee_name', 'name']);
    const mailAddress = pickUserFieldValue(safeRow, ['mail_address', 'mailadres', 'email', 'email_address', 'e_mail', 'e_mail_address', 'mail']);
    const activeByEndOn = normalizeUserActiveFromEndOn(safeRow);
    const deactivatedField = findUserFieldValue(safeRow, ['is_deactivated', 'deactivated', 'is_inactive', 'inactive']);
    const activeField = findUserFieldValue(safeRow, ['is_active', 'actief', 'isactief', 'enabled']);
    let active;
    if (activeField.found) {
      active = normalizeUserActiveValue(activeField.value);
    } else if (deactivatedField.found) {
      active = normalizeUserActiveValue(deactivatedField.value) === 1 ? 0 : 1;
    } else {
      active = activeByEndOn == null ? 0 : activeByEndOn;
    }
    return { id: id || '-', loginName: loginName || '-', mailAddress: mailAddress || '-', active: active };
  }).filter(function (user) { return user.loginName !== '-' || user.id !== '-'; });
}

// Fetches the users for the currently connected environment, trying the given
// primary entity set names first (e.g. 'employee' or 'usr') and falling back to
// metadata-based discovery of an employee/user-like entity set (same approach as
// the previous wizard).
async function fetchEnvironmentUsers(appUrl, authHeader, primaryEntityNames) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  if (!base || !authHeader) return [];

  const primaryNames = Array.isArray(primaryEntityNames) && primaryEntityNames.length ? primaryEntityNames : ['employee'];
  let rows = [];
  for (const name of primaryNames) {
    rows = parseUserRowsResponse(await fetchJsonFromUrl(base + '/' + encodeURIComponent(name) + '?$top=5000', authHeader, 15000));
    if (!rows.length) rows = parseUserRowsResponse(await fetchJsonFromUrl(base + '/' + encodeURIComponent(name), authHeader, 15000));
    if (rows.length) break;
  }

  if (!rows.length) {
    const metadataXml = await fetchTextFromUrl(base + '/$metadata', authHeader, 12000);
    const entitySets = parseEntitySetsFromMetadata(metadataXml);
    const employeeSet = entitySets.find(isEmployeeLikeEntitySet);
    if (employeeSet && employeeSet.name) {
      rows = parseUserRowsResponse(await fetchJsonFromUrl(base + '/' + encodeURIComponent(employeeSet.name) + '?$top=5000', authHeader, 15000));
    }
  }

  return rows;
}

// Returns true/false if the given employee field (case-insensitive) already holds this value, or null if it could not be determined.
async function employeeFieldValueExists(appUrl, authHeader, fieldName, value) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  const needle = String(value || '').trim().toLowerCase();
  const filter = "tolower(" + fieldName + ") eq '" + needle.replace(/'/g, "''") + "'";
  const filtered = await fetchJsonFromUrl(base + '/employee?$filter=' + encodeURIComponent(filter) + '&$top=1', authHeader, 15000);
  if (filtered) return parseUserRowsResponse(filtered).length > 0;

  const all = await fetchJsonFromUrl(base + '/employee?$top=5000', authHeader, 15000);
  if (!all) return null;
  return parseUserRowsResponse(all).some(function (row) {
    return String(row && row[fieldName] || '').trim().toLowerCase() === needle;
  });
}

async function employeeLoginNameExists(appUrl, authHeader, loginName) {
  return employeeFieldValueExists(appUrl, authHeader, 'login_name', loginName);
}

async function employeeEmailExists(appUrl, authHeader, email) {
  return employeeFieldValueExists(appUrl, authHeader, 'relationship_email_address', email);
}

// Same existence check but against IAM's 'usr' entity set (exact mail-field name not confirmed,
// so it's resolved per row via pickUserFieldValue's fuzzy candidates instead of a server-side $filter).
async function usrLoginIdExists(appUrl, authHeader, loginId) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  const needle = String(loginId || '').trim().toLowerCase();
  const filter = "tolower(usr_id) eq '" + needle.replace(/'/g, "''") + "'";
  const filtered = await fetchJsonFromUrl(base + '/usr?$filter=' + encodeURIComponent(filter) + '&$top=1', authHeader, 15000);
  if (filtered) return parseUserRowsResponse(filtered).length > 0;

  const all = await fetchJsonFromUrl(base + '/usr?$top=5000', authHeader, 15000);
  if (!all) return null;
  return parseUserRowsResponse(all).some(function (row) {
    return pickUserFieldValue(row, ['usr_id']).toLowerCase() === needle;
  });
}

async function usrEmailExists(appUrl, authHeader, email) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  const needle = String(email || '').trim().toLowerCase();
  const all = await fetchJsonFromUrl(base + '/usr?$top=5000', authHeader, 15000);
  if (!all) return null;
  return parseUserRowsResponse(all).some(function (row) {
    return pickUserFieldValue(row, ['mail_address', 'mailadres', 'email', 'email_address', 'e_mail', 'e_mail_address', 'mail']).toLowerCase() === needle;
  });
}

// Departments usable for employees (the application's Afdeling lookup only lists employees_allowed ones); null on failure.
async function fetchEmployeeDepartments(appUrl, authHeader) {
  const query = '$filter=' + encodeURIComponent('employees_allowed eq true')
    + '&$orderby=department_name&$top=5000'
    + '&$expand=' + encodeURIComponent('ref_system_administration_department,ref_cost_center_department');
  const parsed = await fetchJsonFromUrl(appUrl + '/department?' + query, authHeader, 20000);
  if (!parsed) return null;
  return parseUserRowsResponse(parsed).map(function (row) {
    const adm = row.ref_system_administration_department || {};
    const cc = row.ref_cost_center_department || {};
    return {
      id: row.department_id,
      administrationId: row.system_administration_id,
      administration: String(adm.system_administration_name || ''),
      name: String(row.department_name || ''),
      code: String(row.department_code || ''),
      costCenter: String(cc.cost_center_lookup || ''),
      allowed: {
        projects: row.projects_allowed === true,
        contracts: row.contracts_allowed === true,
        instructions: row.instruction_allowed === true,
        employees: row.employees_allowed === true,
        creditors: row.creditor_allowed === true,
        debtors: row.debtor_allowed === true
      }
    };
  });
}
// IAM branch URL/id, its GUI/model version and license expiration (gui_global_settings),
// and the Indicium platform version (root /info page).
// Formats an ISO datetime (e.g. "2026-12-21T13:14:22.25Z") as "dd-mm-jjjj".
function formatDateDdMmYyyy(isoValue) {
  const datePart = String(isoValue || '').split('T')[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return '';
  const [year, month, day] = parts;
  return day + '-' + month + '-' + year;
}

async function fetchIamInfo() {
  // applicationUrl is the base IAM service URL (without the id); the id is appended
  // separately below and when actually querying IAM, so it must not be included here
  // or a save round-trip would duplicate it (e.g. ".../iam/8896/8896").
  const appUrl = getIamBaseUrl() + '/' + getIamApplicationId();
  const result = { applicationUrl: getIamBaseUrl(), applicationId: getIamApplicationId(), guiVersion: '', platformVersion: '', expiryDate: '' };

  const authHeader = getIamAuthHeader();
  if (!authHeader) return result;

  try {
    const infoRootUrl = getIamBaseUrl().replace(/\/iam\/?$/, '') + '/info';
    const infoText = await fetchTextFromUrl(infoRootUrl, authHeader, 8000);
    const versionMatch = /Version<\/b>:\s*([^<]+)/i.exec(infoText || '');
    if (versionMatch) result.platformVersion = versionMatch[1].trim();
  } catch (_) {
    // Best effort; leave platformVersion empty.
  }

  try {
    // The client GUI build version (e.g. "2025.3.13.0") is only recorded on login sessions,
    // not on the application/global settings, so use the most recent session's version.
    const sessionParsed = await fetchJsonFromUrl(
      appUrl + '/usr_session_analysis?$top=1&$orderby=begin_on desc&$select=gui_version',
      authHeader, 10000
    );
    const sessionRow = sessionParsed && Array.isArray(sessionParsed.value) ? sessionParsed.value[0] : null;
    if (sessionRow) result.guiVersion = String(sessionRow.gui_version || '').trim();
  } catch (_) {
    // Best effort; leave guiVersion empty.
  }

  try {
    const parsed = await fetchJsonFromUrl(appUrl + '/gui_global_settings?$top=1', authHeader, 10000);
    const row = parsed && Array.isArray(parsed.value) ? parsed.value[0] : null;
    if (row) {
      const validUntilMatch = /<ValidUntil>([^<]+)<\/ValidUntil>/.exec(String(row.license || ''));
      if (validUntilMatch) result.expiryDate = formatDateDdMmYyyy(validUntilMatch[1].trim());
    }
  } catch (_) {
    // Best effort; leave expiryDate empty.
  }

  return result;
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
  .menu-config-fab {
    position: fixed;
    right: 24px;
    top: 24px;
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
  .menu-config-fab:hover, .menu-config-fab:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .menu-config-fab svg { width: 35px; height: 35px; }
  .menu-config-fab svg path { fill: #1c3f7a; }
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
<style>${SHARED_STYLE}${GB_SHELL_STYLE}${IAM_CONFIG_PANEL_STYLE}
  .iam-config-modal-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); display: none; align-items: center; justify-content: center; z-index: 20; padding: 24px; }
  .iam-config-modal-overlay.open { display: flex; }
  .iam-config-modal-card { position: relative; width: min(560px, 100%); max-height: 85vh; overflow-y: auto; background: #fff; border-radius: 14px; padding: 28px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.3); }
  .iam-config-modal-title { margin: 0 0 6px; font-size: 1.3rem; color: #14305c; }
  .iam-config-modal-subtitle { margin: 0 0 20px; color: #5b6b82; font-size: 0.9rem; }
  .iam-config-modal-close { position: absolute; top: 14px; right: 14px; width: 28px; height: 28px; border: none; border-radius: 8px; background: rgba(11, 63, 156, 0.1); color: #14305c; font-size: 1.1rem; line-height: 1; cursor: pointer; }
  .iam-config-modal-close:hover { background: rgba(11, 63, 156, 0.2); }
</style>
</head>
<body class="notranslate">
<div class="page menu-page">
  <div class="menu-image-wrap">
    ${imageHtml}
    ${hotspotsHtml}
  </div>
  <button class="menu-exit-fab" type="button" title="Afsluiten" id="menuExitBtn">${GB_ICON_POWER_SVG}</button>
  <button class="menu-config-fab" type="button" title="Configuratie IAM gegevens" id="menuConfigBtn">${GB_ICON_GEAR_SVG}</button>
  <div class="iam-config-modal-overlay" id="iamConfigModalOverlay">
    <div class="iam-config-modal-card">
      <button class="iam-config-modal-close" type="button" id="iamConfigModalClose" aria-label="Sluiten">&times;</button>
      <h2 class="iam-config-modal-title">Configuratie IAM gegevens</h2>
      <p class="iam-config-modal-subtitle">De applicatie-URL en applicatie-ID die deze tool gebruikt om verbinding te maken met IAM.</p>
      ${renderIamConfigPanelBody()}
    </div>
  </div>
</div>
<script>${SHARED_SCRIPT}</script>
<script>${IAM_CONFIG_PANEL_SCRIPT}</script>
<script>
  document.querySelectorAll('.hotspot').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const feature = btn.getAttribute('data-feature') || '';
      window.location.href = feature === 'gebruikers' ? '/gebruikersbeheer' : ('/placeholder?feature=' + encodeURIComponent(feature));
    });
  });
  document.getElementById('menuExitBtn').addEventListener('click', cancelWizard);
  const iamConfigModalOverlay = document.getElementById('iamConfigModalOverlay');
  document.getElementById('menuConfigBtn').addEventListener('click', function () {
    iamConfigModalOverlay.classList.add('open');
    loadInfo();
  });
  document.getElementById('iamConfigModalClose').addEventListener('click', function () {
    iamConfigModalOverlay.classList.remove('open');
  });
  iamConfigModalOverlay.addEventListener('click', function (event) {
    if (event.target === iamConfigModalOverlay) iamConfigModalOverlay.classList.remove('open');
  });
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

// Standard gear/cog icon, used for configuration-style nav items.
const GB_ICON_GEAR_SVG = '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="#cbd8ee" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>'
  + '</svg>';

// Pencil (edit) and floppy disk (save) icons, used on the Configuratie IAM gegevens page.
const GB_ICON_PENCIL_SVG = '<img class="gb-icon-img" src="' + gbIconPenDataUri + '" alt="">';
const GB_ICON_SAVE_SVG = '<img class="gb-icon-img" src="' + gbIconSaveButtonDataUri + '" alt="">';

// Shared between the full "Configuratie IAM gegevens" page and its popup on the menu page.
const IAM_CONFIG_PANEL_STYLE = '.gb-panel-title-bar { display: flex; align-items: center; justify-content: space-between; background: #dbeafe; padding: 10px 16px; }'
  + ' .gb-panel-title-bar .gb-panel-title { padding: 0; background: none; }'
  + ' .gb-panel-title-actions { display: flex; gap: 6px; }'
  + ' .gb-icon-btn { width: 28px; height: 28px; border-radius: 8px; border: none; background: rgba(11, 63, 156, 0.12); cursor: pointer; display: flex; align-items: center; justify-content: center; }'
  + ' .gb-icon-btn:hover { background: rgba(11, 63, 156, 0.22); }'
  + ' .gb-icon-btn svg, .gb-icon-btn .gb-icon-img { width: 15px; height: 15px; object-fit: contain; }'
  + ' .gb-config-field { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #eef1f6; }'
  + ' .gb-config-field:last-child { border-bottom: none; }'
  + ' .gb-config-label { flex: 0 0 160px; font-size: 0.85rem; color: #334155; font-weight: 600; }'
  + ' .gb-config-value { color: #14305c; font-size: 0.9rem; word-break: break-all; }'
  + ' .gb-config-input { flex: 1; max-width: 480px; }';

function renderIamConfigPanelBody() {
  return `
      <div class="gb-panel">
        <div class="gb-panel-title-bar">
          <strong class="gb-panel-title">IAM applicatiegegevens</strong>
          <div class="gb-panel-title-actions">
            <button class="gb-icon-btn" type="button" id="configEditBtn" title="Bewerken">${GB_ICON_PENCIL_SVG}</button>
            <button class="gb-icon-btn" type="button" id="configSaveBtn" title="Opslaan" style="display:none;">${GB_ICON_SAVE_SVG}</button>
          </div>
        </div>
        <div class="gb-panel-body">
          <div class="gb-config-field">
            <span class="gb-config-label">Applicatie URL</span>
            <span class="gb-config-value" id="configApplicationUrlView">Laden...</span>
            <input class="gb-search-input gb-config-input" id="configApplicationUrlInput" type="text" style="display:none;">
          </div>
          <div class="gb-config-field">
            <span class="gb-config-label">Applicatie ID</span>
            <span class="gb-config-value" id="configApplicationIdView">Laden...</span>
            <input class="gb-search-input gb-config-input" id="configApplicationIdInput" type="text" style="display:none;">
          </div>
          <div class="gb-config-field">
            <span class="gb-config-label">GUI versie</span>
            <span class="gb-config-value" id="configGuiVersion">Laden...</span>
          </div>
          <div class="gb-config-field">
            <span class="gb-config-label">Platform versie</span>
            <span class="gb-config-value" id="configPlatformVersion">Laden...</span>
          </div>
          <div class="gb-config-field">
            <span class="gb-config-label">Vervaldatum</span>
            <span class="gb-config-value" id="configExpiryDate">Laden...</span>
          </div>
        </div>
      </div>
      <p id="configFeedback" class="gb-note" style="display:none;"></p>
  `;
}

const IAM_CONFIG_PANEL_SCRIPT = `
    const feedback = document.getElementById('configFeedback');
    const editBtn = document.getElementById('configEditBtn');
    const saveBtn = document.getElementById('configSaveBtn');
    const urlView = document.getElementById('configApplicationUrlView');
    const urlInput = document.getElementById('configApplicationUrlInput');
    const idView = document.getElementById('configApplicationIdView');
    const idInput = document.getElementById('configApplicationIdInput');
    const readOnlyFields = {
      guiVersion: document.getElementById('configGuiVersion'),
      platformVersion: document.getElementById('configPlatformVersion'),
      expiryDate: document.getElementById('configExpiryDate')
    };

    function loadInfo() {
      Object.values(readOnlyFields).forEach(function (el) { el.textContent = 'Laden...'; });
      return fetch('/api/configuratie-iam/info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || data.status !== 'ok') {
          feedback.style.display = 'block';
          feedback.className = 'gb-note error';
          feedback.textContent = 'Ophalen mislukt: ' + (data && data.message || 'onbekende fout');
          urlView.textContent = '-';
          idView.textContent = '-';
          Object.values(readOnlyFields).forEach(function (el) { el.textContent = '-'; });
          return;
        }
        urlView.textContent = data.applicationUrl || '-';
        urlInput.value = data.applicationUrl || '';
        idView.textContent = data.applicationId || '-';
        idInput.value = data.applicationId || '';
        readOnlyFields.guiVersion.textContent = data.guiVersion || '-';
        readOnlyFields.platformVersion.textContent = data.platformVersion || '-';
        readOnlyFields.expiryDate.textContent = data.expiryDate || '-';
      }).catch(function () {
        feedback.style.display = 'block';
        feedback.className = 'gb-note error';
        feedback.textContent = 'Ophalen mislukt.';
        urlView.textContent = '-';
        idView.textContent = '-';
        Object.values(readOnlyFields).forEach(function (el) { el.textContent = '-'; });
      });
    }

    function setEditMode(editing) {
      urlView.style.display = editing ? 'none' : '';
      urlInput.style.display = editing ? '' : 'none';
      idView.style.display = editing ? 'none' : '';
      idInput.style.display = editing ? '' : 'none';
      editBtn.style.display = editing ? 'none' : '';
      saveBtn.style.display = editing ? '' : 'none';
    }

    editBtn.addEventListener('click', function () {
      setEditMode(true);
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      fetch('/api/configuratie-iam/save-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationUrl: urlInput.value, applicationId: idInput.value })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.status === 'ok') {
          setEditMode(false);
          return loadInfo().then(function () {
            feedback.style.display = 'block';
            feedback.className = 'gb-note success';
            feedback.textContent = 'Gegevens opgeslagen.';
          });
        }
        feedback.style.display = 'block';
        feedback.className = 'gb-note error';
        feedback.textContent = 'Opslaan mislukt: ' + (data && data.message || 'onbekende fout');
      }).then(function () {
        saveBtn.disabled = false;
      }).catch(function () {
        feedback.style.display = 'block';
        feedback.className = 'gb-note error';
        feedback.textContent = 'Opslaan mislukt.';
        saveBtn.disabled = false;
      });
    });

    loadInfo();
  `;


// `built: false` marks nav entries whose process is not yet implemented (rendered red until inrichting is af).
const GB_NAV_ITEMS = [
  { key: 'dashboard', icon: gbIconDashboardDataUri, label: 'Dashboard', built: true },
  {
    group: 'controle', icon: gbIconUserDataUri, label: 'Controleren gebruikers',
    children: [
      { key: 'controle-omgeving', label: 'Omgeving', built: true },
      { key: 'controle-iam', label: 'IAM', built: true }
    ]
  },
  {
    group: 'toevoegen', icon: gbIconAddGroupDataUri, label: 'Gebruikers toevoegen',
    children: [
      { key: 'toevoegen-omgeving', label: 'Omgeving', built: true },
      { key: 'toevoegen-iam', label: 'IAM', built: true },
      { key: 'toevoegen-vanuit-iam', label: 'Vanuit IAM naar omgeving', built: false }
    ]
  },
  {
    group: 'deactiveren', icon: gbIconDeleteDataUri, label: 'Gebruikers deactiveren',
    children: [
      { key: 'deactiveren-omgeving', label: 'Omgeving', built: false },
      { key: 'deactiveren-iam', label: 'IAM', built: false }
    ]
  },
  { key: 'schonen-iam', icon: gbIconGarbageDataUri, label: 'Gebruiker schonen IAM', built: false },
  { key: 'configuratie-iam', icon: GB_ICON_GEAR_SVG, label: 'Configuratie IAM gegevens', built: true },
  { key: 'afsluiten', icon: GB_ICON_POWER_SVG, label: 'Afsluiten', built: true }
];

const GB_ROUTES = {
  'controle-omgeving': '/gebruikersbeheer/controle-omgeving',
  'controle-iam': '/gebruikersbeheer/controle-iam',
  'toevoegen-omgeving': '/gebruikersbeheer/toevoegen-omgeving',
  'toevoegen-iam': '/gebruikersbeheer/toevoegen-iam',
  'configuratie-iam': '/gebruikersbeheer/configuratie-iam'
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
  .gb-nav-item-unbuilt, .gb-nav-item-unbuilt:hover, .gb-nav-item-unbuilt:focus-visible { color: #f87171; }
  .gb-nav-group-header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; color: #cbd8ee; font-size: 0.95rem; cursor: pointer; border: none; background: none; width: 100%; text-align: left; }
  .gb-nav-group-header:hover, .gb-nav-group-header:focus-visible { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .gb-nav-group-header-active { color: #fff; font-weight: 700; }
  .gb-nav-group-header-unbuilt, .gb-nav-group-header-unbuilt:hover, .gb-nav-group-header-unbuilt:focus-visible { color: #f87171; }
  .gb-nav-group-chevron { margin-left: auto; flex: 0 0 auto; transition: transform 0.15s ease; }
  .gb-nav-group.expanded .gb-nav-group-chevron { transform: rotate(90deg); }
  .gb-nav-children { list-style: none; margin: 0; padding: 0; max-height: 0; overflow: hidden; }
  .gb-nav-group.expanded .gb-nav-children { max-height: 160px; }
  .gb-nav-child-item { display: block; width: 100%; text-align: left; padding: 10px 24px 10px 58px; color: #cbd8ee; font-size: 0.88rem; cursor: pointer; border: none; background: none; }
  .gb-nav-child-item:hover, .gb-nav-child-item:focus-visible { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .gb-nav-child-item-active { background: rgba(255, 255, 255, 0.14); color: #fff; font-weight: 700; }
  .gb-nav-child-item-unbuilt, .gb-nav-child-item-unbuilt:hover, .gb-nav-child-item-unbuilt:focus-visible { color: #f87171; }
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
  .gb-user-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .gb-stats-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .gb-stat-card { flex: 1 1 220px; display: flex; align-items: flex-start; gap: 14px; background: #fbfcfe; border: 1px solid #e7ecf3; border-radius: 14px; padding: 16px 18px; }
  .gb-stat-icon { flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .gb-stat-icon svg { width: 24px; height: 24px; }
  .gb-stat-icon-total { background: #dbeafe; }
  .gb-stat-icon-active { background: #d1fae5; }
  .gb-stat-icon-inactive { background: #ffedd5; }
  .gb-stat-label { font-size: 0.85rem; color: #334155; font-weight: 600; }
  .gb-stat-value { font-size: 1.6rem; color: #14305c; font-weight: 700; line-height: 1.3; }
  .gb-stat-sub { font-size: 0.76rem; color: #8a99b3; }
  .gb-search-input { min-width: 240px; max-width: 360px; width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 999px; font-size: 0.85rem; color: #14305c; background: #fff; }
  .gb-search-input:focus { outline: none; border-color: #2f5fa8; box-shadow: 0 0 0 2px rgba(47, 95, 168, 0.15); }
  .gb-filter-group { display: flex; gap: 8px; }
  .gb-filter-btn { padding: 7px 16px; border: 1px solid #cbd5e1; border-radius: 999px; background: #fff; color: #5b6b82; font-size: 0.8rem; font-weight: 600; cursor: pointer; }
  .gb-filter-btn:hover { background: #f2f6fc; }
  .gb-filter-btn-active { background: #2f5fa8; border-color: #2f5fa8; color: #fff; }
  .gb-user-table-scroll { max-height: 55vh; overflow-y: auto; border: 1px solid #eef1f6; border-radius: 10px; }
  .gb-user-table { width: 100%; border-collapse: separate; border-spacing: 0; }
  .gb-user-table thead th { position: sticky; top: 0; z-index: 1; text-align: left; font-size: 0.8rem; color: #14305c; padding: 8px; background: #eaf2fc; border-bottom: 1px solid #dbe3f1; }
  .gb-user-table tbody td { padding: 8px; font-size: 0.86rem; color: #334155; border-bottom: 1px solid #eef1f6; }
  .gb-user-table tbody tr:nth-child(even) td { background: #fbfcfe; }
  .gb-note { color: #8a99b3; font-size: 0.82rem; margin-top: 10px; }
  .gb-note.error { color: #b91c1c; }
  .gb-note.success { color: #1f8a4c; }
  .gb-actions { display: flex; justify-content: flex-end; gap: 12px; }
  .gb-btn { border-radius: 999px; padding: 10px 24px; font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; background: linear-gradient(135deg, #1c3f7a, #2f5fa8); color: #fff; box-shadow: 0 6px 16px rgba(28, 63, 122, 0.25); }
  .gb-btn:disabled { background: #c7d2e6; color: #fff; box-shadow: none; cursor: not-allowed; }
`;

function renderGbNavHtml(activeKey) {
  return GB_NAV_ITEMS.map(function (item) {
    if (item.children) {
      const isActiveGroup = item.children.some(function (child) { return child.key === activeKey; });
      const expandedClass = isActiveGroup ? ' expanded' : '';
      const headerActiveClass = isActiveGroup ? ' gb-nav-group-header-active' : '';
      const groupUnbuiltClass = item.children.every(function (child) { return !child.built; }) ? ' gb-nav-group-header-unbuilt' : '';
      const iconHtml = item.icon.indexOf('data:image') === 0
        ? '<img class="gb-nav-icon" src="' + item.icon + '" alt="">'
        : item.icon;
      const childrenHtml = item.children.map(function (child) {
        const childActiveClass = child.key === activeKey ? ' gb-nav-child-item-active' : '';
        const childUnbuiltClass = child.built ? '' : ' gb-nav-child-item-unbuilt';
        return '<li><button class="gb-nav-child-item' + childActiveClass + childUnbuiltClass + '" type="button" data-feature="' + child.key + '">' + escapeHtml(child.label) + '</button></li>';
      }).join('');
      return '<li class="gb-nav-group' + expandedClass + '">'
        + '<button class="gb-nav-group-header' + headerActiveClass + groupUnbuiltClass + '" type="button" data-group="' + item.group + '">'
        + iconHtml + ' ' + escapeHtml(item.label)
        + '<span class="gb-nav-group-chevron">&#8250;</span>'
        + '</button>'
        + '<ul class="gb-nav-children">' + childrenHtml + '</ul>'
        + '</li>';
    }
    const activeClass = item.key === activeKey ? ' gb-nav-item-active' : '';
    const unbuiltClass = item.built ? '' : ' gb-nav-item-unbuilt';
    const iconHtml = item.icon.indexOf('data:image') === 0
      ? '<img class="gb-nav-icon" src="' + item.icon + '" alt="">'
      : item.icon;
    return '<li><button class="gb-nav-item' + activeClass + unbuiltClass + '" type="button" data-feature="' + item.key + '">' + iconHtml + ' ' + escapeHtml(item.label) + '</button></li>';
  }).join('');
}

const GB_NAV_SCRIPT = `
  document.querySelectorAll('.gb-nav-group-header[data-group]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.closest('.gb-nav-group').classList.toggle('expanded');
    });
  });

  document.querySelectorAll('.gb-nav-item[data-feature], .gb-nav-child-item[data-feature]').forEach(function (btn) {
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
      <p class="gb-subtitle" id="gbSubtitle">${escapeHtml(subtitle)}</p>
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

// Shared "pick a branch, connect, then show a filterable/searchable user overview"
// page, used by both Controleren gebruikers omgeving and Controleren gebruikers IAM
// (they only differ in which OData entity set is queried for users).
function renderUserOverviewPage(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const activeKey = String(opts.activeKey || '');
  const title = String(opts.title || '');
  const subtitle = String(opts.subtitle || '');
  const connectedSubtitle = String(opts.connectedSubtitle || '');
  const usersApiPath = String(opts.usersApiPath || '');
  const iamOnly = opts.iamOnly === true;
  // connectOnly: after connecting show connectedPanelHtml instead of the user overview.
  const connectOnly = opts.connectOnly === true;
  const connectedPanelHtml = String(opts.connectedPanelHtml || '');
  const connectedPanelStyle = String(opts.connectedPanelStyle || '');
  const connectedPanelScript = String(opts.connectedPanelScript || '');
  const connectionReady = hasConnectionConfig();

  const body = `
      <div class="gb-panel" id="branchesPanel">
        <strong class="gb-panel-title">Beschikbare branches</strong>
        <div class="gb-panel-body" id="branchListWrap">
          <p class="gb-branch-empty">${connectionReady ? 'Bezig met ophalen van omgevingen...' : 'Nog geen verbinding geconfigureerd. Zet TDG_APP_USER en TDG_APP_PASSWORD in de omgeving.'}</p>
        </div>
      </div>

      <div class="gb-actions" id="connectActions">
        <button class="gb-btn" type="button" id="connectBtn" disabled>Verbinden</button>
      </div>
      <p id="connectFeedback" class="gb-note" style="display:none;"></p>

      <div class="gb-stats-row" id="usersStatsRow" style="display:none;">
        <div class="gb-stat-card">
          <span class="gb-stat-icon gb-stat-icon-total">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="8" r="3.2" fill="#2563eb"/><path d="M3.8 19c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="17" cy="9" r="2.4" fill="#2563eb" opacity="0.55"/><path d="M14.6 13.4c2-0.4 4.6 1.1 4.9 3.8" stroke="#2563eb" stroke-width="1.6" stroke-linecap="round" fill="none" opacity="0.55"/></svg>
          </span>
          <div class="gb-stat-text">
            <div class="gb-stat-label">Totaal gebruikers</div>
            <div class="gb-stat-value" id="statTotal">0</div>
            <div class="gb-stat-sub">Alle actieve en inactieve gebruikers</div>
          </div>
        </div>
        <div class="gb-stat-card">
          <span class="gb-stat-icon gb-stat-icon-active">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8.5" r="3.4" fill="#059669"/><path d="M5.6 19c0-3.3 2.6-5.7 6.4-5.7s6.4 2.4 6.4 5.7" stroke="#059669" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
          </span>
          <div class="gb-stat-text">
            <div class="gb-stat-label">Actieve gebruikers</div>
            <div class="gb-stat-value" id="statActive">0</div>
          </div>
        </div>
        <div class="gb-stat-card">
          <span class="gb-stat-icon gb-stat-icon-inactive">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="7.4" stroke="#ea580c" stroke-width="1.8"/><path d="M12 8v4.4l3 2" stroke="#ea580c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          </span>
          <div class="gb-stat-text">
            <div class="gb-stat-label">Inactieve gebruikers</div>
            <div class="gb-stat-value" id="statInactive">0</div>
          </div>
        </div>
      </div>

      <div class="gb-panel" id="usersPanel" style="display:none;">
        <strong class="gb-panel-title">Overzicht gebruikers</strong>
        <div class="gb-panel-body">
          <div class="gb-user-toolbar">
            <input id="usersSearch" class="gb-search-input" type="search" autocomplete="off" placeholder="Zoek gebruiker (id, login, mail)">
            <div class="gb-filter-group">
              <button class="gb-filter-btn gb-filter-btn-active" type="button" data-filter="all">Alle</button>
              <button class="gb-filter-btn" type="button" data-filter="active">Actief</button>
              <button class="gb-filter-btn" type="button" data-filter="inactive">Inactief</button>
            </div>
          </div>
          <p id="usersFeedback" class="gb-branch-empty">Gebruikers ophalen...</p>
          <div class="gb-user-table-scroll" id="usersTableScroll" style="display:none;">
            <table class="gb-user-table" id="usersTable">
              <thead>
                <tr><th>Relation ID</th><th>Login_naam</th><th>Mailadres</th><th>Actief</th></tr>
              </thead>
              <tbody id="usersTbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      ${connectOnly ? '<div id="connectedPanel" style="display:none;">' + connectedPanelHtml + '</div>' : ''}
  `;

  const script = `
    const connectBtn = document.getElementById('connectBtn');
    const feedback = document.getElementById('connectFeedback');
    const branchListWrap = document.getElementById('branchListWrap');
    const branchesPanel = document.getElementById('branchesPanel');
    const connectActions = document.getElementById('connectActions');
    const usersPanel = document.getElementById('usersPanel');
    const usersStatsRow = document.getElementById('usersStatsRow');
    const statTotal = document.getElementById('statTotal');
    const statActive = document.getElementById('statActive');
    const statInactive = document.getElementById('statInactive');
    const usersFeedback = document.getElementById('usersFeedback');
    const usersTable = document.getElementById('usersTable');
    const usersTableScroll = document.getElementById('usersTableScroll');
    const usersTbody = document.getElementById('usersTbody');
    const usersSearch = document.getElementById('usersSearch');
    const filterButtons = Array.prototype.slice.call(document.querySelectorAll('.gb-filter-btn'));
    const connectionReady = ${connectionReady ? 'true' : 'false'};
    const usersApiPath = ${JSON.stringify(usersApiPath)};
    const connectedSubtitle = ${JSON.stringify(connectedSubtitle)};
    const iamOnly = ${iamOnly ? 'true' : 'false'};
    const connectOnly = ${connectOnly ? 'true' : 'false'};
    let selectedValue = '';
    let pollActive = connectionReady;
    let allUsers = [];
    let currentFilter = 'all';
    let currentSearch = '';

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
      if (iamOnly && !selectedValue) {
        selectedValue = items[0].value;
        connectBtn.disabled = false;
      }
      const html = '<ul class="gb-branch-list">' + items.map(function (item) {
        const value = escapeHtmlClient(item.value);
        const checked = item.value === selectedValue ? ' checked' : '';
        const disabled = (item.blocked && !iamOnly) ? ' disabled' : '';
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
        let items = (data && data.items) || [];
        if (iamOnly) items = items.filter(function (item) { return item.value.split('|')[0] === 'IAM'; });
        renderBranches(items);
        pollActive = !!(data && data.discoveryRunning);
        if (pollActive) setTimeout(pollBranches, 2500);
      }).catch(function () {
        // Keep retrying instead of leaving the "Bezig met ophalen..." placeholder stuck forever.
        setTimeout(pollBranches, 2500);
      });
    }

    function loadUsers() {
      usersFeedback.style.display = 'block';
      usersFeedback.className = 'gb-branch-empty';
      usersFeedback.textContent = 'Gebruikers ophalen...';
      usersTableScroll.style.display = 'none';
      fetch(usersApiPath, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || data.status !== 'ok') {
          usersFeedback.className = 'gb-note error';
          usersFeedback.textContent = 'Ophalen mislukt: ' + (data && data.message || 'onbekende fout');
          return;
        }
        allUsers = data.users || [];
        const activeTotal = allUsers.filter(function (u) { return u.active === 1; }).length;
        statTotal.textContent = String(allUsers.length);
        statActive.textContent = String(activeTotal);
        statInactive.textContent = String(allUsers.length - activeTotal);
        usersStatsRow.style.display = allUsers.length ? '' : 'none';
        renderUsersTable();
      }).catch(function () {
        usersFeedback.className = 'gb-note error';
        usersFeedback.textContent = 'Ophalen van gebruikers is mislukt.';
      });
    }

    function renderUsersTable() {
      if (!allUsers.length) {
        usersFeedback.style.display = 'block';
        usersFeedback.className = 'gb-branch-empty';
        usersFeedback.textContent = 'Geen gebruikers gevonden voor deze omgeving.';
        usersTableScroll.style.display = 'none';
        return;
      }

      const needle = currentSearch.trim().toLowerCase();
      const filtered = allUsers.filter(function (user) {
        if (currentFilter === 'active' && user.active !== 1) return false;
        if (currentFilter === 'inactive' && user.active !== 0) return false;
        if (!needle) return true;
        return [user.id, user.loginName, user.mailAddress].some(function (value) {
          return String(value || '').toLowerCase().indexOf(needle) !== -1;
        });
      });

      if (!filtered.length) {
        usersFeedback.style.display = 'block';
        usersFeedback.className = 'gb-branch-empty';
        usersFeedback.textContent = 'Geen gebruikers zichtbaar voor het gekozen filter.';
        usersTableScroll.style.display = 'none';
        return;
      }

      usersFeedback.style.display = 'none';
      usersTbody.innerHTML = filtered.map(function (user) {
        return '<tr><td>' + escapeHtmlClient(user.id) + '</td><td>' + escapeHtmlClient(user.loginName) + '</td><td>'
          + escapeHtmlClient(user.mailAddress) + '</td><td>' + (user.active === 1 ? 'Ja' : 'Nee') + '</td></tr>';
      }).join('');
      usersTableScroll.style.display = '';
    }

    usersSearch.addEventListener('input', function () {
      currentSearch = usersSearch.value || '';
      renderUsersTable();
    });

    filterButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentFilter = btn.getAttribute('data-filter') || 'all';
        filterButtons.forEach(function (other) { other.classList.remove('gb-filter-btn-active'); });
        btn.classList.add('gb-filter-btn-active');
        renderUsersTable();
      });
    });

    function showConnectedState() {
      branchesPanel.style.display = 'none';
      connectActions.style.display = 'none';
      const subtitle = document.getElementById('gbSubtitle');
      if (subtitle && connectedSubtitle) subtitle.textContent = connectedSubtitle;
      if (connectOnly) {
        document.getElementById('connectedPanel').style.display = '';
        document.dispatchEvent(new Event('gb-connected'));
        return;
      }
      usersPanel.style.display = '';
      loadUsers();
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
          badge.textContent = 'Verbonden met ' + data.alias + (data.applicationId ? ' (' + data.applicationId + ')' : '');
          badge.style.display = '';
          showConnectedState();
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

  return renderGbShell(activeKey, title, subtitle, body, connectedPanelStyle, script + connectedPanelScript, true);
}

function renderControleOmgevingPage() {
  return renderUserOverviewPage({
    activeKey: 'controle-omgeving',
    title: 'Controleren gebruikers omgeving',
    subtitle: 'Maak eerst verbinding met een omgeving voordat gebruikers gecontroleerd kunnen worden.',
    connectedSubtitle: 'Onderstaande gebruikers zijn opgehaald uit de gekozen omgeving.',
    usersApiPath: '/api/gebruikersbeheer/controle-omgeving/users'
  });
}

function renderControleIamPage() {
  return renderUserOverviewPage({
    activeKey: 'controle-iam',
    title: 'Controleren gebruikers IAM',
    subtitle: 'Maak eerst verbinding met een omgeving voordat IAM-gebruikers gecontroleerd kunnen worden.',
    connectedSubtitle: 'Onderstaande IAM-gebruikers zijn opgehaald uit de gekozen omgeving.',
    usersApiPath: '/api/gebruikersbeheer/controle-iam/users',
    iamOnly: true
  });
}

// Fields mirror the Werknemer screen in the application; light-blue inputs are required there.
// Reset ("refresh") icon for the Gebruikers toevoegen panel header.
const GB_ICON_RESET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 3.05 6.78"/><path d="M3 4.5v5h5"/></svg>';
const GB_PW_TOGGLE_HTML = '<button class="gb-form-pw-toggle" type="button" title="Wachtwoord tonen" aria-label="Wachtwoord tonen" disabled>'
  + '<svg class="gb-eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  + '<svg class="gb-eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
  + '</button>';

const TOEVOEGEN_FORM_HTML = `
  <form class="gb-panel" id="addUserForm" novalidate autocomplete="off">
    <div class="gb-panel-title-bar">
      <strong class="gb-panel-title">Gebruikers toevoegen</strong>
      <button class="gb-icon-btn gb-icon-btn-plain" type="button" id="addUserResetBtn" title="Velden opschonen">${GB_ICON_RESET_SVG}</button>
    </div>
    <div class="gb-panel-body">
      <div class="gb-form-scroll">
      <div class="gb-form-cols">
      <div class="gb-form-col">
      <h3 class="gb-form-section">Persoonsgegevens</h3>
      <div class="gb-form-grid">
        <span class="gb-form-label">Geslacht:</span>
        <div class="gb-form-radios">
          <label title="Man"><input type="radio" name="gender" value="0" checked> <strong class="gb-form-symbol">&#9794;</strong></label>
          <label title="Vrouw"><input type="radio" name="gender" value="1"> <strong class="gb-form-symbol">&#9792;</strong></label>
        </div>
        <label class="gb-form-label gb-form-label-strong" for="fAchternaam">Achternaam:</label>
        <input class="gb-form-input gb-form-required" id="fAchternaam" name="achternaam" type="text" maxlength="100" autocomplete="off">
        <label class="gb-form-label" for="fTussenvoegsel">Tussenvoegsel:</label>
        <input class="gb-form-input gb-form-short" id="fTussenvoegsel" name="tussenvoegsel" type="text" maxlength="20" autocomplete="off">
        <label class="gb-form-label" for="fVoornaam">Voornaam:</label>
        <input class="gb-form-input gb-form-required" id="fVoornaam" name="voornaam" type="text" maxlength="100" autocomplete="off">
        <label class="gb-form-label" for="fVoorletters">Voorletter(s):</label>
        <input class="gb-form-input gb-form-short gb-form-readonly" id="fVoorletters" name="voorletters" type="text" maxlength="20" readonly tabindex="-1">
      </div>
      </div>

      <div class="gb-form-col">
      <h3 class="gb-form-section">Dienstverband</h3>
      <div class="gb-form-grid">
        <span class="gb-form-label">Intern/extern:</span>
        <div class="gb-form-radios">
          <label><input type="radio" name="dienstverband" value="intern" checked> Intern</label>
          <label><input type="radio" name="dienstverband" value="extern"> Extern</label>
        </div>
        <label class="gb-form-label" for="fInDienstDag">Datum in dienst:</label>
        <div class="gb-date-input gb-form-required" id="fInDienst">
          <input class="gb-date-seg" id="fInDienstDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag">
          <span class="gb-date-sep">/</span>
          <input class="gb-date-seg" id="fInDienstMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand">
          <span class="gb-date-sep">/</span>
          <input class="gb-date-seg gb-date-seg-year" id="fInDienstJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar">
        </div>
        <label class="gb-form-label" for="fUitDienstDag">Datum uit dienst:</label>
        <div class="gb-date-input" id="fUitDienst">
          <input class="gb-date-seg" id="fUitDienstDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag">
          <span class="gb-date-sep">/</span>
          <input class="gb-date-seg" id="fUitDienstMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand">
          <span class="gb-date-sep">/</span>
          <input class="gb-date-seg gb-date-seg-year" id="fUitDienstJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar">
        </div>
        <p class="gb-form-hint" id="uitDienstHint" style="display:none;"></p>
      </div>
      </div>
      </div>

      <div class="gb-form-cols">
      <div class="gb-form-col">
      <h3 class="gb-form-section">Gebruikersgegevens</h3>
      <div class="gb-form-grid">
        <label class="gb-form-label" for="fGebruikersnaam">Gebruikersnaam:</label>
        <input class="gb-form-input gb-form-required" id="fGebruikersnaam" name="gebruikersnaam" type="text" maxlength="100" autocomplete="off">
        <p class="gb-form-hint" id="loginCheck" style="display:none;"></p>
        <label class="gb-form-label" for="fWachtwoord">Wachtwoord:</label>
        <div class="gb-form-pw"><input class="gb-form-input gb-form-required" id="fWachtwoord" name="wachtwoord" type="password" autocomplete="new-password" disabled>${GB_PW_TOGGLE_HTML}</div>
        <label class="gb-form-label" for="fWachtwoord2">Wachtwoord bevestigen:</label>
        <div class="gb-form-pw"><input class="gb-form-input gb-form-required" id="fWachtwoord2" name="wachtwoord2" type="password" autocomplete="new-password" disabled>${GB_PW_TOGGLE_HTML}</div>
        <p class="gb-form-hint" id="pwMismatch" style="display:none;">Wachtwoorden komen niet overeen.</p>
        <label class="gb-form-label" for="fAfdeling">Afdeling:</label>
        <div class="gb-form-lookup"><input class="gb-form-input gb-form-required gb-form-lookup-input" id="fAfdeling" name="afdeling" type="text" readonly title="Kies een afdeling via het vergrootglas"><input type="hidden" id="fAfdelingId" name="afdelingId"><button class="gb-form-lookup-btn gb-form-lookup-btn-active" type="button" id="afdelingLookupBtn" title="Afdeling zoeken">&#128269;</button></div>
        <label class="gb-form-label" for="fAdministratie">Administratie:</label>
        <select class="gb-form-input gb-form-required" id="fAdministratie" name="administratie"><option value=""></option></select>
        <label class="gb-form-label" for="fGebruikersgroep">Gebruikersgroep:</label>
        <div class="gb-form-lookup"><input class="gb-form-input gb-form-required gb-form-lookup-input" id="fGebruikersgroep" name="gebruikersgroep" type="text" readonly title="Kies een gebruikersgroep via het vergrootglas"><input type="hidden" id="fGebruikersgroepId" name="userGroupId"><button class="gb-form-lookup-btn gb-form-lookup-btn-active" type="button" id="groupLookupBtn" title="Gebruikersgroep zoeken">&#128269;</button></div>
      </div>
      </div>

      <div class="gb-form-col">
      <h3 class="gb-form-section">Werknemergegevens</h3>
      <div class="gb-form-grid">
        <label class="gb-form-label" for="fFunctie">Functie:</label>
        <select class="gb-form-input" id="fFunctie" name="functie"><option value=""></option></select>
        <label class="gb-form-label" for="fRol">Rol:</label>
        <select class="gb-form-input" id="fRol" name="rol"><option value=""></option></select>
        <label class="gb-form-label" for="fTelefoon">Telefoon:</label>
        <input class="gb-form-input" id="fTelefoon" name="telefoon" type="tel" maxlength="30" autocomplete="off">
        <label class="gb-form-label" for="fMobiel">Mobiel:</label>
        <input class="gb-form-input" id="fMobiel" name="mobiel" type="tel" maxlength="30" autocomplete="off">
        <label class="gb-form-label" for="fEmail">E-mailadres:</label>
        <input class="gb-form-input gb-form-required" id="fEmail" name="email" type="email" maxlength="254" autocomplete="off">
        <p class="gb-form-hint" id="emailCheck" style="display:none;"></p>
        <label class="gb-form-label" for="fPlanbaar">Planbaar:</label>
        <div><input id="fPlanbaar" name="planbaar" type="checkbox"></div>
      </div>
      </div>
      </div>

      </div>

      <p id="addUserFeedback" class="gb-note" style="display:none;"></p>
      <div class="gb-actions">
        <button class="gb-btn" type="submit">Uitvoeren</button>
      </div>
    </div>
  </form>

  <div class="gb-lookup-overlay" id="deptLookup" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="deptLookupTitle">
    <div class="gb-lookup-dialog">
      <div class="gb-lookup-header"><strong id="deptLookupTitle">Afdelingen</strong></div>
      <div class="gb-lookup-body">
        <div class="gb-lookup-list">
          <input class="gb-search-input gb-lookup-search" id="deptSearch" type="search" autocomplete="off" placeholder="Zoeken">
          <p class="gb-branch-empty" id="deptFeedback">Afdelingen ophalen...</p>
          <div class="gb-lookup-table-scroll" id="deptTableScroll" style="display:none;">
            <table class="gb-user-table gb-lookup-table">
              <thead><tr><th>Administratie</th><th>Afdeling</th><th>Afdelingscode</th><th>Kostenplaats</th></tr></thead>
              <tbody id="deptTbody"></tbody>
            </table>
          </div>
        </div>
        <div class="gb-lookup-detail">
          <h3 class="gb-form-section">Afdeling</h3>
          <h4 class="gb-lookup-subtitle">Toegestaan bij afdeling</h4>
          <div class="gb-lookup-flags" id="deptFlags"></div>
        </div>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="deptSelectBtn" disabled>Selecteren</button>
        <button class="gb-btn gb-btn-secondary" type="button" id="deptCloseBtn">Sluiten</button>
      </div>
    </div>
  </div>

  <div class="gb-lookup-overlay" id="groupLookup" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="groupLookupTitle">
    <div class="gb-lookup-dialog">
      <div class="gb-lookup-header"><strong id="groupLookupTitle">Gebruikersgroepen</strong></div>
      <div class="gb-lookup-body">
        <div class="gb-lookup-list">
          <input class="gb-search-input gb-lookup-search" id="groupSearch" type="search" autocomplete="off" placeholder="Zoeken">
          <p class="gb-branch-empty" id="groupFeedback">Gebruikersgroepen ophalen...</p>
          <div class="gb-lookup-table-scroll" id="groupTableScroll" style="display:none;">
            <table class="gb-user-table gb-lookup-table">
              <thead><tr><th>Gebruikersgroep</th><th>Omschrijving</th><th>Product</th><th>Klantspecifiek</th></tr></thead>
              <tbody id="groupTbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="groupSelectBtn" disabled>Selecteren</button>
        <button class="gb-btn gb-btn-secondary" type="button" id="groupCloseBtn">Sluiten</button>
      </div>
    </div>
  </div>
`;

const TOEVOEGEN_FORM_STYLE = `
  .gb-panel-title-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: #dbeafe; }
  .gb-panel-title-bar .gb-panel-title { padding: 0; background: none; }
  .gb-icon-btn { width: 28px; height: 28px; border-radius: 8px; border: none; background: rgba(11, 63, 156, 0.12); cursor: pointer; display: flex; align-items: center; justify-content: center; color: #0b3f9c; }
  .gb-icon-btn:hover { background: rgba(11, 63, 156, 0.22); }
  .gb-icon-btn-plain { background: none; }
  .gb-icon-btn-plain:hover { background: rgba(11, 63, 156, 0.12); }
  .gb-icon-btn svg { width: 16px; height: 16px; }
  .gb-form-scroll { max-height: calc(100vh - 330px); min-height: 200px; overflow-y: auto; padding-right: 8px; }
  .gb-form-cols { display: flex; gap: 32px; align-items: flex-start; }
  .gb-form-cols + .gb-form-cols { margin-top: 14px; }
  .gb-form-col { flex: 1 1 0; min-width: 0; }
  .gb-form-section { margin: 18px 0 10px; font-size: 1rem; color: #1c3f7a; }
  .gb-form-section:first-child { margin-top: 0; }
  .gb-form-grid { display: grid; grid-template-columns: 200px minmax(0, 360px); gap: 8px 16px; align-items: center; }
  .gb-form-label { font-size: 0.88rem; color: #334155; }
  .gb-form-label-strong { font-weight: 700; }
  .gb-form-input { width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.88rem; color: #14305c; background: #fff; }
  .gb-form-input:focus { outline: none; border-color: #2f5fa8; box-shadow: 0 0 0 2px rgba(47, 95, 168, 0.15); }
  .gb-form-required { background: #eaf2fc; }
  .gb-form-invalid { border-color: #b91c1c; }
  .gb-form-short { max-width: 120px; }
  .gb-form-readonly { background: #eef1f6; color: #14305c; cursor: not-allowed; }
  .gb-form-input:disabled { background: #eef1f6; cursor: not-allowed; }
  .gb-form-pw { position: relative; }
  .gb-form-pw .gb-form-input { padding-right: 36px; }
  .gb-form-pw-toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: none; background: none; padding: 2px; color: #5b6b82; cursor: pointer; display: flex; }
  .gb-form-pw-toggle svg { width: 18px; height: 18px; }
  .gb-form-pw-toggle:hover { color: #1c3f7a; }
  .gb-form-pw-toggle:disabled { opacity: 0.4; cursor: not-allowed; }
  .gb-form-hint { grid-column: 2; margin: -4px 0 0; font-size: 0.78rem; color: #b91c1c; }
  .gb-form-hint.ok { color: #1f8a4c; }
  .gb-form-hint.pending { color: #5b6b82; }
  .gb-form-date { max-width: 180px; }
  .gb-date-input { display: inline-flex; align-items: center; gap: 2px; max-width: 180px; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; }
  .gb-date-input:focus-within { border-color: #2f5fa8; box-shadow: 0 0 0 2px rgba(47, 95, 168, 0.15); }
  .gb-date-input.gb-form-invalid { border-color: #b91c1c; }
  .gb-date-seg { border: none; outline: none; padding: 0; background: transparent; font: inherit; color: #14305c; text-align: center; width: 1.4em; }
  .gb-date-seg-year { width: 2.6em; }
  .gb-date-sep { color: #8a99b3; }
  .gb-form-radios { display: flex; gap: 18px; font-size: 0.9rem; color: #334155; }
  .gb-form-radios label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .gb-form-symbol { font-weight: 900; font-size: 1.25rem; line-height: 1; color: #14305c; -webkit-text-stroke: 1px currentColor; }
  .gb-form-lookup { display: flex; gap: 8px; align-items: center; }
  .gb-form-lookup-btn { border: none; background: none; font-size: 1rem; cursor: pointer; opacity: 0.6; }
  .gb-form-lookup-btn:disabled { cursor: not-allowed; }
  .gb-form-lookup-btn-active { opacity: 1; }
  .gb-form-lookup-input { cursor: default; }
  .gb-lookup-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(20, 48, 92, 0.35); display: flex; align-items: center; justify-content: center; }
  .gb-lookup-dialog { width: min(1100px, 94vw); height: min(640px, 88vh); background: #fff; border-radius: 12px; box-shadow: 0 20px 50px rgba(20, 48, 92, 0.3); display: flex; flex-direction: column; overflow: hidden; }
  .gb-lookup-header { padding: 12px 18px; background: #dbeafe; color: #0b3f9c; font-size: 0.95rem; }
  .gb-lookup-body { flex: 1; min-height: 0; display: flex; }
  .gb-lookup-list { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 14px 16px; gap: 10px; }
  .gb-lookup-search { align-self: flex-end; }
  .gb-lookup-table-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid #eef1f6; border-radius: 10px; }
  .gb-lookup-table tbody tr { cursor: pointer; }
  .gb-lookup-table tbody tr:hover td { background: #f2f6fc; }
  .gb-lookup-table tbody tr.gb-lookup-selected td { background: #cfe3fb; font-weight: 700; }
  .gb-lookup-table td { white-space: nowrap; }
  .gb-lookup-detail { flex: 0 0 300px; border-left: 1px solid #eef1f6; padding: 14px 20px; }
  .gb-lookup-subtitle { margin: 12px 0 10px; font-size: 0.92rem; color: #1c3f7a; }
  .gb-lookup-flags { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; font-size: 0.88rem; color: #334155; }
  .gb-lookup-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 12px 18px; border-top: 1px solid #eef1f6; }
  #addUserForm .gb-actions, #addUserIamForm .gb-actions { margin-top: 20px; }
  .gb-btn-secondary { background: #fff; color: #1c3f7a; border: 1px solid #cbd5e1; box-shadow: none; }
`;

const TOEVOEGEN_FORM_SCRIPT = `
    (function () {
      const form = document.getElementById('addUserForm');
      const addFeedback = document.getElementById('addUserFeedback');
      const submitBtn = form.querySelector('button[type="submit"]');

      // Wires a dd/mm/yyyy segmented date group (3 small inputs) so it behaves like a single
      // field for the rest of the code: adds a .value getter/setter (dd/mm/yyyy string) and a
      // .name directly on the container <div>, since 'input' events bubble from the segments.
      function makeDmyGroup(containerId, name) {
        const container = document.getElementById(containerId);
        const day = document.getElementById(containerId + 'Dag');
        const month = document.getElementById(containerId + 'Maand');
        const year = document.getElementById(containerId + 'Jaar');
        container.name = name;
        Object.defineProperty(container, 'value', {
          get: function () {
            if (!day.value && !month.value && !year.value) return '';
            return day.value.padStart(2, '0') + '/' + month.value.padStart(2, '0') + '/' + year.value;
          },
          set: function (v) {
            const match = /^([0-9]{1,2})\\/([0-9]{1,2})\\/([0-9]{4})$/.exec(String(v || '').trim());
            day.value = match ? match[1].padStart(2, '0') : '';
            month.value = match ? match[2].padStart(2, '0') : '';
            year.value = match ? match[3] : '';
          }
        });
        container.focus = function () { day.focus(); };

        function bindSegment(seg, maxLen, next, prev) {
          seg.addEventListener('input', function () {
            seg.value = seg.value.replace(/[^0-9]/g, '').slice(0, maxLen);
            if (seg.value.length >= maxLen && next) { next.focus(); next.select(); }
          });
          seg.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowRight' && seg.selectionStart === seg.value.length && next) { event.preventDefault(); padSegment(); next.focus(); next.select(); }
            else if (event.key === 'ArrowLeft' && seg.selectionStart === 0 && prev) { event.preventDefault(); padSegment(); prev.focus(); prev.select(); }
            else if (event.key === 'Backspace' && !seg.value && prev) { event.preventDefault(); prev.focus(); prev.select(); }
            else if ((event.key === '/' || event.key === '-') && next) { event.preventDefault(); padSegment(); next.focus(); next.select(); }
          });
          seg.addEventListener('focus', function () { seg.select(); });
          // Zero-pads a partially typed day/month (e.g. "1" -> "01") once the user leaves the segment.
          function padSegment() {
            if (seg.value && seg.value.length < maxLen) seg.value = seg.value.padStart(maxLen, '0');
          }
          seg.addEventListener('blur', padSegment);
        }
        bindSegment(day, 2, month, null);
        bindSegment(month, 2, year, day);
        bindSegment(year, 4, null, month);

        return container;
      }

      const inDienst = makeDmyGroup('fInDienst', 'inDienst');
      const uitDienst = makeDmyGroup('fUitDienst', 'uitDienst');
      const uitDienstHint = document.getElementById('uitDienstHint');

      // dd/mm/yyyy <-> yyyy-mm-dd (ISO), the format users here are used to vs. the format used for logic/payload.
      function parseDmyToIso(value) {
        const match = /^([0-9]{2})\\/([0-9]{2})\\/([0-9]{4})$/.exec(String(value || '').trim());
        if (!match) return '';
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }

      function formatDateAsDmy(date) {
        return String(date.getDate()).padStart(2, '0') + '/' + String(date.getMonth() + 1).padStart(2, '0') + '/' + date.getFullYear();
      }

      // Uit dienst must be at least 1 day after in dienst.
      function minUitDienstIso() {
        const iso = parseDmyToIso(inDienst.value);
        if (!iso) return '';
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }

      function checkUitDienst() {
        const uitDienstValue = uitDienst.value.trim();
        const uitDienstIso = uitDienstValue ? parseDmyToIso(uitDienstValue) : '';
        const min = minUitDienstIso();
        const invalidFormat = !!uitDienstValue && !uitDienstIso;
        const invalidRange = !!uitDienstIso && !!min && uitDienstIso < min;
        const invalid = invalidFormat || invalidRange;
        uitDienst.classList.toggle('gb-form-invalid', invalid);
        uitDienstHint.style.display = invalid ? '' : 'none';
        uitDienstHint.textContent = invalidFormat ? 'Vul een geldige datum in (dd/mm/jjjj).'
          : (invalidRange ? 'Datum uit dienst moet minimaal 1 dag na datum in dienst liggen.' : '');
        return !invalid;
      }

      inDienst.addEventListener('input', checkUitDienst);
      uitDienst.addEventListener('input', checkUitDienst);
      checkUitDienst();

      // Default: the 1st day of the month following today.
      function defaultInDienstValue() {
        const now = new Date();
        const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        return formatDateAsDmy(firstOfNextMonth);
      }
      inDienst.value = defaultInDienstValue();

      const voornaam = document.getElementById('fVoornaam');
      const voorletters = document.getElementById('fVoorletters');
      voornaam.addEventListener('input', function () {
        const start = voornaam.selectionStart;
        const end = voornaam.selectionEnd;
        voornaam.value = voornaam.value.toLowerCase().replace(/(^|[\\s-])(\\S)/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
        voornaam.setSelectionRange(start, end);
        voorletters.value = voornaam.value.split(/[\\s-]+/).filter(Boolean).map(function (name) { return name.charAt(0).toUpperCase() + '.'; }).join('');
      });

      const achternaam = document.getElementById('fAchternaam');
      achternaam.addEventListener('input', function () {
        const start = achternaam.selectionStart;
        const end = achternaam.selectionEnd;
        achternaam.value = achternaam.value.toLowerCase().replace(/(^|[\\s-])(\\S)/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
        achternaam.setSelectionRange(start, end);
      });

      const tussenvoegsel = document.getElementById('fTussenvoegsel');
      tussenvoegsel.addEventListener('input', function () {
        const start = tussenvoegsel.selectionStart;
        const end = tussenvoegsel.selectionEnd;
        tussenvoegsel.value = tussenvoegsel.value.toLowerCase();
        tussenvoegsel.setSelectionRange(start, end);
      });

      function showAddFeedback(text, kind) {
        addFeedback.style.display = 'block';
        addFeedback.className = 'gb-note' + (kind ? ' ' + kind : '');
        addFeedback.textContent = text;
      }

      const gebruikersnaam = document.getElementById('fGebruikersnaam');
      const pwField = document.getElementById('fWachtwoord');
      const pw2Field = document.getElementById('fWachtwoord2');
      const pwMismatch = document.getElementById('pwMismatch');

      function checkPasswordMatch() {
        const mismatch = pw2Field.value !== '' && pwField.value !== pw2Field.value;
        pw2Field.classList.toggle('gb-form-invalid', mismatch);
        pwMismatch.style.display = mismatch ? '' : 'none';
      }

      function setPasswordVisible(input, visible) {
        const btn = input.parentNode.querySelector('.gb-form-pw-toggle');
        input.type = visible ? 'text' : 'password';
        btn.querySelector('.gb-eye-open').style.display = visible ? 'none' : '';
        btn.querySelector('.gb-eye-closed').style.display = visible ? '' : 'none';
        btn.title = visible ? 'Wachtwoord verbergen' : 'Wachtwoord tonen';
        btn.setAttribute('aria-label', btn.title);
      }

      [pwField, pw2Field].forEach(function (input) {
        input.parentNode.querySelector('.gb-form-pw-toggle').addEventListener('click', function () {
          setPasswordVisible(input, input.type === 'password');
        });
      });

      // Wachtwoord unlocks after Gebruikersnaam, bevestigen after Wachtwoord; emptying a field clears what depends on it.
      function updatePasswordAccess() {
        pwField.disabled = !gebruikersnaam.value.trim();
        if (pwField.disabled) pwField.value = '';
        pw2Field.disabled = pwField.disabled || !pwField.value;
        if (pw2Field.disabled) pw2Field.value = '';
        [pwField, pw2Field].forEach(function (input) {
          input.parentNode.querySelector('.gb-form-pw-toggle').disabled = input.disabled;
          if (input.disabled) setPasswordVisible(input, false);
        });
        checkPasswordMatch();
      }

      gebruikersnaam.addEventListener('input', updatePasswordAccess);

      const loginCheck = document.getElementById('loginCheck');
      // 'ok' | 'taken' | 'pending' | 'error' for the value in loginCheckedValue.
      let loginState = '';
      let loginCheckedValue = '';
      let loginCheckPromise = null;

      function showLoginCheck(text, kind) {
        loginCheck.textContent = text;
        loginCheck.className = 'gb-form-hint' + (kind ? ' ' + kind : '');
        loginCheck.style.display = text ? '' : 'none';
        gebruikersnaam.classList.toggle('gb-form-invalid', kind === '' && !!text);
      }

      // Returns a promise resolving to the final loginState ('ok'/'taken'/'error') once known,
      // reusing an in-flight check for the same value instead of starting a duplicate one.
      function checkLoginName() {
        const value = gebruikersnaam.value.trim();
        if (!value) { loginState = ''; loginCheckedValue = ''; loginCheckPromise = null; showLoginCheck('', ''); return Promise.resolve(loginState); }
        if (value === loginCheckedValue && loginState === 'pending' && loginCheckPromise) return loginCheckPromise;
        if (value === loginCheckedValue && loginState !== '' && loginState !== 'error') return Promise.resolve(loginState);
        loginCheckedValue = value;
        loginState = 'pending';
        showLoginCheck('Controleren of gebruikersnaam al bestaat...', 'pending');
        loginCheckPromise = fetch('/api/gebruikersbeheer/toevoegen-omgeving/check-login?login=' + encodeURIComponent(value), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (value !== loginCheckedValue) return loginState;
            if (data && data.status === 'ok') {
              loginState = data.exists ? 'taken' : 'ok';
              showLoginCheck(data.exists ? 'Gebruikersnaam bestaat al in deze omgeving.' : 'Gebruikersnaam is beschikbaar.', data.exists ? '' : 'ok');
            } else {
              loginState = 'error';
              showLoginCheck((data && data.message) || 'Controle op bestaande gebruikersnaam is mislukt.', '');
            }
            return loginState;
          })
          .catch(function () {
            if (value !== loginCheckedValue) return loginState;
            loginState = 'error';
            showLoginCheck('Controle op bestaande gebruikersnaam is mislukt.', '');
            return loginState;
          });
      }

      gebruikersnaam.addEventListener('blur', checkLoginName);

      const afdeling = document.getElementById('fAfdeling');
      const afdelingId = document.getElementById('fAfdelingId');
      const deptLookup = document.getElementById('deptLookup');
      const deptSearch = document.getElementById('deptSearch');
      const deptFeedback = document.getElementById('deptFeedback');
      const deptTableScroll = document.getElementById('deptTableScroll');
      const deptTbody = document.getElementById('deptTbody');
      const deptFlags = document.getElementById('deptFlags');
      const deptSelectBtn = document.getElementById('deptSelectBtn');
      const DEPT_FLAGS = [['projects', 'Projecten'], ['contracts', 'Contracten'], ['instructions', 'Opdrachten'], ['employees', 'Werknemers'], ['creditors', 'Crediteuren'], ['debtors', 'Debiteuren']];
      let departments = null;
      let selectedDept = null;

      function renderDeptFlags() {
        deptFlags.innerHTML = DEPT_FLAGS.map(function (flag) {
          const checked = selectedDept && selectedDept.allowed[flag[0]] ? ' checked' : '';
          return '<span>' + flag[1] + ':</span><input type="checkbox" disabled' + checked + '>';
        }).join('');
      }

      function renderDepartments() {
        const needle = (deptSearch.value || '').trim().toLowerCase();
        const rows = departments.filter(function (d) {
          return !needle || [d.administration, d.name, d.code, d.costCenter].some(function (v) {
            return String(v || '').toLowerCase().indexOf(needle) !== -1;
          });
        });
        if (!rows.length) {
          deptFeedback.style.display = '';
          deptFeedback.className = 'gb-branch-empty';
          deptFeedback.textContent = departments.length ? 'Geen afdelingen gevonden voor deze zoekterm.' : 'Geen afdelingen gevonden.';
          deptTableScroll.style.display = 'none';
          return;
        }
        deptFeedback.style.display = 'none';
        deptTbody.innerHTML = rows.map(function (d) {
          const sel = selectedDept && selectedDept.id === d.id ? ' class="gb-lookup-selected"' : '';
          return '<tr data-id="' + escapeHtmlClient(d.id) + '"' + sel + '><td>' + escapeHtmlClient(d.administration) + '</td><td>' + escapeHtmlClient(d.name)
            + '</td><td>' + escapeHtmlClient(d.code) + '</td><td>' + escapeHtmlClient(d.costCenter) + '</td></tr>';
        }).join('');
        deptTableScroll.style.display = '';
      }

      function pickDept(id) {
        selectedDept = departments.find(function (d) { return String(d.id) === String(id); }) || null;
        deptSelectBtn.disabled = !selectedDept;
        renderDeptFlags();
        renderDepartments();
      }

      function closeDeptLookup() {
        deptLookup.style.display = 'none';
        afdeling.focus();
      }

      function confirmDept() {
        if (!selectedDept) return;
        afdeling.value = selectedDept.name;
        afdelingId.value = selectedDept.id;
        afdeling.classList.remove('gb-form-invalid');
        closeDeptLookup();
      }

      let departmentsRequest = null;
      function loadDepartments() {
        if (!departmentsRequest) {
          departmentsRequest = fetch('/api/gebruikersbeheer/toevoegen-omgeving/departments', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
              departments = data.departments || [];
              return departments;
            })
            .catch(function (err) { departmentsRequest = null; throw err; });
        }
        return departmentsRequest;
      }

      document.addEventListener('gb-connected', function () {
        const administratie = document.getElementById('fAdministratie');
        fetch('/api/gebruikersbeheer/toevoegen-omgeving/administrations', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
            // option value = system_administration_id (kept for processing, not shown).
            administratie.innerHTML = '<option value=""></option>' + (data.administrations || []).map(function (a) {
              return '<option value="' + escapeHtmlClient(a.id) + '"' + (a.initial ? ' selected' : '') + '>' + escapeHtmlClient(a.name) + '</option>';
            }).join('');
          })
          .catch(function (err) {
            showAddFeedback('Ophalen van administraties is mislukt: ' + (err && err.message || 'onbekende fout'), 'error');
          });

        const functie = document.getElementById('fFunctie');
        fetch('/api/gebruikersbeheer/toevoegen-omgeving/employee-functions', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
            // option value = employee_function_id (kept for processing, not shown).
            functie.innerHTML = '<option value=""></option>' + (data.functions || []).map(function (f) {
              return '<option value="' + escapeHtmlClient(f.id) + '">' + escapeHtmlClient(f.name) + '</option>';
            }).join('');
          })
          .catch(function (err) {
            showAddFeedback('Ophalen van functies is mislukt: ' + (err && err.message || 'onbekende fout'), 'error');
          });

        const rol = document.getElementById('fRol');
        fetch('/api/gebruikersbeheer/toevoegen-omgeving/employee-roles', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
            // option value = employee_role_id (kept for processing, not shown).
            rol.innerHTML = '<option value=""></option>' + (data.roles || []).map(function (r) {
              return '<option value="' + escapeHtmlClient(r.id) + '">' + escapeHtmlClient(r.name) + '</option>';
            }).join('');
          })
          .catch(function (err) {
            showAddFeedback('Ophalen van rollen is mislukt: ' + (err && err.message || 'onbekende fout'), 'error');
          });

        loadDepartments().then(function (list) {
          if (afdelingId.value) return;
          const def = list.find(function (d) { return d.name.trim().toLowerCase() === 'administratie'; });
          if (!def) return;
          afdeling.value = def.name;
          afdelingId.value = def.id;
        }).catch(function () {});
      });

      function openDeptLookup() {
        deptLookup.style.display = '';
        selectedDept = departments && afdelingId.value ? departments.find(function (d) { return String(d.id) === afdelingId.value; }) || null : null;
        deptSelectBtn.disabled = !selectedDept;
        renderDeptFlags();
        deptSearch.value = '';
        deptSearch.focus();
        if (departments) { renderDepartments(); return; }
        deptFeedback.style.display = '';
        deptFeedback.className = 'gb-branch-empty';
        deptFeedback.textContent = 'Afdelingen ophalen...';
        loadDepartments().then(function () {
          selectedDept = afdelingId.value ? departments.find(function (d) { return String(d.id) === afdelingId.value; }) || null : null;
          deptSelectBtn.disabled = !selectedDept;
          renderDeptFlags();
          renderDepartments();
        }).catch(function (err) {
          deptFeedback.className = 'gb-note error';
          deptFeedback.textContent = 'Ophalen mislukt: ' + (err && err.message || 'onbekende fout');
        });
      }

      document.getElementById('afdelingLookupBtn').addEventListener('click', openDeptLookup);
      document.getElementById('deptCloseBtn').addEventListener('click', closeDeptLookup);
      deptSelectBtn.addEventListener('click', confirmDept);
      deptSearch.addEventListener('input', function () { if (departments) renderDepartments(); });
      deptTbody.addEventListener('click', function (event) {
        const row = event.target.closest('tr[data-id]');
        if (row) pickDept(row.getAttribute('data-id'));
      });
      deptTbody.addEventListener('dblclick', function (event) {
        const row = event.target.closest('tr[data-id]');
        if (row) { pickDept(row.getAttribute('data-id')); confirmDept(); }
      });
      deptLookup.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeDeptLookup();
      });

      const gebruikersgroep = document.getElementById('fGebruikersgroep');
      const gebruikersgroepId = document.getElementById('fGebruikersgroepId');
      const groupLookup = document.getElementById('groupLookup');
      const groupSearch = document.getElementById('groupSearch');
      const groupFeedback = document.getElementById('groupFeedback');
      const groupTableScroll = document.getElementById('groupTableScroll');
      const groupTbody = document.getElementById('groupTbody');
      const groupSelectBtn = document.getElementById('groupSelectBtn');
      let userGroups = null;
      let selectedGroup = null;

      function renderUserGroups() {
        const needle = (groupSearch.value || '').trim().toLowerCase();
        const rows = userGroups.filter(function (g) {
          return !needle || [g.id, g.description, g.product].some(function (v) {
            return String(v || '').toLowerCase().indexOf(needle) !== -1;
          });
        });
        if (!rows.length) {
          groupFeedback.style.display = '';
          groupFeedback.className = 'gb-branch-empty';
          groupFeedback.textContent = userGroups.length ? 'Geen gebruikersgroepen gevonden voor deze zoekterm.' : 'Geen gebruikersgroepen gevonden.';
          groupTableScroll.style.display = 'none';
          return;
        }
        groupFeedback.style.display = 'none';
        groupTbody.innerHTML = rows.map(function (g) {
          const sel = selectedGroup && selectedGroup.id === g.id ? ' class="gb-lookup-selected"' : '';
          return '<tr data-id="' + escapeHtmlClient(g.id) + '"' + sel + '><td>' + escapeHtmlClient(g.id) + '</td><td>' + escapeHtmlClient(g.description)
            + '</td><td>' + escapeHtmlClient(g.product) + '</td><td><input type="checkbox" disabled' + (g.customerSpecific ? ' checked' : '') + '></td></tr>';
        }).join('');
        groupTableScroll.style.display = '';
      }

      function pickGroup(id) {
        selectedGroup = userGroups.find(function (g) { return g.id === id; }) || null;
        groupSelectBtn.disabled = !selectedGroup;
        renderUserGroups();
      }

      function closeGroupLookup() {
        groupLookup.style.display = 'none';
        gebruikersgroep.focus();
      }

      function confirmGroup() {
        if (!selectedGroup) return;
        gebruikersgroep.value = selectedGroup.description || selectedGroup.id;
        gebruikersgroepId.value = selectedGroup.id;
        closeGroupLookup();
      }

      function openGroupLookup() {
        groupLookup.style.display = '';
        groupSearch.value = '';
        groupSearch.focus();
        if (userGroups) {
          selectedGroup = userGroups.find(function (g) { return g.id === gebruikersgroepId.value; }) || null;
          groupSelectBtn.disabled = !selectedGroup;
          renderUserGroups();
          return;
        }
        groupSelectBtn.disabled = true;
        groupFeedback.style.display = '';
        groupFeedback.className = 'gb-branch-empty';
        groupFeedback.textContent = 'Gebruikersgroepen ophalen...';
        fetch('/api/gebruikersbeheer/toevoegen-omgeving/user-groups', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
            userGroups = data.userGroups || [];
            selectedGroup = userGroups.find(function (g) { return g.id === gebruikersgroepId.value; }) || null;
            groupSelectBtn.disabled = !selectedGroup;
            renderUserGroups();
          })
          .catch(function (err) {
            groupFeedback.className = 'gb-note error';
            groupFeedback.textContent = 'Ophalen mislukt: ' + (err && err.message || 'onbekende fout');
          });
      }

      document.getElementById('groupLookupBtn').addEventListener('click', openGroupLookup);
      document.getElementById('groupCloseBtn').addEventListener('click', closeGroupLookup);
      groupSelectBtn.addEventListener('click', confirmGroup);
      groupSearch.addEventListener('input', function () { if (userGroups) renderUserGroups(); });
      groupTbody.addEventListener('click', function (event) {
        const row = event.target.closest('tr[data-id]');
        if (row) pickGroup(row.getAttribute('data-id'));
      });
      groupTbody.addEventListener('dblclick', function (event) {
        const row = event.target.closest('tr[data-id]');
        if (row) { pickGroup(row.getAttribute('data-id')); confirmGroup(); }
      });
      groupLookup.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeGroupLookup();
      });
      gebruikersnaam.addEventListener('input', function () {
        if (gebruikersnaam.value.trim() !== loginCheckedValue) { loginState = ''; loginCheckPromise = null; showLoginCheck('', ''); }
      });
      pwField.addEventListener('input', updatePasswordAccess);
      pw2Field.addEventListener('input', checkPasswordMatch);

      // Syntax rules (RFC-ish, deliberately stricter than the browser's built-in email validation).
      function validateEmailSyntax(value) {
        if (!value) return 'Vul een e-mailadres in.';
        if (value.length > 254) return 'E-mailadres mag maximaal 254 tekens bevatten.';
        const atCount = (value.match(/@/g) || []).length;
        if (atCount !== 1) return 'E-mailadres moet exact \u00e9\u00e9n @-teken bevatten.';
        const parts = value.split('@');
        const local = parts[0];
        const domain = parts[1];
        if (!local) return 'Vul minimaal 1 teken v\u00f3\u00f3r de @ in.';
        if (!domain) return 'Vul minimaal 1 teken na de @ in.';
        if (local.length > 64) return 'Het deel v\u00f3\u00f3r de @ mag maximaal 64 tekens bevatten.';
        if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return 'Het deel v\u00f3\u00f3r de @ bevat niet-toegestane tekens.';
        if (local.startsWith('.') || local.endsWith('.')) return 'Het deel v\u00f3\u00f3r de @ mag niet beginnen of eindigen met een punt.';
        if (local.indexOf('..') !== -1) return 'Het deel v\u00f3\u00f3r de @ mag geen opeenvolgende punten bevatten.';
        if (domain.indexOf('.') === -1) return 'Het domein moet minimaal \u00e9\u00e9n punt bevatten.';
        if (domain.startsWith('-') || domain.endsWith('-')) return 'Het domein mag niet beginnen of eindigen met een koppelteken.';
        if (domain.indexOf('..') !== -1) return 'Het domein mag geen opeenvolgende punten bevatten.';
        const tld = domain.slice(domain.lastIndexOf('.') + 1);
        if (!/^[A-Za-z]{2,24}$/.test(tld)) return 'De extensie achter de laatste punt moet 2 tot 24 letters bevatten.';
        return '';
      }

      const email = document.getElementById('fEmail');
      const emailCheck = document.getElementById('emailCheck');
      // 'ok' | 'invalid' | 'pending' | 'error' for the value in emailCheckedValue.
      let emailState = '';
      let emailCheckedValue = '';
      let emailCheckPromise = null;

      function showEmailCheck(text, kind) {
        emailCheck.textContent = text;
        emailCheck.className = 'gb-form-hint' + (kind ? ' ' + kind : '');
        emailCheck.style.display = text ? '' : 'none';
        email.classList.toggle('gb-form-invalid', kind === '' && !!text);
      }

      // Returns a promise resolving to the final emailState ('ok'/'invalid'/'error') once known,
      // reusing an in-flight check for the same value instead of starting a duplicate one.
      function checkEmail() {
        // Strip every whitespace-like character (regular/non-breaking/zero-width space, BOM), not
        // just at the edges: a space is never intentional in an email address (paste artifacts too).
        const value = email.value.replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]/g, '');
        email.value = value;
        if (!value) { emailState = ''; emailCheckedValue = ''; emailCheckPromise = null; showEmailCheck('', ''); return Promise.resolve(emailState); }
        if (value === emailCheckedValue && emailState === 'pending' && emailCheckPromise) return emailCheckPromise;
        if (value === emailCheckedValue && emailState !== '' && emailState !== 'error') return Promise.resolve(emailState);
        emailCheckedValue = value;
        const syntaxError = validateEmailSyntax(value);
        if (syntaxError) {
          emailState = 'invalid';
          showEmailCheck(syntaxError, '');
          return Promise.resolve(emailState);
        }
        emailState = 'pending';
        showEmailCheck('Domein van e-mailadres controleren...', 'pending');
        const domain = value.split('@')[1];
        emailCheckPromise = fetch('/api/gebruikersbeheer/toevoegen-omgeving/check-email-domain?domain=' + encodeURIComponent(domain), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (value !== emailCheckedValue) return emailState;
            if (!data || data.status !== 'ok') {
              emailState = 'error';
              showEmailCheck((data && data.message) || 'Controle van het domein is mislukt.', '');
              return emailState;
            }
            if (!data.exists) {
              emailState = 'invalid';
              showEmailCheck('Domein van het e-mailadres bestaat niet.', '');
              return emailState;
            }
            showEmailCheck('Controleren of e-mailadres al bestaat...', 'pending');
            return fetch('/api/gebruikersbeheer/toevoegen-omgeving/check-email-exists?email=' + encodeURIComponent(value), { cache: 'no-store' })
              .then(function (r) { return r.json(); })
              .then(function (existsData) {
                if (value !== emailCheckedValue) return emailState;
                if (!existsData || existsData.status !== 'ok') {
                  emailState = 'error';
                  showEmailCheck((existsData && existsData.message) || 'Controle op bestaand e-mailadres is mislukt.', '');
                  return emailState;
                }
                emailState = existsData.exists ? 'invalid' : 'ok';
                showEmailCheck(existsData.exists ? 'E-mailadres bestaat al in deze omgeving.' : '', existsData.exists ? '' : '');
                return emailState;
              });
          })
          .catch(function () {
            if (value !== emailCheckedValue) return emailState;
            emailState = 'error';
            showEmailCheck('Controle van het domein is mislukt.', '');
            return emailState;
          });
        return emailCheckPromise;
      }

      email.addEventListener('blur', checkEmail);
      email.addEventListener('input', function () {
        // Strip every whitespace-like character continuously while typing/pasting (see checkEmail()).
        const cleaned = email.value.replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]/g, '');
        if (cleaned !== email.value) email.value = cleaned;
        if (email.value !== emailCheckedValue) { emailState = ''; emailCheckPromise = null; showEmailCheck('', ''); }
      });

      const REQUIRED_FIELD_LABELS = {
        achternaam: 'Achternaam', voornaam: 'Voornaam', gebruikersnaam: 'Gebruikersnaam',
        wachtwoord: 'Wachtwoord', wachtwoord2: 'Wachtwoord bevestigen', afdeling: 'Afdeling',
        administratie: 'Administratie', gebruikersgroep: 'Gebruikersgroep', inDienst: 'Datum in dienst',
        email: 'E-mailadres'
      };

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        const errors = [];
        form.querySelectorAll('.gb-form-invalid').forEach(function (el) { el.classList.remove('gb-form-invalid'); });
        form.querySelectorAll('.gb-form-required').forEach(function (el) {
          if (!String(el.value || '').trim()) {
            el.classList.add('gb-form-invalid');
            errors.push(REQUIRED_FIELD_LABELS[el.name] || el.name);
          }
        });
        if (errors.length) {
          showAddFeedback('Vul de verplichte velden in: ' + errors.join(', ') + '.', 'error');
          return;
        }

        submitBtn.disabled = true;
        showAddFeedback('Gebruikersnaam en e-mailadres controleren...', '');

        // checkLoginName()/checkEmail() resolve once known (starting or reusing an in-flight
        // check), so awaiting them here fixes clicking Uitvoeren before a field was ever blurred.
        Promise.all([checkLoginName(), checkEmail()]).then(function (states) {
          const finalLoginState = states[0];
          const finalEmailState = states[1];
          const email = document.getElementById('fEmail');

          if (finalLoginState !== 'ok') {
            submitBtn.disabled = false;
            gebruikersnaam.classList.add('gb-form-invalid');
            showAddFeedback(finalLoginState === 'taken' ? 'Gebruikersnaam bestaat al in deze omgeving.'
              : 'Controle op bestaande gebruikersnaam is mislukt; verlaat het veld Gebruikersnaam om opnieuw te controleren.', 'error');
            return;
          }
          if (finalEmailState !== 'ok') {
            submitBtn.disabled = false;
            email.classList.add('gb-form-invalid');
            showAddFeedback(finalEmailState === 'invalid' ? (emailCheck.textContent || 'Ongeldig e-mailadres.')
              : 'Controle van het e-mailadres is mislukt; verlaat het veld E-mailadres om opnieuw te controleren.', 'error');
            return;
          }

          const pw = document.getElementById('fWachtwoord');
          const pw2 = document.getElementById('fWachtwoord2');
          if (pw.value !== pw2.value) {
            submitBtn.disabled = false;
            pw2.classList.add('gb-form-invalid');
            pwMismatch.style.display = '';
            showAddFeedback('Wachtwoorden komen niet overeen.', 'error');
            return;
          }
          const uitDienst = document.getElementById('fUitDienst');
          if (uitDienst.value.trim() && !checkUitDienst()) {
            submitBtn.disabled = false;
            showAddFeedback(uitDienstHint.textContent || 'Datum uit dienst is ongeldig.', 'error');
            return;
          }
          if (inDienst.value.trim() && !parseDmyToIso(inDienst.value)) {
            submitBtn.disabled = false;
            inDienst.classList.add('gb-form-invalid');
            showAddFeedback('Vul een geldige datum in bij Datum in dienst (dd/mm/jjjj).', 'error');
            return;
          }

          showAddFeedback('Gebruiker aanmaken...', '');

          const payload = {
            gender: (form.querySelector('input[name="gender"]:checked') || {}).value,
            achternaam: document.getElementById('fAchternaam').value.trim(),
            tussenvoegsel: document.getElementById('fTussenvoegsel').value.trim(),
            voornaam: document.getElementById('fVoornaam').value.trim(),
            voorletters: document.getElementById('fVoorletters').value.trim(),
            gebruikersnaam: gebruikersnaam.value.trim(),
            wachtwoord: pw.value,
            wachtwoord2: pw2.value,
            afdelingId: afdelingId.value,
            administratieId: document.getElementById('fAdministratie').value,
            gebruikersgroepId: gebruikersgroepId.value,
            functieId: document.getElementById('fFunctie').value,
          rolId: document.getElementById('fRol').value,
          telefoon: document.getElementById('fTelefoon').value.trim(),
          mobiel: document.getElementById('fMobiel').value.trim(),
          email: email.value.trim(),
          planbaar: document.getElementById('fPlanbaar').checked,
          internExtern: (form.querySelector('input[name="dienstverband"]:checked') || {}).value === 'extern' ? '1' : '0',
          inDienst: parseDmyToIso(inDienst.value)
        };

        fetch('/api/gebruikersbeheer/toevoegen-omgeving/create-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (!data || data.status !== 'ok') {
            submitBtn.disabled = false;
            showAddFeedback((data && data.message) || 'Aanmaken van de gebruiker is mislukt.', 'error');
            return;
          }
          const employeeId = data.result && data.result.employee_id;
          // Uitvoeren blijft inactief tot het formulier via het opschoon-icoon is leeggemaakt.
          showAddFeedback('Gebruiker aangemaakt' + (employeeId ? ' (employee_id: ' + employeeId + ')' : '') + '.', 'success');
        }).catch(function () {
          submitBtn.disabled = false;
          showAddFeedback('Aanmaken van de gebruiker is mislukt.', 'error');
        });
        });
      });

      // Clears every field, except that fields with a default value (Geslacht, Intern/extern,
      // Datum in dienst, Administratie, Afdeling) get that default value back instead of blank.
      function resetForm() {
        form.reset();
        form.querySelectorAll('.gb-form-invalid').forEach(function (el) { el.classList.remove('gb-form-invalid'); });
        addFeedback.style.display = 'none';
        submitBtn.disabled = false;

        inDienst.value = defaultInDienstValue();
        checkUitDienst();

        loginState = '';
        loginCheckedValue = '';
        loginCheckPromise = null;
        showLoginCheck('', '');
        emailState = '';
        emailCheckedValue = '';
        emailCheckPromise = null;
        showEmailCheck('', '');

        setPasswordVisible(pwField, false);
        setPasswordVisible(pw2Field, false);
        updatePasswordAccess();

        const applyDefaultDept = function (list) {
          const def = list.find(function (d) { return d.name.trim().toLowerCase() === 'administratie'; });
          afdeling.value = def ? def.name : '';
          afdelingId.value = def ? def.id : '';
        };
        if (departments) {
          applyDefaultDept(departments);
        } else {
          afdeling.value = '';
          afdelingId.value = '';
          loadDepartments().then(applyDefaultDept).catch(function () {});
        }
      }

      document.getElementById('addUserResetBtn').addEventListener('click', resetForm);
    })();
`;

function renderToevoegenOmgevingPage() {
  return renderUserOverviewPage({
    activeKey: 'toevoegen-omgeving',
    title: 'Gebruikers toevoegen omgeving',
    subtitle: 'Maak eerst verbinding met een omgeving voordat gebruikers toegevoegd kunnen worden.',
    connectedSubtitle: 'Verbonden. Voeg gebruikers toe aan de gekozen omgeving.',
    connectOnly: true,
    connectedPanelHtml: TOEVOEGEN_FORM_HTML,
    connectedPanelStyle: TOEVOEGEN_FORM_STYLE,
    connectedPanelScript: TOEVOEGEN_FORM_SCRIPT
  });
}

// Branches step mirrors Controleren gebruikers IAM (iamOnly filter). Layout below mirrors the
// IAM "Gebruiker" screen (Algemeen/Informatie/Periode left, Authenticatie/Login/Wachtwoord/
// Gebruikersvoorkeuren right); fields are static for now, API wiring follows in a later step.
function renderToevoegenIamFormHtml() {
  const now = new Date();
  const begintOpMaand = String(now.getMonth() + 1).padStart(2, '0');
  const begintOpJaar = String(now.getFullYear());
  return `
  <form class="gb-panel" id="addUserIamForm" novalidate autocomplete="off">
    <div class="gb-panel-title-bar">
      <strong class="gb-panel-title">Gebruikers toevoegen</strong>
      <button class="gb-icon-btn gb-icon-btn-plain" type="button" id="addUserIamResetBtn" title="Velden opschonen">${GB_ICON_RESET_SVG}</button>
    </div>
    <div class="gb-panel-body">
      <div class="gb-form-scroll">
      <div class="gb-form-cols">
      <div class="gb-form-col">
        <h3 class="gb-form-section">Algemeen</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamTenant">Tenant:</label>
          <div class="gb-form-lookup"><input class="gb-form-input gb-form-required gb-form-lookup-input" id="fIamTenant" name="tenant" type="text" readonly title="Kies een tenant via het vergrootglas"><input type="hidden" id="fIamTenantId" name="tenantId"><button class="gb-form-lookup-btn gb-form-lookup-btn-active" type="button" id="tenantLookupBtn" title="Tenant zoeken">&#128269;</button></div>
          <label class="gb-form-label" for="fIamGebruikerId">Gebruiker id (inlognaam):</label>
          <input class="gb-form-input gb-form-required" id="fIamGebruikerId" name="gebruikerId" type="text" maxlength="100" autocomplete="off">
          <p class="gb-form-hint" id="iamLoginCheck" style="display:none;"></p>
          <label class="gb-form-label" for="fIamVoornaam">Voornaam:</label>
          <input class="gb-form-input gb-form-required" id="fIamVoornaam" name="voornaam" type="text" maxlength="100" autocomplete="off">
          <label class="gb-form-label" for="fIamAchternaam">Achternaam:</label>
          <input class="gb-form-input gb-form-required" id="fIamAchternaam" name="achternaam" type="text" maxlength="100" autocomplete="off">
          <label class="gb-form-label" for="fIamGeslacht">Geslacht:</label>
          <select class="gb-form-input" id="fIamGeslacht" name="geslacht">
            <option value="man" selected>Man</option>
            <option value="vrouw">Vrouw</option>
          </select>
          <label class="gb-form-label">Profiel foto:</label>
          <div class="gb-form-upload gb-form-upload-disabled" id="fIamProfielFoto">
            <span class="gb-form-upload-text">Niet beschikbaar</span>
            <button class="gb-form-upload-btn" type="button" disabled title="Afbeelding uploaden via deze weg is niet beschikbaar">&#8593;</button>
          </div>
        </div>

        <h3 class="gb-form-section">Informatie</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamEmail">E-mailadres:</label>
          <input class="gb-form-input gb-form-required" id="fIamEmail" name="email" type="email" maxlength="254" autocomplete="off">
          <p class="gb-form-hint" id="iamEmailCheck" style="display:none;"></p>
          <label class="gb-form-label" for="fIamTelefoon">Telefoonnummer:</label>
          <input class="gb-form-input" id="fIamTelefoon" name="telefoon" type="tel" maxlength="30" autocomplete="off">
          <label class="gb-form-label" for="fIamBedrijf">Bedrijf:</label>
          <input class="gb-form-input gb-form-readonly" id="fIamBedrijf" name="bedrijf" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="fIamMedewerkerId">Medewerker identificatie:</label>
          <input class="gb-form-input" id="fIamMedewerkerId" name="medewerkerIdentificatie" type="text" maxlength="100" autocomplete="off">
        </div>

        <h3 class="gb-form-section">Periode</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamBegintOpDag">Begint op:</label>
          <div class="gb-form-split">
            <div class="gb-date-input" id="fIamBegintOp">
              <input class="gb-date-seg" id="fIamBegintOpDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag" value="01">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg" id="fIamBegintOpMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand" value="${begintOpMaand}">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg gb-date-seg-year" id="fIamBegintOpJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar" value="${begintOpJaar}">
            </div>
            <input class="gb-form-input gb-form-short gb-form-readonly" id="fIamBegintOpTijd" name="begintOpTijd" type="text" value="00:00:00" readonly tabindex="-1">
          </div>
          <p class="gb-form-hint" id="iamBegintOpHint" style="display:none;"></p>
          <label class="gb-form-label" for="fIamEindigtOpDag">Eindigt op:</label>
          <div class="gb-form-split">
            <div class="gb-date-input" id="fIamEindigtOp">
              <input class="gb-date-seg" id="fIamEindigtOpDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg" id="fIamEindigtOpMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg gb-date-seg-year" id="fIamEindigtOpJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar">
            </div>
            <input class="gb-form-input gb-form-short gb-form-readonly" id="fIamEindigtOpTijd" name="eindigtOpTijd" type="text" readonly tabindex="-1">
          </div>
          <p class="gb-form-hint" id="iamEindigtOpHint" style="display:none;"></p>
        </div>
      </div>

      <div class="gb-form-col">
        <h3 class="gb-form-section">Authenticatie</h3>
        <div class="gb-form-radios gb-form-radios-vertical">
          <label><input type="radio" name="authenticatie" value="rdbms" disabled> RDBMS</label>
          <label><input type="radio" name="authenticatie" value="kerberos" disabled> Kerberos</label>
          <label><input type="radio" name="authenticatie" value="windows" disabled> Windows</label>
          <label><input type="radio" name="authenticatie" value="extern" disabled> Extern</label>
          <label><input type="radio" name="authenticatie" value="iam" checked> IAM</label>
        </div>

        <h3 class="gb-form-section">Login</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamInlogverificatie">Inlogverificatie:</label>
          <select class="gb-form-input" id="fIamInlogverificatie" name="inlogverificatie">
            <option value="wachtwoord" selected>Wachtwoord</option>
            <option value="wachtwoord_email">Wachtwoord en email</option>
            <option value="wachtwoord_sms">Wachtwoord en SMS</option>
            <option value="wachtwoord_totp">Wachtwoord en TOTP token</option>
          </select>
          <label class="gb-form-label" for="fIamTotpGeregistreerd">TOTP apparaat geregistreerd:</label>
          <div><input id="fIamTotpGeregistreerd" name="totpGeregistreerd" type="checkbox" disabled></div>
          <label class="gb-form-label" for="fIamTerugvallenEmail">Terugvallen op email toegestaan:</label>
          <div><input id="fIamTerugvallenEmail" name="terugvallenEmail" type="checkbox"></div>
          <label class="gb-form-label" for="fIamMaxSessies">Sluit uit van max. # sessies:</label>
          <div><input id="fIamMaxSessies" name="maxSessiesUitgesloten" type="checkbox"></div>
          <label class="gb-form-label" for="fIamPersoonlijkeTokens">Persoonlijke toegangstokens:</label>
          <div><input id="fIamPersoonlijkeTokens" name="persoonlijkeTokens" type="checkbox"></div>
        </div>

        <h3 class="gb-form-section">Wachtwoord</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamWachtwoordWijzigen">Wijzigen toegestaan:</label>
          <div><input id="fIamWachtwoordWijzigen" name="wachtwoordWijzigenToegestaan" type="checkbox"></div>
          <label class="gb-form-label" for="fIamWachtwoordverloopbeleid">Wachtwoordverloopbeleid:</label>
          <select class="gb-form-input" id="fIamWachtwoordverloopbeleid" name="wachtwoordverloopbeleid" disabled>
            <option value="forced_expired">Geforceerd verlopen</option>
            <option value="standard">Standaard beleid</option>
            <option value="never" selected>Verloopt nooit</option>
          </select>
          <label class="gb-form-label"># gewijzigd/vergeten:</label>
          <div class="gb-form-split">
            <input class="gb-form-input gb-form-short gb-form-readonly" id="fIamAantalGewijzigd" name="aantalGewijzigd" type="number" value="0" readonly tabindex="-1">
            <input class="gb-form-input gb-form-short gb-form-readonly" id="fIamAantalVergeten" name="aantalVergeten" type="number" value="0" readonly tabindex="-1">
          </div>
        </div>

        <h3 class="gb-form-section">Gebruikersvoorkeuren</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="fIamConfiguratie">Configuratie:</label>
          <select class="gb-form-input" id="fIamConfiguratie" name="configuratie"><option value="" selected>None</option></select>
          <label class="gb-form-label" for="fIamApplicatieTaal">Applicatie taal:</label>
          <select class="gb-form-input" id="fIamApplicatieTaal" name="applicatieTaal"><option value=""></option></select>
          <label class="gb-form-label" for="fIamDatumnotatie">Datumnotatie:</label>
          <input class="gb-form-input gb-form-readonly" id="fIamDatumnotatie" name="datumnotatie" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="fIamGetalnotatie">Getalnotatie:</label>
          <input class="gb-form-input gb-form-readonly" id="fIamGetalnotatie" name="getalnotatie" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="fIamTijdzone">Tijdzone:</label>
          <input class="gb-form-input gb-form-readonly" id="fIamTijdzone" name="tijdzone" type="text" value="Etc/UTC" readonly tabindex="-1">
        </div>
      </div>
      </div>
      </div>

      <p id="addUserIamFeedback" class="gb-note" style="display:none;"></p>
      <div class="gb-actions">
        <button class="gb-btn" type="submit">Uitvoeren</button>
      </div>
    </div>
  </form>

  <div class="gb-lookup-overlay" id="iamPasswordDialog" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="iamPasswordDialogTitle">
    <div class="gb-lookup-dialog gb-password-dialog">
      <div class="gb-lookup-header"><strong id="iamPasswordDialogTitle">Wachtwoord wijzigen</strong></div>
      <div class="gb-lookup-body gb-password-dialog-body">
        <div class="gb-form-grid">
          <label class="gb-form-label" for="iamPwTenant">Tenant:</label>
          <input class="gb-form-input gb-form-readonly" id="iamPwTenant" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="iamPwGebruiker">Gebruiker:</label>
          <input class="gb-form-input gb-form-readonly" id="iamPwGebruiker" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="iamPwNieuw">Nieuw wachtwoord:</label>
          <input class="gb-form-input" id="iamPwNieuw" type="password" autocomplete="new-password">
          <label class="gb-form-label" for="iamPwBevestig">Bevestig wachtwoord:</label>
          <input class="gb-form-input" id="iamPwBevestig" type="password" autocomplete="new-password">
        </div>
        <p class="gb-password-strength" id="iamPwStrength">Sterkte: <span id="iamPwStrengthValue">0/5</span></p>
        <p class="gb-note" id="iamPwFeedback" style="display:none;"></p>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="iamPwSubmitBtn" disabled>Uitvoeren</button>
      </div>
    </div>
  </div>

  <div class="gb-lookup-overlay" id="iamUgDialog" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="iamUgDialogTitle">
    <div class="gb-lookup-dialog gb-password-dialog">
      <div class="gb-lookup-header"><strong id="iamUgDialogTitle">Gebruikersgroep toevoegen</strong></div>
      <div class="gb-lookup-body gb-password-dialog-body">
        <h3 class="gb-form-section">Gebruiker</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="iamUgTenant">Tenant:</label>
          <input class="gb-form-input gb-form-required gb-form-readonly" id="iamUgTenant" type="text" readonly tabindex="-1">
          <label class="gb-form-label" for="iamUgGebruikersgroep">Gebruikersgroep:</label>
          <div class="gb-form-lookup"><input class="gb-form-input gb-form-required gb-form-lookup-input" id="iamUgGebruikersgroep" type="text" readonly title="Kies een gebruikersgroep via het vergrootglas"><input type="hidden" id="iamUgGebruikersgroepId"><button class="gb-form-lookup-btn gb-form-lookup-btn-active" type="button" id="iamUgGroupLookupBtn" title="Gebruikersgroep zoeken">&#128269;</button></div>
          <label class="gb-form-label" for="iamUgGebruikerId">Gebruiker id:</label>
          <input class="gb-form-input gb-form-required gb-form-readonly" id="iamUgGebruikerId" type="text" readonly tabindex="-1">
        </div>

        <h3 class="gb-form-section">Periode</h3>
        <div class="gb-form-grid">
          <label class="gb-form-label" for="iamUgBegintOpDag">Begint op:</label>
          <div class="gb-form-split">
            <div class="gb-date-input" id="iamUgBegintOp">
              <input class="gb-date-seg" id="iamUgBegintOpDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg" id="iamUgBegintOpMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg gb-date-seg-year" id="iamUgBegintOpJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar">
            </div>
            <input class="gb-form-input gb-form-short gb-form-readonly" id="iamUgBegintOpTijd" type="text" readonly tabindex="-1">
          </div>
          <p class="gb-form-hint" id="iamUgBegintOpHint" style="display:none;"></p>
          <label class="gb-form-label" for="iamUgEindigtOpDag">Eindigt op:</label>
          <div class="gb-form-split">
            <div class="gb-date-input" id="iamUgEindigtOp">
              <input class="gb-date-seg" id="iamUgEindigtOpDag" type="text" inputmode="numeric" maxlength="2" placeholder="dd" autocomplete="off" aria-label="Dag">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg" id="iamUgEindigtOpMaand" type="text" inputmode="numeric" maxlength="2" placeholder="mm" autocomplete="off" aria-label="Maand">
              <span class="gb-date-sep">/</span>
              <input class="gb-date-seg gb-date-seg-year" id="iamUgEindigtOpJaar" type="text" inputmode="numeric" maxlength="4" placeholder="jjjj" autocomplete="off" aria-label="Jaar">
            </div>
            <input class="gb-form-input gb-form-short gb-form-readonly" id="iamUgEindigtOpTijd" type="text" readonly tabindex="-1">
          </div>
          <p class="gb-form-hint" id="iamUgEindigtOpHint" style="display:none;"></p>
          <label class="gb-form-label" for="iamUgOpenId">OpenID aangemaakt:</label>
          <div><input id="iamUgOpenId" type="checkbox"></div>
        </div>
        <p class="gb-note" id="iamUgFeedback" style="display:none;"></p>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="iamUgSubmitBtn" disabled>Uitvoeren</button>
      </div>
    </div>
  </div>

  <div class="gb-lookup-overlay" id="iamUgGroupLookup" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="iamUgGroupLookupTitle">
    <div class="gb-lookup-dialog">
      <div class="gb-lookup-header"><strong id="iamUgGroupLookupTitle">Gebruikersgroepen</strong></div>
      <div class="gb-lookup-body">
        <div class="gb-lookup-list">
          <input class="gb-search-input gb-lookup-search" id="iamUgGroupSearch" type="search" autocomplete="off" placeholder="Zoeken">
          <p class="gb-branch-empty" id="iamUgGroupFeedback">Gebruikersgroepen ophalen...</p>
          <div class="gb-lookup-table-scroll" id="iamUgGroupTableScroll" style="display:none;">
            <table class="gb-user-table gb-lookup-table">
              <thead><tr><th>Gebruikersgroep</th><th>Omschrijving</th><th>Product</th><th>Klantspecifiek</th></tr></thead>
              <tbody id="iamUgGroupTbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="iamUgGroupSelectBtn" disabled>Selecteren</button>
        <button class="gb-btn gb-btn-secondary" type="button" id="iamUgGroupCloseBtn">Sluiten</button>
      </div>
    </div>
  </div>

  <div class="gb-lookup-overlay" id="tenantLookup" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="tenantLookupTitle">
    <div class="gb-lookup-dialog">
      <div class="gb-lookup-header"><strong id="tenantLookupTitle">Tenants</strong></div>
      <div class="gb-lookup-body">
        <div class="gb-lookup-list">
          <input class="gb-search-input gb-lookup-search" id="tenantSearch" type="search" autocomplete="off" placeholder="Zoeken">
          <p class="gb-branch-empty" id="tenantFeedback">Tenants ophalen...</p>
          <div class="gb-lookup-table-scroll" id="tenantTableScroll" style="display:none;">
            <table class="gb-user-table gb-lookup-table">
              <thead><tr><th>Tenant naam</th><th>Standaard tenant</th><th>Klant Identificatie</th><th>Technische Identificatie</th></tr></thead>
              <tbody id="tenantTbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="gb-lookup-footer">
        <button class="gb-btn" type="button" id="tenantSelectBtn" disabled>Selecteren</button>
        <button class="gb-btn gb-btn-secondary" type="button" id="tenantCloseBtn">Sluiten</button>
      </div>
    </div>
  </div>
`;
}

const TOEVOEGEN_IAM_FORM_STYLE = TOEVOEGEN_FORM_STYLE + `
  .gb-form-radios-vertical { display: flex; flex-wrap: wrap; column-gap: 20px; row-gap: 10px; margin-bottom: 18px; }
  .gb-form-radios-vertical label { flex: 0 0 auto; }
  .gb-form-split { display: flex; gap: 8px; }
  .gb-form-split .gb-form-input { flex: 1 1 0; min-width: 0; }
  .gb-form-upload { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 10px; background: #fff; max-width: 220px; }
  .gb-form-upload-text { font-size: 0.82rem; color: #8a99b3; font-style: italic; }
  .gb-form-upload-btn { border: none; background: none; color: #2f5fa8; cursor: pointer; font-size: 1rem; }
  .gb-form-upload-disabled { background: #eef1f6; }
  .gb-form-upload-disabled .gb-form-upload-text { color: #8a99b3; }
  .gb-form-upload-btn:disabled { color: #8a99b3; cursor: not-allowed; }
  #addUserIamForm .gb-form-col:nth-child(2) .gb-form-grid { grid-template-columns: 200px minmax(0, 220px); }
  .gb-password-dialog { width: min(460px, 94vw); height: auto; }
  .gb-password-dialog-body { flex-direction: column; padding: 18px 20px; gap: 14px; }
  .gb-password-dialog-body .gb-form-grid { grid-template-columns: 140px minmax(0, 1fr); }
  .gb-password-strength { margin: 0; font-size: 0.86rem; color: #334155; }
  #iamPwStrengthValue { font-weight: 700; }
  #iamPwStrengthValue.weak { color: #b91c1c; }
  #iamPwStrengthValue.medium { color: #c2850c; }
  #iamPwStrengthValue.strong { color: #1f8a4c; }
`;

const TOEVOEGEN_IAM_FORM_SCRIPT = `
  (function () {
    // Tenant lookup (overlay with search), same pattern as Afdeling/Gebruikersgroep in het
    // omgeving-formulier; de tabel toont alleen Tenant naam/Standaard tenant/Klant+Technische identificatie.
    const tenant = document.getElementById('fIamTenant');
    const tenantId = document.getElementById('fIamTenantId');
    const tenantLookup = document.getElementById('tenantLookup');
    const tenantSearch = document.getElementById('tenantSearch');
    const tenantFeedback = document.getElementById('tenantFeedback');
    const tenantTableScroll = document.getElementById('tenantTableScroll');
    const tenantTbody = document.getElementById('tenantTbody');
    const tenantSelectBtn = document.getElementById('tenantSelectBtn');
    let tenants = null;
    let selectedTenant = null;

    function renderTenants() {
      const needle = (tenantSearch.value || '').trim().toLowerCase();
      const rows = tenants.filter(function (t) {
        return !needle || [t.name, t.customerId, t.technicalId].some(function (v) {
          return String(v || '').toLowerCase().indexOf(needle) !== -1;
        });
      });
      if (!rows.length) {
        tenantFeedback.style.display = '';
        tenantFeedback.className = 'gb-branch-empty';
        tenantFeedback.textContent = tenants.length ? 'Geen tenants gevonden voor deze zoekterm.' : 'Geen tenants gevonden.';
        tenantTableScroll.style.display = 'none';
        return;
      }
      tenantFeedback.style.display = 'none';
      tenantTbody.innerHTML = rows.map(function (t) {
        const sel = selectedTenant && selectedTenant.id === t.id ? ' class="gb-lookup-selected"' : '';
        return '<tr data-id="' + escapeHtmlClient(t.id) + '"' + sel + '><td>' + escapeHtmlClient(t.name) + '</td><td><input type="checkbox" disabled' + (t.isDefault ? ' checked' : '') + '></td><td>'
          + escapeHtmlClient(t.customerId) + '</td><td>' + escapeHtmlClient(t.technicalId) + '</td></tr>';
      }).join('');
      tenantTableScroll.style.display = '';
    }

    function pickTenant(id) {
      selectedTenant = tenants.find(function (t) { return String(t.id) === String(id); }) || null;
      tenantSelectBtn.disabled = !selectedTenant;
      renderTenants();
    }

    function closeTenantLookup() {
      tenantLookup.style.display = 'none';
    }

    function applyTenant(t) {
      tenant.value = t.name;
      tenantId.value = t.id;
      tenant.classList.remove('gb-form-invalid');
    }

    function confirmTenant() {
      if (!selectedTenant) return;
      applyTenant(selectedTenant);
      closeTenantLookup();
    }

    let tenantsRequest = null;
    function loadTenants() {
      if (!tenantsRequest) {
        tenantsRequest = fetch('/api/gebruikersbeheer/toevoegen-iam/tenants', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
            tenants = data.tenants || [];
            return tenants;
          })
          .catch(function (err) { tenantsRequest = null; throw err; });
      }
      return tenantsRequest;
    }

    // Zodra verbonden wordt de default tenant async opgehaald en ingevuld; Uitvoeren moet hierop
    // wachten, anders kan Tenant nog als 'leeg' gemeld worden terwijl de default net onderweg is.
    let tenantDefaultReady = Promise.resolve();

    document.addEventListener('gb-connected', function () {
      tenantDefaultReady = loadTenants().then(function (list) {
        if (tenantId.value) return;
        const def = list.find(function (t) { return t.isDefault; }) || list[0];
        if (def) applyTenant(def);
      }).catch(function () {});

      const applicatieTaal = document.getElementById('fIamApplicatieTaal');
      fetch('/api/gebruikersbeheer/toevoegen-iam/appl-languages', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
          const languages = data.languages || [];
          // Standaard: Nederlands (Nederland), anders de door de bron gemarkeerde standaardtaal, anders de eerste.
          const nl = languages.find(function (l) { return /nederlands/i.test(l.name) && /nederland/i.test(l.name); })
            || languages.find(function (l) { return l.isDefault; })
            || languages[0];
          applicatieTaal.innerHTML = languages.map(function (l) {
            return '<option value="' + escapeHtmlClient(l.id) + '"' + (nl && l.id === nl.id ? ' selected' : '') + '>' + escapeHtmlClient(l.name) + '</option>';
          }).join('');
        })
        .catch(function () {
          // Laat het veld leeg bij een fout; er is geen apart feedback-element voor dit dropdown.
        });

      const configuratie = document.getElementById('fIamConfiguratie');
      fetch('/api/gebruikersbeheer/toevoegen-iam/configuraties', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
          const options = data.configuraties || [];
          const complete = options.find(function (o) { return /complete/i.test(o.name); }) || options[0];
          configuratie.innerHTML = options.map(function (o) {
            return '<option value="' + escapeHtmlClient(o.id) + '"' + (complete && o.id === complete.id ? ' selected' : '') + '>' + escapeHtmlClient(o.name) + '</option>';
          }).join('');
        })
        .catch(function () {
          // Laat het veld leeg bij een fout; er is geen apart feedback-element voor dit dropdown.
        });
    });

    function openTenantLookup() {
      tenantLookup.style.display = '';
      tenantSearch.value = '';
      tenantSearch.focus();
      if (tenants) {
        selectedTenant = tenants.find(function (t) { return String(t.id) === tenantId.value; }) || null;
        tenantSelectBtn.disabled = !selectedTenant;
        renderTenants();
        return;
      }
      tenantSelectBtn.disabled = true;
      tenantFeedback.style.display = '';
      tenantFeedback.className = 'gb-branch-empty';
      tenantFeedback.textContent = 'Tenants ophalen...';
      loadTenants().then(function () {
        selectedTenant = tenants.find(function (t) { return String(t.id) === tenantId.value; }) || null;
        tenantSelectBtn.disabled = !selectedTenant;
        renderTenants();
      }).catch(function (err) {
        tenantFeedback.className = 'gb-note error';
        tenantFeedback.textContent = 'Ophalen mislukt: ' + (err && err.message || 'onbekende fout');
      });
    }

    document.getElementById('tenantLookupBtn').addEventListener('click', openTenantLookup);
    document.getElementById('tenantCloseBtn').addEventListener('click', closeTenantLookup);
    tenantSelectBtn.addEventListener('click', confirmTenant);
    tenantSearch.addEventListener('input', function () { if (tenants) renderTenants(); });
    tenantTbody.addEventListener('click', function (event) {
      const row = event.target.closest('tr[data-id]');
      if (row) pickTenant(row.getAttribute('data-id'));
    });
    tenantTbody.addEventListener('dblclick', function (event) {
      const row = event.target.closest('tr[data-id]');
      if (row) { pickTenant(row.getAttribute('data-id')); confirmTenant(); }
    });
    tenantLookup.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeTenantLookup();
    });

    // TOTP apparaat geregistreerd / Terugvallen op email zijn alleen beschikbaar bij 'Wachtwoord en TOTP token';
    // het TOTP-vinkje volgt die keuze automatisch en blijft altijd disabled (kan niet handmatig uitgezet worden).
    const inlogverificatie = document.getElementById('fIamInlogverificatie');
    const totpGeregistreerd = document.getElementById('fIamTotpGeregistreerd');
    const terugvallenEmail = document.getElementById('fIamTerugvallenEmail');
    const iamTelefoon = document.getElementById('fIamTelefoon');
    function updateLoginAvailability() {
      const isTotp = inlogverificatie.value === 'wachtwoord_totp';
      totpGeregistreerd.checked = isTotp;
      terugvallenEmail.disabled = !isTotp;
      if (!isTotp) terugvallenEmail.checked = false;

      // Bij Wachtwoord en SMS is Telefoonnummer verplicht (SMS-verificatie heeft een telefoonnummer nodig).
      const smsRequired = inlogverificatie.value === 'wachtwoord_sms';
      iamTelefoon.classList.toggle('gb-form-required', smsRequired);
      if (!smsRequired) iamTelefoon.classList.remove('gb-form-invalid');
    }
    inlogverificatie.addEventListener('change', updateLoginAvailability);
    updateLoginAvailability();

    // Wachtwoordverloopbeleid is alleen aanpasbaar als Wijzigen toegestaan aan staat; anders vast op 'Verloopt nooit'.
    const wachtwoordWijzigen = document.getElementById('fIamWachtwoordWijzigen');
    const wachtwoordverloopbeleid = document.getElementById('fIamWachtwoordverloopbeleid');
    function updateWachtwoordverloopbeleidAvailability() {
      wachtwoordverloopbeleid.disabled = !wachtwoordWijzigen.checked;
      if (!wachtwoordWijzigen.checked) wachtwoordverloopbeleid.value = 'never';
    }
    wachtwoordWijzigen.addEventListener('change', updateWachtwoordverloopbeleidAvailability);
    updateWachtwoordverloopbeleidAvailability();

    // Same dd/mm/jjjj segmented-input behaviour as Datum in dienst/Datum uit dienst (omgeving-formulier).
    function bindSegment(seg, maxLen, next, prev) {
      seg.addEventListener('input', function () {
        seg.value = seg.value.replace(/[^0-9]/g, '').slice(0, maxLen);
        if (seg.value.length >= maxLen && next) { next.focus(); next.select(); }
      });
      seg.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight' && seg.selectionStart === seg.value.length && next) { event.preventDefault(); padSegment(); next.focus(); next.select(); }
        else if (event.key === 'ArrowLeft' && seg.selectionStart === 0 && prev) { event.preventDefault(); padSegment(); prev.focus(); prev.select(); }
        else if (event.key === 'Backspace' && !seg.value && prev) { event.preventDefault(); prev.focus(); prev.select(); }
        else if ((event.key === '/' || event.key === '-') && next) { event.preventDefault(); padSegment(); next.focus(); next.select(); }
      });
      seg.addEventListener('focus', function () { seg.select(); });
      function padSegment() {
        if (seg.value && seg.value.length < maxLen) seg.value = seg.value.padStart(maxLen, '0');
      }
      seg.addEventListener('blur', padSegment);
    }

    function bindDmyGroup(prefix) {
      const day = document.getElementById(prefix + 'Dag');
      const month = document.getElementById(prefix + 'Maand');
      const year = document.getElementById(prefix + 'Jaar');
      bindSegment(day, 2, month, null);
      bindSegment(month, 2, year, day);
      bindSegment(year, 4, null, month);
    }

    bindDmyGroup('fIamBegintOp');
    bindDmyGroup('fIamEindigtOp');

    const begintOpDag = document.getElementById('fIamBegintOpDag');
    const begintOpMaandSeg = document.getElementById('fIamBegintOpMaand');
    const begintOpJaarSeg = document.getElementById('fIamBegintOpJaar');
    const begintOp = document.getElementById('fIamBegintOp');
    const begintOpHint = document.getElementById('iamBegintOpHint');
    const eindigtOp = document.getElementById('fIamEindigtOp');
    const eindigtOpHint = document.getElementById('iamEindigtOpHint');

    // dd/mm/jjjj -> yyyy-mm-dd ISO (of '' als de datum niet geldig/compleet is).
    function dmySegmentsToIso(day, month, year) {
      if (!day || !month || !year) return '';
      const d = Number(day);
      const m = Number(month);
      const y = Number(year);
      const date = new Date(y, m - 1, d);
      if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return '';
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    // Begint op is altijd verplicht (mag nooit leeg zijn of een onvolledige/ongeldige datum bevatten).
    function checkBegintOp() {
      const hasAllSegments = !!(begintOpDag.value && begintOpMaandSeg.value && begintOpJaarSeg.value);
      const iso = hasAllSegments ? dmySegmentsToIso(begintOpDag.value, begintOpMaandSeg.value, begintOpJaarSeg.value) : '';
      const invalid = !iso;
      begintOp.classList.toggle('gb-form-invalid', invalid);
      begintOpHint.style.display = invalid ? '' : 'none';
      begintOpHint.textContent = !invalid ? '' : (hasAllSegments ? 'Vul een geldige datum in (dd/mm/jjjj).' : 'Begint op is verplicht; vul een volledige datum in.');
      return !invalid;
    }

    // Eindigt op moet minimaal 1 dag na Begint op liggen.
    function minEindigtOpIso() {
      const iso = dmySegmentsToIso(begintOpDag.value, begintOpMaandSeg.value, begintOpJaarSeg.value);
      if (!iso) return '';
      const d = new Date(iso + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Eindigt op heeft geen default datum; zodra dag/maand/jaar alle 3 gevuld zijn, krijgt het
    // (afgeschermde) tijdveld 00:00:00, anders blijft het leeg.
    const eindigtOpTijd = document.getElementById('fIamEindigtOpTijd');
    const eindigtOpDag = document.getElementById('fIamEindigtOpDag');
    const eindigtOpMaand = document.getElementById('fIamEindigtOpMaand');
    const eindigtOpJaar = document.getElementById('fIamEindigtOpJaar');
    function checkEindigtOp() {
      const hasAllSegments = !!(eindigtOpDag.value && eindigtOpMaand.value && eindigtOpJaar.value);
      eindigtOpTijd.value = hasAllSegments ? '00:00:00' : '';
      const eindigtOpIso = hasAllSegments ? dmySegmentsToIso(eindigtOpDag.value, eindigtOpMaand.value, eindigtOpJaar.value) : '';
      const min = minEindigtOpIso();
      const invalidFormat = hasAllSegments && !eindigtOpIso;
      const invalidRange = !!eindigtOpIso && !!min && eindigtOpIso < min;
      const invalid = invalidFormat || invalidRange;
      eindigtOp.classList.toggle('gb-form-invalid', invalid);
      eindigtOpHint.style.display = invalid ? '' : 'none';
      eindigtOpHint.textContent = invalidFormat ? 'Vul een geldige datum in (dd/mm/jjjj).'
        : (invalidRange ? 'Datum eindigt op moet minimaal 1 dag na datum begint op liggen.' : '');
      return !invalid;
    }
    [eindigtOpDag, eindigtOpMaand, eindigtOpJaar].forEach(function (seg) {
      seg.addEventListener('input', checkEindigtOp);
      seg.addEventListener('blur', checkEindigtOp);
    });
    [begintOpDag, begintOpMaandSeg, begintOpJaarSeg].forEach(function (seg) {
      seg.addEventListener('input', function () { checkBegintOp(); checkEindigtOp(); });
      seg.addEventListener('blur', function () { checkBegintOp(); checkEindigtOp(); });
    });
    checkBegintOp();
    checkEindigtOp();

    // Zelfde hoofdletter-per-woord opmaak als bij Gebruikers toevoegen omgeving.
    const iamVoornaam = document.getElementById('fIamVoornaam');
    iamVoornaam.addEventListener('input', function () {
      const start = iamVoornaam.selectionStart;
      const end = iamVoornaam.selectionEnd;
      iamVoornaam.value = iamVoornaam.value.toLowerCase().replace(/(^|[\\s-])(\\S)/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
      iamVoornaam.setSelectionRange(start, end);
    });

    const iamAchternaam = document.getElementById('fIamAchternaam');
    iamAchternaam.addEventListener('input', function () {
      const start = iamAchternaam.selectionStart;
      const end = iamAchternaam.selectionEnd;
      iamAchternaam.value = iamAchternaam.value.toLowerCase().replace(/(^|[\\s-])(\\S)/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
      iamAchternaam.setSelectionRange(start, end);
    });


    const gebruikerId = document.getElementById('fIamGebruikerId');
    const iamLoginCheck = document.getElementById('iamLoginCheck');
    // 'ok' | 'taken' | 'pending' | 'error' for the value in iamLoginCheckedValue.
    let iamLoginState = '';
    let iamLoginCheckedValue = '';
    let iamLoginCheckPromise = null;

    function showIamLoginCheck(text, kind) {
      iamLoginCheck.textContent = text;
      iamLoginCheck.className = 'gb-form-hint' + (kind ? ' ' + kind : '');
      iamLoginCheck.style.display = text ? '' : 'none';
      gebruikerId.classList.toggle('gb-form-invalid', kind === '' && !!text);
    }

    // Same pattern as de gebruikersnaam-check bij Gebruikers toevoegen omgeving, maar tegen IAM (entiteit 'usr').
    function checkGebruikerId() {
      const value = gebruikerId.value.trim();
      if (!value) { iamLoginState = ''; iamLoginCheckedValue = ''; iamLoginCheckPromise = null; showIamLoginCheck('', ''); return Promise.resolve(iamLoginState); }
      if (value === iamLoginCheckedValue && iamLoginState === 'pending' && iamLoginCheckPromise) return iamLoginCheckPromise;
      if (value === iamLoginCheckedValue && iamLoginState !== '' && iamLoginState !== 'error') return Promise.resolve(iamLoginState);
      iamLoginCheckedValue = value;
      iamLoginState = 'pending';
      showIamLoginCheck('Controleren of gebruiker id al bestaat...', 'pending');
      iamLoginCheckPromise = fetch('/api/gebruikersbeheer/toevoegen-iam/check-login?login=' + encodeURIComponent(value), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (value !== iamLoginCheckedValue) return iamLoginState;
          if (data && data.status === 'ok') {
            iamLoginState = data.exists ? 'taken' : 'ok';
            showIamLoginCheck(data.exists ? 'Gebruiker id bestaat al in IAM.' : 'Gebruiker id is beschikbaar.', data.exists ? '' : 'ok');
          } else {
            iamLoginState = 'error';
            showIamLoginCheck((data && data.message) || 'Controle op bestaand gebruiker id is mislukt.', '');
          }
          return iamLoginState;
        })
        .catch(function () {
          if (value !== iamLoginCheckedValue) return iamLoginState;
          iamLoginState = 'error';
          showIamLoginCheck('Controle op bestaand gebruiker id is mislukt.', '');
          return iamLoginState;
        });
      return iamLoginCheckPromise;
    }

    gebruikerId.addEventListener('blur', checkGebruikerId);
    gebruikerId.addEventListener('input', function () {
      if (gebruikerId.value.trim() !== iamLoginCheckedValue) { iamLoginState = ''; iamLoginCheckPromise = null; showIamLoginCheck('', ''); }
    });

    // Zelfde syntaxregels als bij Gebruikers toevoegen omgeving (RFC-achtig, strenger dan de browser-validatie).
    function validateEmailSyntax(value) {
      if (!value) return 'Vul een e-mailadres in.';
      if (value.length > 254) return 'E-mailadres mag maximaal 254 tekens bevatten.';
      const atCount = (value.match(/@/g) || []).length;
      if (atCount !== 1) return 'E-mailadres moet exact \u00e9\u00e9n @-teken bevatten.';
      const parts = value.split('@');
      const local = parts[0];
      const domain = parts[1];
      if (!local) return 'Vul minimaal 1 teken v\u00f3\u00f3r de @ in.';
      if (!domain) return 'Vul minimaal 1 teken na de @ in.';
      if (local.length > 64) return 'Het deel v\u00f3\u00f3r de @ mag maximaal 64 tekens bevatten.';
      if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return 'Het deel v\u00f3\u00f3r de @ bevat niet-toegestane tekens.';
      if (local.startsWith('.') || local.endsWith('.')) return 'Het deel v\u00f3\u00f3r de @ mag niet beginnen of eindigen met een punt.';
      if (local.indexOf('..') !== -1) return 'Het deel v\u00f3\u00f3r de @ mag geen opeenvolgende punten bevatten.';
      if (domain.indexOf('.') === -1) return 'Het domein moet minimaal \u00e9\u00e9n punt bevatten.';
      if (domain.startsWith('-') || domain.endsWith('-')) return 'Het domein mag niet beginnen of eindigen met een koppelteken.';
      if (domain.indexOf('..') !== -1) return 'Het domein mag geen opeenvolgende punten bevatten.';
      const tld = domain.slice(domain.lastIndexOf('.') + 1);
      if (!/^[A-Za-z]{2,24}$/.test(tld)) return 'De extensie achter de laatste punt moet 2 tot 24 letters bevatten.';
      return '';
    }

    const iamEmail = document.getElementById('fIamEmail');
    const iamEmailCheck = document.getElementById('iamEmailCheck');
    // 'ok' | 'invalid' | 'pending' | 'error' for the value in iamEmailCheckedValue.
    let iamEmailState = '';
    let iamEmailCheckedValue = '';
    let iamEmailCheckPromise = null;

    function showIamEmailCheck(text, kind) {
      iamEmailCheck.textContent = text;
      iamEmailCheck.className = 'gb-form-hint' + (kind ? ' ' + kind : '');
      iamEmailCheck.style.display = text ? '' : 'none';
      iamEmail.classList.toggle('gb-form-invalid', kind === '' && !!text);
    }

    function checkIamEmail() {
      const value = iamEmail.value.replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]/g, '');
      iamEmail.value = value;
      if (!value) { iamEmailState = ''; iamEmailCheckedValue = ''; iamEmailCheckPromise = null; showIamEmailCheck('', ''); return Promise.resolve(iamEmailState); }
      if (value === iamEmailCheckedValue && iamEmailState === 'pending' && iamEmailCheckPromise) return iamEmailCheckPromise;
      if (value === iamEmailCheckedValue && iamEmailState !== '' && iamEmailState !== 'error') return Promise.resolve(iamEmailState);
      iamEmailCheckedValue = value;
      const syntaxError = validateEmailSyntax(value);
      if (syntaxError) {
        iamEmailState = 'invalid';
        showIamEmailCheck(syntaxError, '');
        return Promise.resolve(iamEmailState);
      }
      iamEmailState = 'pending';
      showIamEmailCheck('Domein van e-mailadres controleren...', 'pending');
      const domain = value.split('@')[1];
      iamEmailCheckPromise = fetch('/api/gebruikersbeheer/toevoegen-omgeving/check-email-domain?domain=' + encodeURIComponent(domain), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (value !== iamEmailCheckedValue) return iamEmailState;
          if (!data || data.status !== 'ok') {
            iamEmailState = 'error';
            showIamEmailCheck((data && data.message) || 'Controle van het domein is mislukt.', '');
            return iamEmailState;
          }
          if (!data.exists) {
            iamEmailState = 'invalid';
            showIamEmailCheck('Domein van het e-mailadres bestaat niet.', '');
            return iamEmailState;
          }
          showIamEmailCheck('Controleren of e-mailadres al bestaat...', 'pending');
          return fetch('/api/gebruikersbeheer/toevoegen-iam/check-email-exists?email=' + encodeURIComponent(value), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (existsData) {
              if (value !== iamEmailCheckedValue) return iamEmailState;
              if (!existsData || existsData.status !== 'ok') {
                iamEmailState = 'error';
                showIamEmailCheck((existsData && existsData.message) || 'Controle op bestaand e-mailadres is mislukt.', '');
                return iamEmailState;
              }
              iamEmailState = existsData.exists ? 'invalid' : 'ok';
              showIamEmailCheck(existsData.exists ? 'E-mailadres bestaat al in IAM.' : '', '');
              return iamEmailState;
            });
        })
        .catch(function () {
          if (value !== iamEmailCheckedValue) return iamEmailState;
          iamEmailState = 'error';
          showIamEmailCheck('Controle van het domein is mislukt.', '');
          return iamEmailState;
        });
      return iamEmailCheckPromise;
    }

    iamEmail.addEventListener('blur', checkIamEmail);
    iamEmail.addEventListener('input', function () {
      const cleaned = iamEmail.value.replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]/g, '');
      if (cleaned !== iamEmail.value) iamEmail.value = cleaned;
      if (iamEmail.value !== iamEmailCheckedValue) { iamEmailState = ''; iamEmailCheckPromise = null; showIamEmailCheck('', ''); }
    });

    const iamForm = document.getElementById('addUserIamForm');
    const iamSubmitBtn = iamForm.querySelector('button[type="submit"]');
    const iamAddFeedback = document.getElementById('addUserIamFeedback');

    // Wachtwoord wijzigen pop-up (zelfde opzet als in de applicatie): Tenant/Gebruiker afgeschermd,
    // nieuw/bevestig wachtwoord + sterktemeter. Opent automatisch na aanmaken en kan niet gesloten
    // worden zonder dat het wachtwoord is gezet (geen Annuleren-knop, geen Escape); opslaan-actie volgt later.
    const iamPwDialog = document.getElementById('iamPasswordDialog');
    const iamPwTenant = document.getElementById('iamPwTenant');
    const iamPwGebruiker = document.getElementById('iamPwGebruiker');
    const iamPwNieuw = document.getElementById('iamPwNieuw');
    const iamPwBevestig = document.getElementById('iamPwBevestig');
    const iamPwStrengthValue = document.getElementById('iamPwStrengthValue');
    const iamPwFeedback = document.getElementById('iamPwFeedback');
    const iamPwSubmitBtn = document.getElementById('iamPwSubmitBtn');

    function computePasswordStrength(value) {
      if (!value) return 0;
      let score = 0;
      if (value.length >= 6) score++;
      if (value.length >= 10) score++;
      if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
      if (/[0-9]/.test(value)) score++;
      if (/[^A-Za-z0-9]/.test(value)) score++;
      return score;
    }

    function updatePasswordStrength() {
      const score = computePasswordStrength(iamPwNieuw.value);
      iamPwStrengthValue.textContent = score + '/5';
      iamPwStrengthValue.className = score <= 1 ? 'weak' : (score <= 3 ? 'medium' : 'strong');
    }

    // Uitvoeren wordt pas actief zodra beide velden gevuld zijn en aan elkaar gelijk.
    function checkIamPasswordMatch() {
      const nieuw = iamPwNieuw.value;
      const bevestig = iamPwBevestig.value;
      const bothFilled = !!nieuw && !!bevestig;
      const match = bothFilled && nieuw === bevestig;
      iamPwNieuw.classList.remove('gb-form-invalid');
      iamPwBevestig.classList.toggle('gb-form-invalid', bothFilled && !match);
      if (bothFilled && !match) {
        iamPwFeedback.style.display = '';
        iamPwFeedback.className = 'gb-note error';
        iamPwFeedback.textContent = 'Wachtwoorden komen niet overeen.';
      } else {
        iamPwFeedback.style.display = 'none';
      }
      iamPwSubmitBtn.disabled = !match;
      return match;
    }
    iamPwNieuw.addEventListener('input', function () { updatePasswordStrength(); checkIamPasswordMatch(); });
    iamPwBevestig.addEventListener('input', checkIamPasswordMatch);

    function openIamPasswordDialog() {
      iamPwTenant.value = tenant.value;
      iamPwGebruiker.value = gebruikerId.value.trim();
      iamPwNieuw.value = '';
      iamPwBevestig.value = '';
      updatePasswordStrength();
      checkIamPasswordMatch();
      iamPwFeedback.style.display = 'none';
      iamPwDialog.style.display = '';
      iamPwNieuw.focus();
    }

    // Twee-staps aanroep zoals in de applicatie: eerst set_usr_password, daarna
    // flow_set_usr_password_hash_password met de hash/salt/algoritme uit de eerste respons.
    iamPwSubmitBtn.addEventListener('click', function () {
      if (!checkIamPasswordMatch()) return;
      iamPwSubmitBtn.disabled = true;
      iamPwFeedback.style.display = '';
      iamPwFeedback.className = 'gb-note';
      iamPwFeedback.textContent = 'Wachtwoord wijzigen...';

      fetch('/api/gebruikersbeheer/toevoegen-iam/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenantId.value,
          gebruikerId: gebruikerId.value.trim(),
          nieuw: iamPwNieuw.value,
          bevestig: iamPwBevestig.value,
          strength: computePasswordStrength(iamPwNieuw.value)
        })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || data.status !== 'ok') {
          iamPwSubmitBtn.disabled = false;
          iamPwFeedback.className = 'gb-note error';
          iamPwFeedback.textContent = (data && data.message) || 'Wijzigen van het wachtwoord is mislukt.';
          return;
        }
        iamPwDialog.style.display = 'none';
        openIamUgDialog();
      }).catch(function () {
        iamPwSubmitBtn.disabled = false;
        iamPwFeedback.className = 'gb-note error';
        iamPwFeedback.textContent = 'Wijzigen van het wachtwoord is mislukt.';
      });
    });

    // Gebruikersgroep toevoegen pop-up, direct aansluitend op Wachtwoord wijzigen. De Gebruikersgroep-lookup
    // werkt hetzelfde als bij Gebruikers toevoegen omgeving (zelfde endpoint/tabelkolommen). Geen
    // Annuleren-knop (zelfde "niet kunnen afsluiten zonder actie"-opzet als de wachtwoord pop-up).
    const iamUgDialog = document.getElementById('iamUgDialog');
    const iamUgTenant = document.getElementById('iamUgTenant');
    const iamUgGebruikersgroep = document.getElementById('iamUgGebruikersgroep');
    const iamUgGebruikersgroepId = document.getElementById('iamUgGebruikersgroepId');
    const iamUgGebruikerIdField = document.getElementById('iamUgGebruikerId');
    const iamUgFeedback = document.getElementById('iamUgFeedback');
    const iamUgSubmitBtn = document.getElementById('iamUgSubmitBtn');
    const iamUgOpenId = document.getElementById('iamUgOpenId');

    const iamUgBegintOpDag = document.getElementById('iamUgBegintOpDag');
    const iamUgBegintOpMaand = document.getElementById('iamUgBegintOpMaand');
    const iamUgBegintOpJaar = document.getElementById('iamUgBegintOpJaar');
    const iamUgBegintOpTijd = document.getElementById('iamUgBegintOpTijd');
    const iamUgBegintOp = document.getElementById('iamUgBegintOp');
    const iamUgEindigtOpDag = document.getElementById('iamUgEindigtOpDag');
    const iamUgEindigtOpMaand = document.getElementById('iamUgEindigtOpMaand');
    const iamUgEindigtOpJaar = document.getElementById('iamUgEindigtOpJaar');
    const iamUgEindigtOpTijd = document.getElementById('iamUgEindigtOpTijd');
    const iamUgEindigtOp = document.getElementById('iamUgEindigtOp');

    bindDmyGroup('iamUgBegintOp');
    bindDmyGroup('iamUgEindigtOp');
    const iamUgBegintOpHint = document.getElementById('iamUgBegintOpHint');
    const iamUgEindigtOpHint = document.getElementById('iamUgEindigtOpHint');

    // Begint op moet later liggen dan de begindatum van de gebruiker, en (indien gezet) eerder dan
    // de einddatum van de gebruiker. Eindigt op moet eerder liggen dan de einddatum van de gebruiker
    // (indien gezet), en later dan de begindatum van de gebruiker (en dan Begint op zelf).
    function checkIamUgPeriode() {
      const userBeginIso = dmySegmentsToIso(begintOpDag.value, begintOpMaandSeg.value, begintOpJaarSeg.value);
      const userEndIso = dmySegmentsToIso(eindigtOpDag.value, eindigtOpMaand.value, eindigtOpJaar.value);
      const ugBeginHasAll = !!(iamUgBegintOpDag.value && iamUgBegintOpMaand.value && iamUgBegintOpJaar.value);
      const ugEndHasAll = !!(iamUgEindigtOpDag.value && iamUgEindigtOpMaand.value && iamUgEindigtOpJaar.value);
      const ugBeginIso = ugBeginHasAll ? dmySegmentsToIso(iamUgBegintOpDag.value, iamUgBegintOpMaand.value, iamUgBegintOpJaar.value) : '';
      const ugEndIso = ugEndHasAll ? dmySegmentsToIso(iamUgEindigtOpDag.value, iamUgEindigtOpMaand.value, iamUgEindigtOpJaar.value) : '';
      iamUgBegintOpTijd.value = ugBeginHasAll ? '00:00:00' : '';
      iamUgEindigtOpTijd.value = ugEndHasAll ? '00:00:00' : '';

      let beginInvalid = false;
      let beginMessage = '';
      if (ugBeginHasAll && !ugBeginIso) { beginInvalid = true; beginMessage = 'Vul een geldige datum in (dd/mm/jjjj).'; }
      else if (ugBeginIso && userBeginIso && ugBeginIso <= userBeginIso) { beginInvalid = true; beginMessage = 'Begint op moet later liggen dan de begindatum van de gebruiker.'; }
      else if (ugBeginIso && userEndIso && ugBeginIso >= userEndIso) { beginInvalid = true; beginMessage = 'Begint op moet eerder liggen dan de einddatum van de gebruiker.'; }

      let endInvalid = false;
      let endMessage = '';
      if (ugEndHasAll && !ugEndIso) { endInvalid = true; endMessage = 'Vul een geldige datum in (dd/mm/jjjj).'; }
      else if (ugEndIso && userEndIso && ugEndIso >= userEndIso) { endInvalid = true; endMessage = 'Eindigt op moet eerder liggen dan de einddatum van de gebruiker.'; }
      else if (ugEndIso && userBeginIso && ugEndIso <= userBeginIso) { endInvalid = true; endMessage = 'Eindigt op moet later liggen dan de begindatum van de gebruiker.'; }
      else if (ugEndIso && ugBeginIso && ugEndIso <= ugBeginIso) { endInvalid = true; endMessage = 'Eindigt op moet later liggen dan Begint op.'; }

      iamUgBegintOp.classList.toggle('gb-form-invalid', beginInvalid);
      iamUgBegintOpHint.style.display = beginInvalid ? '' : 'none';
      iamUgBegintOpHint.textContent = beginMessage;
      iamUgEindigtOp.classList.toggle('gb-form-invalid', endInvalid);
      iamUgEindigtOpHint.style.display = endInvalid ? '' : 'none';
      iamUgEindigtOpHint.textContent = endMessage;
      return !beginInvalid && !endInvalid;
    }
    [iamUgBegintOpDag, iamUgBegintOpMaand, iamUgBegintOpJaar, iamUgEindigtOpDag, iamUgEindigtOpMaand, iamUgEindigtOpJaar].forEach(function (seg) {
      seg.addEventListener('input', checkIamUgRequired);
      seg.addEventListener('blur', checkIamUgRequired);
    });

    // Gebruikersgroep-lookup (zelfde data/kolommen als het veld Gebruikersgroep bij Gebruikers toevoegen omgeving).
    const iamUgGroupLookup = document.getElementById('iamUgGroupLookup');
    const iamUgGroupSearch = document.getElementById('iamUgGroupSearch');
    const iamUgGroupFeedback = document.getElementById('iamUgGroupFeedback');
    const iamUgGroupTableScroll = document.getElementById('iamUgGroupTableScroll');
    const iamUgGroupTbody = document.getElementById('iamUgGroupTbody');
    const iamUgGroupSelectBtn = document.getElementById('iamUgGroupSelectBtn');
    let iamUgUserGroups = null;
    let iamUgSelectedGroup = null;

    function checkIamUgRequired() {
      iamUgSubmitBtn.disabled = !iamUgGebruikersgroepId.value || !checkIamUgPeriode();
    }

    function renderIamUgGroups() {
      const needle = (iamUgGroupSearch.value || '').trim().toLowerCase();
      const rows = iamUgUserGroups.filter(function (g) {
        return !needle || [g.id, g.description, g.product].some(function (v) {
          return String(v || '').toLowerCase().indexOf(needle) !== -1;
        });
      });
      if (!rows.length) {
        iamUgGroupFeedback.style.display = '';
        iamUgGroupFeedback.className = 'gb-branch-empty';
        iamUgGroupFeedback.textContent = iamUgUserGroups.length ? 'Geen gebruikersgroepen gevonden voor deze zoekterm.' : 'Geen gebruikersgroepen gevonden.';
        iamUgGroupTableScroll.style.display = 'none';
        return;
      }
      iamUgGroupFeedback.style.display = 'none';
      iamUgGroupTbody.innerHTML = rows.map(function (g) {
        const sel = iamUgSelectedGroup && iamUgSelectedGroup.id === g.id ? ' class="gb-lookup-selected"' : '';
        return '<tr data-id="' + escapeHtmlClient(g.id) + '"' + sel + '><td>' + escapeHtmlClient(g.id) + '</td><td>' + escapeHtmlClient(g.description)
          + '</td><td>' + escapeHtmlClient(g.product) + '</td><td><input type="checkbox" disabled' + (g.customerSpecific ? ' checked' : '') + '></td></tr>';
      }).join('');
      iamUgGroupTableScroll.style.display = '';
    }

    function pickIamUgGroup(id) {
      iamUgSelectedGroup = iamUgUserGroups.find(function (g) { return g.id === id; }) || null;
      iamUgGroupSelectBtn.disabled = !iamUgSelectedGroup;
      renderIamUgGroups();
    }

    function confirmIamUgGroup() {
      if (!iamUgSelectedGroup) return;
      iamUgGebruikersgroep.value = iamUgSelectedGroup.description || iamUgSelectedGroup.id;
      iamUgGebruikersgroepId.value = iamUgSelectedGroup.id;
      iamUgGebruikersgroep.classList.remove('gb-form-invalid');
      checkIamUgRequired();
      iamUgGroupLookup.style.display = 'none';
    }

    function openIamUgGroupLookup() {
      iamUgGroupLookup.style.display = '';
      iamUgGroupSearch.value = '';
      iamUgGroupSearch.focus();
      if (iamUgUserGroups) {
        iamUgSelectedGroup = iamUgUserGroups.find(function (g) { return g.id === iamUgGebruikersgroepId.value; }) || null;
        iamUgGroupSelectBtn.disabled = !iamUgSelectedGroup;
        renderIamUgGroups();
        return;
      }
      iamUgGroupSelectBtn.disabled = true;
      iamUgGroupFeedback.style.display = '';
      iamUgGroupFeedback.className = 'gb-branch-empty';
      iamUgGroupFeedback.textContent = 'Gebruikersgroepen ophalen...';
      fetch('/api/gebruikersbeheer/toevoegen-iam/user-groups', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || data.status !== 'ok') throw new Error((data && data.message) || 'onbekende fout');
          iamUgUserGroups = data.userGroups || [];
          iamUgSelectedGroup = iamUgUserGroups.find(function (g) { return g.id === iamUgGebruikersgroepId.value; }) || null;
          iamUgGroupSelectBtn.disabled = !iamUgSelectedGroup;
          renderIamUgGroups();
        })
        .catch(function (err) {
          iamUgGroupFeedback.className = 'gb-note error';
          iamUgGroupFeedback.textContent = 'Ophalen mislukt: ' + (err && err.message || 'onbekende fout');
        });
    }

    document.getElementById('iamUgGroupLookupBtn').addEventListener('click', openIamUgGroupLookup);
    document.getElementById('iamUgGroupCloseBtn').addEventListener('click', function () { iamUgGroupLookup.style.display = 'none'; });
    iamUgGroupSelectBtn.addEventListener('click', confirmIamUgGroup);
    iamUgGroupSearch.addEventListener('input', function () { if (iamUgUserGroups) renderIamUgGroups(); });
    iamUgGroupTbody.addEventListener('click', function (event) {
      const row = event.target.closest('tr[data-id]');
      if (row) pickIamUgGroup(row.getAttribute('data-id'));
    });
    iamUgGroupTbody.addEventListener('dblclick', function (event) {
      const row = event.target.closest('tr[data-id]');
      if (row) { pickIamUgGroup(row.getAttribute('data-id')); confirmIamUgGroup(); }
    });
    iamUgGroupLookup.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') iamUgGroupLookup.style.display = 'none';
    });

    function openIamUgDialog() {
      iamUgTenant.value = tenant.value;
      iamUgGebruikersgroep.value = '';
      iamUgGebruikersgroepId.value = '';
      iamUgGebruikerIdField.value = (iamVoornaam.value.trim() + ' ' + iamAchternaam.value.trim()).trim() + ' (' + gebruikerId.value.trim() + ')';
      // Begint op/Eindigt op/OpenID aangemaakt starten gelijk aan de periode van de zojuist aangemaakte gebruiker.
      iamUgBegintOpDag.value = begintOpDag.value;
      iamUgBegintOpMaand.value = begintOpMaandSeg.value;
      iamUgBegintOpJaar.value = begintOpJaarSeg.value;
      iamUgEindigtOpDag.value = eindigtOpDag.value;
      iamUgEindigtOpMaand.value = eindigtOpMaand.value;
      iamUgEindigtOpJaar.value = eindigtOpJaar.value;
      iamUgOpenId.checked = false;
      iamUgFeedback.style.display = 'none';
      checkIamUgPeriode();
      checkIamUgRequired();
      iamUgDialog.style.display = '';
    }

    // Insert (POST) naar usr_grp_usr, zelfde velden/opbouw als de echte applicatie.
    iamUgSubmitBtn.addEventListener('click', function () {
      if (!iamUgGebruikersgroepId.value || !checkIamUgPeriode()) return;
      iamUgSubmitBtn.disabled = true;
      iamUgFeedback.style.display = '';
      iamUgFeedback.className = 'gb-note';
      iamUgFeedback.textContent = 'Gebruikersgroep toevoegen...';

      fetch('/api/gebruikersbeheer/toevoegen-iam/add-user-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenantId.value,
          gebruikersgroepId: iamUgGebruikersgroepId.value,
          gebruikerId: gebruikerId.value.trim(),
          beginOn: dmySegmentsToIso(iamUgBegintOpDag.value, iamUgBegintOpMaand.value, iamUgBegintOpJaar.value),
          endOn: dmySegmentsToIso(iamUgEindigtOpDag.value, iamUgEindigtOpMaand.value, iamUgEindigtOpJaar.value),
          openidProvisioned: iamUgOpenId.checked
        })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || data.status !== 'ok') {
          iamUgSubmitBtn.disabled = false;
          iamUgFeedback.className = 'gb-note error';
          iamUgFeedback.textContent = (data && data.message) || 'Toevoegen van de gebruikersgroep is mislukt.';
          return;
        }
        iamUgDialog.style.display = 'none';
        showIamAddFeedback('Gebruiker ' + gebruikerId.value.trim() + ' is aangemaakt in IAM, het wachtwoord is gezet en de gebruikersgroep is toegevoegd.', 'success');
      }).catch(function () {
        iamUgSubmitBtn.disabled = false;
        iamUgFeedback.className = 'gb-note error';
        iamUgFeedback.textContent = 'Toevoegen van de gebruikersgroep is mislukt.';
      });
    });

    const IAM_REQUIRED_FIELD_LABELS = {
      tenant: 'Tenant', gebruikerId: 'Gebruiker id (inlognaam)', voornaam: 'Voornaam',
      achternaam: 'Achternaam', email: 'E-mailadres', telefoon: 'Telefoonnummer'
    };

    function showIamAddFeedback(text, kind) {
      iamAddFeedback.textContent = text;
      iamAddFeedback.className = 'gb-note' + (kind ? ' ' + kind : '');
      iamAddFeedback.style.display = text ? '' : 'none';
    }

    iamForm.addEventListener('submit', function (event) {
      event.preventDefault();
      iamSubmitBtn.disabled = true;
      showIamAddFeedback('Tenant controleren...', '');
      tenantDefaultReady.then(function () {
        const errors = [];
        iamForm.querySelectorAll('.gb-form-invalid').forEach(function (el) { el.classList.remove('gb-form-invalid'); });
        iamForm.querySelectorAll('.gb-form-required').forEach(function (el) {
          if (!String(el.value || '').trim()) {
            el.classList.add('gb-form-invalid');
            errors.push(IAM_REQUIRED_FIELD_LABELS[el.name] || el.name);
          }
        });
        if (!checkBegintOp()) errors.push('Begint op');
        if (!checkEindigtOp()) errors.push('Eindigt op');
        if (errors.length) {
          iamSubmitBtn.disabled = false;
          showIamAddFeedback('Vul de verplichte velden in: ' + errors.join(', ') + '.', 'error');
          return;
        }

        showIamAddFeedback('Gebruiker id en e-mailadres controleren...', '');

        // checkGebruikerId()/checkIamEmail() resolve once known (starting or reusing an in-flight
        // check), so awaiting them here fixes clicking Uitvoeren before a field was ever blurred.
        Promise.all([checkGebruikerId(), checkIamEmail()]).then(function (states) {
          iamSubmitBtn.disabled = false;
          const finalLoginState = states[0];
          const finalEmailState = states[1];

          if (finalLoginState !== 'ok') {
            gebruikerId.classList.add('gb-form-invalid');
            showIamAddFeedback(finalLoginState === 'taken' ? 'Gebruiker id bestaat al in IAM.'
              : 'Controle op bestaand gebruiker id is mislukt; verlaat het veld Gebruiker id om opnieuw te controleren.', 'error');
            return;
          }
          if (finalEmailState !== 'ok') {
            iamEmail.classList.add('gb-form-invalid');
            showIamAddFeedback(finalEmailState === 'invalid' ? (iamEmailCheck.textContent || 'Ongeldig e-mailadres.')
              : 'Controle van het e-mailadres is mislukt; verlaat het veld E-mailadres om opnieuw te controleren.', 'error');
            return;
          }

          iamSubmitBtn.disabled = true;
          showIamAddFeedback('Gebruiker aanmaken...', '');

          const payload = {
            tenantId: tenantId.value,
            gebruikerId: gebruikerId.value.trim(),
            voornaam: iamVoornaam.value.trim(),
            achternaam: iamAchternaam.value.trim(),
            geslacht: document.getElementById('fIamGeslacht').value,
            email: iamEmail.value.trim(),
            telefoon: iamTelefoon.value.trim(),
            applicatieTaal: document.getElementById('fIamApplicatieTaal').value,
            inlogverificatie: inlogverificatie.value,
            terugvallenEmail: terugvallenEmail.checked,
            wachtwoordWijzigen: wachtwoordWijzigen.checked,
            wachtwoordverloopbeleid: wachtwoordverloopbeleid.value,
            configuratieId: document.getElementById('fIamConfiguratie').value,
            maxSessies: document.getElementById('fIamMaxSessies').checked,
            persoonlijkeTokens: document.getElementById('fIamPersoonlijkeTokens').checked,
            begintOp: dmySegmentsToIso(begintOpDag.value, begintOpMaandSeg.value, begintOpJaarSeg.value),
            eindigtOp: dmySegmentsToIso(eindigtOpDag.value, eindigtOpMaand.value, eindigtOpJaar.value)
          };

          fetch('/api/gebruikersbeheer/toevoegen-iam/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(function (r) { return r.json(); }).then(function (data) {
            iamSubmitBtn.disabled = false;
            if (!data || data.status !== 'ok') {
              showIamAddFeedback((data && data.message) || 'Aanmaken van de gebruiker is mislukt.', 'error');
              return;
            }
            showIamAddFeedback('Gebruiker ' + payload.gebruikerId + ' is aangemaakt in IAM.', 'success');
            iamSubmitBtn.disabled = true;
            openIamPasswordDialog();
          }).catch(function () {
            iamSubmitBtn.disabled = false;
            showIamAddFeedback('Aanmaken van de gebruiker is mislukt.', 'error');
          });
        });
      });
    });

    document.getElementById('addUserIamResetBtn').addEventListener('click', function () {
      document.getElementById('addUserIamForm').reset();
      updateLoginAvailability();
      updateWachtwoordverloopbeleidAvailability();
      checkBegintOp();
      checkEindigtOp();
      iamSubmitBtn.disabled = false;
      iamLoginState = ''; iamLoginCheckedValue = ''; iamLoginCheckPromise = null; showIamLoginCheck('', '');
      iamEmailState = ''; iamEmailCheckedValue = ''; iamEmailCheckPromise = null; showIamEmailCheck('', '');
      showIamAddFeedback('', '');

      // form.reset() leegt ook Tenant (en het verborgen tenantId-veld); default opnieuw invullen.
      tenantId.value = '';
      if (tenants) {
        const def = tenants.find(function (t) { return t.isDefault; }) || tenants[0];
        if (def) applyTenant(def);
      } else {
        tenantDefaultReady = loadTenants().then(function (list) {
          const def = list.find(function (t) { return t.isDefault; }) || list[0];
          if (def) applyTenant(def);
        }).catch(function () {});
      }
    });
  })();
`;

function renderToevoegenIamPage() {
  return renderUserOverviewPage({
    activeKey: 'toevoegen-iam',
    title: 'Gebruikers toevoegen IAM',
    subtitle: 'Maak eerst verbinding met een IAM-omgeving voordat gebruikers toegevoegd kunnen worden.',
    connectedSubtitle: 'Verbonden. Voeg gebruikers toe aan de gekozen IAM-omgeving.',
    iamOnly: true,
    connectOnly: true,
    connectedPanelHtml: renderToevoegenIamFormHtml(),
    connectedPanelStyle: TOEVOEGEN_IAM_FORM_STYLE,
    connectedPanelScript: TOEVOEGEN_IAM_FORM_SCRIPT
  });
}

// Simple credentials form (no branch/user list), shared shell with the other pages.
function renderConfiguratieIamPage() {
  return renderGbShell(
    'configuratie-iam',
    'Configuratie IAM gegevens',
    'De applicatie-URL en applicatie-ID die deze tool gebruikt om verbinding te maken met IAM.',
    renderIamConfigPanelBody(),
    IAM_CONFIG_PANEL_STYLE,
    IAM_CONFIG_PANEL_SCRIPT,
    true
  );
}

// True if featureKey is one of the Gebruikersbeheer sidebar's (nav or nested child) keys.
function isGbNavFeatureKey(featureKey) {
  return GB_NAV_ITEMS.some(function (item) {
    if (item.children) return item.children.some(function (child) { return child.key === featureKey; });
    return item.key === featureKey;
  });
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
    'toevoegen-vanuit-iam': 'Gebruikers toevoegen vanuit IAM naar omgeving',
    'deactiveren-omgeving': 'Gebruikers deactiveren omgeving',
    'deactiveren-iam': 'Gebruikers deactiveren IAM',
    'schonen-iam': 'Gebruiker schonen IAM',
    'configuratie-iam': 'Configuratie IAM gegevens'
  };
  const label = featureLabels[featureKey] || 'Deze functie';

  // Sidebar items (Gebruikersbeheer nav) stay on the same gb-shell screen (sidebar,
  // active-env badge) instead of the standalone placeholder page, matching the
  // already-built pages like Controleren gebruikers.
  if (isGbNavFeatureKey(featureKey)) {
    const body = `
      <div class="gb-panel">
        <div class="gb-panel-body">
          <p>Deze functie is nog niet ge\u00efmplementeerd.</p>
        </div>
      </div>
    `;
    return renderGbShell(featureKey, label, 'Deze functie is nog niet ge\u00efmplementeerd.', body, '', '', false);
  }

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
  // Match closeStaleWizardBrowser()'s approach (by profile dir, across all chrome/msedge
  // processes) instead of only the originally spawned PID: Chrome can relay --new-window
  // to an already-running instance, in which case the spawned PID exits immediately and
  // no longer corresponds to the actual window, so a PID-only taskkill can silently fail.
  try {
    cp.execSync(
      'powershell -NoProfile -NonInteractive -Command "$token=$env:WIZARD_PROFILE_DIR; ' +
      '$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(\'chrome.exe\',\'msedge.exe\') -and ([string]$_.CommandLine).Contains($token) }); ' +
      '$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { shell: 'cmd.exe', stdio: 'ignore', env: Object.assign({}, process.env, { WIZARD_PROFILE_DIR: wizardProfileDir }) }
    );
  } catch (_) {
    // Best effort; ignore failures.
  }
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
    disconnectEnvironment();
    stopWizardBrowser();
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 250);
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/configuratie-iam/info') {
    fetchIamInfo().then(function (info) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(Object.assign({ status: 'ok' }, info)));
    }).catch(function (err) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'error', message: String(err && err.message || 'Ophalen mislukt.') }));
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/configuratie-iam/save-app') {
    readJsonBody(req).then(function (data) {
      let applicationUrl = String(data && data.applicationUrl || '').trim().replace(/\/+$/, '');
      const applicationId = String(data && data.applicationId || '').trim();
      if (!applicationUrl || !applicationId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Applicatie URL en Applicatie ID zijn verplicht.' }));
        return;
      }
      // Guard against accidentally saving the id-appended URL (e.g. copy-pasted from
      // elsewhere), which would otherwise duplicate the id on the next lookup. If the
      // URL ends with a trailing numeric segment that does NOT match the given id,
      // that's a genuine mismatch and must be rejected instead of silently accepted.
      const trailingIdMatch = /\/(\d+)$/.exec(applicationUrl);
      if (trailingIdMatch) {
        if (trailingIdMatch[1] === applicationId) {
          applicationUrl = applicationUrl.slice(0, -(applicationId.length + 1));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'error',
            message: 'De Applicatie URL eindigt op ID ' + trailingIdMatch[1] + ', dat komt niet overeen met de opgegeven Applicatie ID ' + applicationId + '.'
          }));
          return;
        }
      }
      try {
        writeIamAppConfig({ applicationUrl: applicationUrl, applicationId: applicationId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: String(err && err.message || 'Opslaan mislukt.') }));
      }
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/configuratie-iam/save') {
    readJsonBody(req).then(function (data) {
      const authUser = String(data && data.authUser || '').trim();
      const password = String(data && data.password || '');
      if (!authUser) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Gebruikersnaam is verplicht.' }));
        return;
      }
      try {
        const values = { authUser: authUser };
        if (password) values.authUserPasswordEncrypted = encryptDpapiSecret(password);
        writeConnectionConfig(values);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: String(err && err.message || 'Opslaan mislukt.') }));
      }
    });
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
      if (isBlockedSelectionEntry({ id: branchId, alias: alias, dbName: dbName, guiApplId: guiApplId }) && !isIamEntry({ id: branchId, alias: alias, guiApplId: guiApplId })) {
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

      const probeId = branchId === IAM_SELECTION_ID ? getIamApplicationId() : branchId;
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
      res.end(JSON.stringify({ status: 'connected', alias: alias || branchId, applicationId: probeId }));
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

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/user-groups') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/company_brand_user_groups?$orderby=description&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van gebruikersgroepen is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        userGroups: parseUserRowsResponse(result).map(function (row) {
          return {
            id: String(row.user_group_id || ''),
            description: String(row.description || '').trim(),
            product: String(row.product || ''),
            customerSpecific: row.is_customer_specific === true
          };
        })
      });
    })();
    return;
  }

  // IAM-gebruikersgroepen staan in usr_grp (andere tabel dan company_brand_user_groups bij de omgeving);
  // exacte kolomnamen zijn (nog) niet bevestigd, daarom fuzzy veldherkenning via pickUserFieldValue.
  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/user-groups') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/usr_grp?$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van gebruikersgroepen is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        userGroups: parseUserRowsResponse(result).map(function (row) {
          return {
            id: pickUserFieldValue(row, ['usr_grp_id', 'user_group_id', 'id']),
            description: pickUserFieldValue(row, ['usr_grp_description', 'description_display', 'description', 'name']),
            product: pickUserFieldValue(row, ['product', 'product_description']),
            customerSpecific: findUserFieldValue(row, ['is_customer_specific', 'customer_specific']).value === 'true'
          };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/employee-functions') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/employee_function?$select=employee_function_id,employee_function_description_display&$orderby=employee_function_description_display&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van functies is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        functions: parseUserRowsResponse(result).map(function (row) {
          return { id: row.employee_function_id, name: String(row.employee_function_description_display || '') };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/employee-roles') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/employee_role?$select=employee_role_id,employee_role_description_display&$orderby=employee_role_description_display&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van rollen is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        roles: parseUserRowsResponse(result).map(function (row) {
          return { id: row.employee_role_id, name: String(row.employee_role_description_display || '') };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/administrations') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/system_administration?$select=system_administration_id,system_administration_name,is_initial_administration&$orderby=system_administration_name&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van administraties is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        administrations: parseUserRowsResponse(result).map(function (row) {
          return { id: row.system_administration_id, name: String(row.system_administration_name || ''), initial: row.is_initial_administration === true };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/departments') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const departments = await fetchEmployeeDepartments(appUrl, authHeader);
      if (!departments) { sendJson({ status: 'error', message: 'Ophalen van afdelingen is mislukt.' }); return; }
      sendJson({ status: 'ok', departments: departments });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/appl-languages') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      // appl_lang_overview: appl_lang_id = taalcode, appl_lang_description = omschrijving.
      const result = await fetchJsonFromUrl(appUrl + '/appl_lang_overview?$select=appl_lang_id,appl_lang_description&$orderby=appl_lang_description&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van applicatietalen is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        languages: parseUserRowsResponse(result).map(function (row) {
          return { id: row.appl_lang_id, name: String(row.appl_lang_description || '') };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/configuraties') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      // Exacte kolomnamen van write_back_usr_pref_type zijn (nog) niet bevestigd; daarom geen $select
      // en wordt id/naam via pickUserFieldValue (fuzzy) bepaald.
      const result = await fetchJsonFromUrl(appUrl + '/write_back_usr_pref_type?$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van configuraties is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        configuraties: parseUserRowsResponse(result).map(function (row) {
          return {
            id: pickUserFieldValue(row, ['write_back_usr_pref_type_id', 'id']),
            name: pickUserFieldValue(row, ['write_back_usr_pref_type_description', 'description_display', 'description', 'name'])
          };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/check-login') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      const loginId = String(parsed.searchParams.get('login') || '').trim();
      if (!loginId) { sendJson({ status: 'error', message: 'Geen gebruiker id opgegeven.' }); return; }
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim();
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const exists = await usrLoginIdExists(appUrl, authHeader, loginId);
      if (exists === null) { sendJson({ status: 'error', message: 'Controle op bestaand gebruiker id is mislukt.' }); return; }
      sendJson({ status: 'ok', exists: exists });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/check-email-exists') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      const email = String(parsed.searchParams.get('email') || '').trim();
      if (!email) { sendJson({ status: 'error', message: 'Geen e-mailadres opgegeven.' }); return; }
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim();
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const exists = await usrEmailExists(appUrl, authHeader, email);
      if (exists === null) { sendJson({ status: 'error', message: 'Controle op bestaand e-mailadres is mislukt.' }); return; }
      sendJson({ status: 'ok', exists: exists });
    })();
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/create-user') {
    readJsonBody(req).then(async function (data) {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }

      const d = data && typeof data === 'object' ? data : {};
      const requiredMissing = ['tenantId', 'gebruikerId', 'voornaam', 'achternaam', 'email', 'begintOp']
        .filter(function (key) { return !String(d[key] || '').trim(); });
      if (requiredMissing.length) { sendJson({ status: 'error', message: 'Verplichte velden ontbreken: ' + requiredMissing.join(', ') + '.' }); return; }

      // Codes bevestigd door de gebruiker (niet 1-op-1 uit de tabel af te leiden): gender Man=0/Vrouw=1;
      // two_factor_authentication_type Wachtwoord=0/SMS=1/email=2/TOTP token=3; password_expiration_policy
      // Geforceerd verlopen=0/Standaard beleid=1/Verloopt nooit=2 (afgeleid uit een echt aangemaakte gebruiker).
      const twoFactorMap = { wachtwoord: 0, wachtwoord_sms: 1, wachtwoord_email: 2, wachtwoord_totp: 3 };
      const expirationPolicyMap = { forced_expired: 0, standard: 1, never: 2 };
      const voornaam = String(d.voornaam || '').trim();
      const achternaam = String(d.achternaam || '').trim();
      const gebruikerId = String(d.gebruikerId || '').trim();
      const authUser = String(readConnectionConfig().authUser || '').trim();
      const nowIso = new Date().toISOString();

      const payload = {
        tenant_id: Number(d.tenantId),
        usr_id: gebruikerId,
        first_name: voornaam,
        sur_name: achternaam,
        name: voornaam + ' ' + achternaam + ' (' + gebruikerId + ')',
        gender: String(d.geslacht || '').trim() === 'vrouw' ? 1 : 0,
        email: String(d.email || '').trim(),
        phone_no: String(d.telefoon || '').trim(),
        time_zone_id: 'Etc/UTC',
        appl_lang_id: String(d.applicatieTaal || '').trim() || null,
        authentication_type: 3,
        two_factor_authentication_type: Object.prototype.hasOwnProperty.call(twoFactorMap, d.inlogverificatie) ? twoFactorMap[d.inlogverificatie] : 0,
        allow_fallback_to_email: d.terugvallenEmail === true,
        allow_change_password: d.wachtwoordWijzigen === true,
        password_expiration_policy: Object.prototype.hasOwnProperty.call(expirationPolicyMap, d.wachtwoordverloopbeleid) ? expirationPolicyMap[d.wachtwoordverloopbeleid] : 2,
        password_changed_count: 0,
        password_forgotten_count: 0,
        begin_on: String(d.begintOp || '').trim() + 'T00:00:00',
        write_back_usr_pref_type_id: String(d.configuratieId || '').trim() ? Number(d.configuratieId) : null,
        exclude_from_max_concurrent_sessions: d.maxSessies === true,
        allow_create_pat: d.persoonlijkeTokens === true
      };
      if (String(d.eindigtOp || '').trim()) payload.end_on = String(d.eindigtOp).trim() + 'T00:00:00';
      if (authUser) {
        payload.insert_user = authUser;
        payload.insert_date_time = nowIso;
        payload.update_user = authUser;
        payload.update_date_time = nowIso;
      }

      const createResult = await postJsonToUrl(appUrl + '/usr', authHeader, payload, 20000);
      if (!createResult.ok) {
        const message = friendlyTsfErrorMessage(createResult, (createResult.body && typeof createResult.body === 'object' && (createResult.body.message || createResult.body.error)) || 'Aanmaken van de gebruiker is mislukt.');
        sendJson({ status: 'error', message: String(message) });
        return;
      }
      sendJson({ status: 'ok', result: createResult.body });
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/set-password') {
    readJsonBody(req).then(async function (data) {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }

      const d = data && typeof data === 'object' ? data : {};
      const tenantId = Number(d.tenantId);
      const usrId = String(d.gebruikerId || '').trim();
      const nieuw = String(d.nieuw || '');
      const bevestig = String(d.bevestig || '');
      if (!tenantId || !usrId || !nieuw || !bevestig) { sendJson({ status: 'error', message: 'Verplichte velden ontbreken.' }); return; }
      if (nieuw !== bevestig) { sendJson({ status: 'error', message: 'Wachtwoorden komen niet overeen.' }); return; }
      const strength = Number(d.strength) || 0;
      const invalidatePat = false;

      // Stap 1: set_usr_password (zelfde input_set-XML-opbouw als de echte applicatie).
      const inputSet = '<rows>\r\n  <row>\r\n    <tenant_id>' + tenantId + '</tenant_id>\r\n    <usr_id>' + escapeHtml(usrId) + '</usr_id>\r\n'
        + '    <new_password>' + escapeHtml(nieuw) + '</new_password>\r\n    <confirm_password>' + escapeHtml(bevestig) + '</confirm_password>\r\n'
        + '    <password_strength_label>' + strength + '/5</password_strength_label>\r\n    <invalidate_pat>' + invalidatePat + '</invalidate_pat>\r\n'
        + '    <password_strength>' + strength + '</password_strength>\r\n  </row>\r\n</rows>';
      const setPasswordPayload = {
        tenant_id: tenantId,
        usr_id: usrId,
        new_password: nieuw,
        confirm_password: bevestig,
        invalidate_pat: invalidatePat,
        password_strength: strength,
        input_set: inputSet
      };
      const setPasswordResult = await postJsonToUrl(appUrl + '/set_usr_password', authHeader, setPasswordPayload, 20000);
      if (!setPasswordResult.ok) {
        const message = friendlyTsfErrorMessage(setPasswordResult, (setPasswordResult.body && typeof setPasswordResult.body === 'object' && (setPasswordResult.body.message || setPasswordResult.body.error)) || 'Wijzigen van het wachtwoord is mislukt.');
        sendJson({ status: 'error', message: String(message) });
        return;
      }

      // flow_set_usr_password_hash_password wordt door Indicium zelf (server-side, als gevolg van
      // set_usr_password / het herladen van de usr-layout) aangeroepen; de wizard hoeft dit niet
      // zelf nog eens los aan te roepen.
      sendJson({ status: 'ok' });
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/add-user-group') {
    readJsonBody(req).then(async function (data) {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }

      const d = data && typeof data === 'object' ? data : {};
      const tenantId = Number(d.tenantId);
      const usrGrpId = String(d.gebruikersgroepId || '').trim();
      const usrId = String(d.gebruikerId || '').trim();
      const beginOn = String(d.beginOn || '').trim();
      if (!tenantId || !usrGrpId || !usrId || !beginOn) { sendJson({ status: 'error', message: 'Verplichte velden ontbreken.' }); return; }
      const authUser = String(readConnectionConfig().authUser || '').trim();
      const nowIso = new Date().toISOString();

      const payload = {
        tenant_id: tenantId,
        usr_grp_id: usrGrpId,
        usr_id: usrId,
        begin_on: beginOn + 'T00:00:00',
        openid_provisioned: d.openidProvisioned === true
      };
      if (String(d.endOn || '').trim()) payload.end_on = String(d.endOn).trim() + 'T00:00:00';
      if (authUser) {
        payload.insert_user = authUser;
        payload.insert_date_time = nowIso;
        payload.update_user = authUser;
        payload.update_date_time = nowIso;
      }

      const result = await postJsonToUrl(appUrl + '/usr_grp_usr', authHeader, payload, 20000);
      if (!result.ok) {
        const message = friendlyTsfErrorMessage(result, (result.body && typeof result.body === 'object' && (result.body.message || result.body.error)) || 'Toevoegen van de gebruikersgroep is mislukt.');
        sendJson({ status: 'error', message: String(message) });
        return;
      }
      sendJson({ status: 'ok', result: result.body });
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-iam/tenants') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const result = await fetchJsonFromUrl(appUrl + '/tenant?$select=tenant_id,tenant_name,default_tenant,customer_id,technical_id&$orderby=tenant_name&$top=1000', authHeader, 15000);
      if (!result) { sendJson({ status: 'error', message: 'Ophalen van tenants is mislukt.' }); return; }
      sendJson({
        status: 'ok',
        tenants: parseUserRowsResponse(result).map(function (row) {
          return {
            id: row.tenant_id,
            name: String(row.tenant_name || ''),
            isDefault: row.default_tenant === true,
            customerId: String(row.customer_id || ''),
            technicalId: String(row.technical_id || '')
          };
        })
      });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/check-email-domain') {
    const domain = String(parsed.searchParams.get('domain') || '').trim();
    const sendJson = function (payload) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (!domain) { sendJson({ status: 'error', message: 'Geen domein opgegeven.' }); return; }
    dns.resolveMx(domain, function (mxErr, mxRecords) {
      if (!mxErr && Array.isArray(mxRecords) && mxRecords.length) { sendJson({ status: 'ok', exists: true }); return; }
      // Domains without MX can still be valid mail hosts if they resolve to an address.
      dns.lookup(domain, function (lookupErr) {
        sendJson({ status: 'ok', exists: !lookupErr });
      });
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/check-login') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      const loginName = String(parsed.searchParams.get('login') || '').trim();
      if (!loginName) { sendJson({ status: 'error', message: 'Geen gebruikersnaam opgegeven.' }); return; }
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim();
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const exists = await employeeLoginNameExists(appUrl, authHeader, loginName);
      if (exists === null) { sendJson({ status: 'error', message: 'Controle op bestaande gebruikersnaam is mislukt.' }); return; }
      sendJson({ status: 'ok', exists: exists });
    })();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/check-email-exists') {
    (async function () {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      const email = String(parsed.searchParams.get('email') || '').trim();
      if (!email) { sendJson({ status: 'error', message: 'Geen e-mailadres opgegeven.' }); return; }
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim();
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }
      const exists = await employeeEmailExists(appUrl, authHeader, email);
      if (exists === null) { sendJson({ status: 'error', message: 'Controle op bestaand e-mailadres is mislukt.' }); return; }
      sendJson({ status: 'ok', exists: exists });
    })();
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/gebruikersbeheer/toevoegen-omgeving/create-user') {
    readJsonBody(req).then(async function (data) {
      const sendJson = function (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (!isEnvironmentConnected()) { sendJson({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }); return; }
      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim().replace(/\/+$/, '');
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) { sendJson({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }); return; }

      const d = data && typeof data === 'object' ? data : {};
      const requiredMissing = ['achternaam', 'voornaam', 'gebruikersnaam', 'wachtwoord', 'wachtwoord2', 'afdelingId', 'administratieId', 'gebruikersgroepId', 'inDienst', 'email']
        .filter(function (key) { return !String(d[key] || '').trim(); });
      if (requiredMissing.length) { sendJson({ status: 'error', message: 'Verplichte velden ontbreken: ' + requiredMissing.join(', ') + '.' }); return; }
      if (d.wachtwoord !== d.wachtwoord2) { sendJson({ status: 'error', message: 'Wachtwoorden komen niet overeen.' }); return; }

      // Derive system_company_id from the chosen Afdeling (department), not a bare system_company
      // query: environments can have multiple system_company rows and $top=1 without a filter can
      // return an unrelated one, causing create_employee to fail with a generic "unknown_error".
      const departmentId = Number(d.afdelingId);
      const departmentResult = await fetchJsonFromUrl(appUrl + '/department?$filter=' + encodeURIComponent('department_id eq ' + departmentId) + '&$select=system_company_id&$top=1', authHeader, 15000);
      const departmentRows = parseUserRowsResponse(departmentResult);
      if (!departmentRows.length) { sendJson({ status: 'error', message: 'Ophalen van system_company_id (via de gekozen afdeling) is mislukt.' }); return; }

      const payload = {
        system_company_id: departmentRows[0].system_company_id,
        gender: Number(d.gender) === 1 ? 1 : 0,
        surname: String(d.achternaam || '').trim(),
        surname_prefix: String(d.tussenvoegsel || '').trim(),
        first_name: String(d.voornaam || '').trim(),
        initials: String(d.voorletters || '').trim(),
        login_name: String(d.gebruikersnaam || '').trim(),
        iam_password: String(d.wachtwoord || ''),
        iam_password_confirmation: String(d.wachtwoord2 || ''),
        department_id: Number(d.afdelingId),
        system_administration_id: Number(d.administratieId),
        user_group_id: String(d.gebruikersgroepId || '').trim(),
        phone_number: String(d.telefoon || '').trim(),
        phone_number_mobile: String(d.mobiel || '').trim(),
        e_mail_address: String(d.email || '').trim(),
        employee_plannable: d.planbaar === true,
        employment_internal_external: Number(d.internExtern) === 1 ? 1 : 0,
        start_date_of_employment: String(d.inDienst || '').trim() + 'T00:00:00',
        person_company: 0
      };
      if (String(d.functieId || '').trim()) payload.employee_function_id = Number(d.functieId);
      if (String(d.rolId || '').trim()) payload.employee_role_id = Number(d.rolId);

      const createResult = await postJsonToUrl(appUrl + '/create_employee', authHeader, payload, 20000);
      if (!createResult.ok) {
        const message = friendlyTsfErrorMessage(createResult, (createResult.body && typeof createResult.body === 'object' && (createResult.body.message || createResult.body.error)) || 'Aanmaken van de gebruiker is mislukt.');
        sendJson({ status: 'error', message: String(message) });
        return;
      }
      const created = createResult.body && typeof createResult.body === 'object' ? createResult.body : {};

      // Step 2: build the IAM linking URLs/strings for this new employee (quick_add_employee flow).
      const buildInputPayload = {
        decision_build_http_input_http_connector: 1,
        decision_build_http_input_stop: 2,
        add_or_update_iam_user_url: null,
        employee_id: created.employee_id,
        employee_login_name: created.login_name,
        find_iam_user_url: null,
        http_status_code: null,
        json_input: null,
        json_result: null,
        password: created.iam_password,
        password_algorithm: null,
        password_hash: null,
        password_salt: null,
        status_code: null,
        strange_string: null,
        system_company_id: created.system_company_id != null ? created.system_company_id : payload.system_company_id,
        username: null
      };
      const buildInputResult = await postJsonToUrl(appUrl + '/quick_add_employee_decision_build_http_input', authHeader, buildInputPayload, 20000);
      if (!buildInputResult.ok) {
        const message = friendlyTsfErrorMessage(buildInputResult, (buildInputResult.body && typeof buildInputResult.body === 'object' && (buildInputResult.body.message || buildInputResult.body.error)) || 'Gebruiker is aangemaakt, maar het opzetten van de IAM-koppeling is mislukt.');
        sendJson({ status: 'error', message: String(message), result: created });
        return;
      }
      const buildInput = buildInputResult.body && typeof buildInputResult.body === 'object' ? buildInputResult.body : {};

      // Step 2.5: the actual sync to IAM — a real HTTP call to add_or_update_iam_user_url, authenticated
      // with the one-time username/strange_string from step 2 (not our own IAM connection credentials).
      // Its resulting status code is what makes quick_add_employee_http_connector's output genuine
      // (http_status_code/status_code stay null if this call is skipped).
      let linkStatusCode = null;
      if (buildInput.add_or_update_iam_user_url && buildInput.username && buildInput.strange_string) {
        let linkBody = {};
        try { linkBody = JSON.parse(buildInput.json_input || '{}'); } catch (_) { linkBody = {}; }
        const linkAuthHeader = 'Basic ' + Buffer.from(String(buildInput.username) + ':' + String(buildInput.strange_string)).toString('base64');
        const linkResult = await postJsonToUrl(buildInput.add_or_update_iam_user_url, linkAuthHeader, linkBody, 20000);
        linkStatusCode = linkResult.status;
      }

      // Step 3: http connector task that logs/finalizes the IAM sync using the real call's status code.
      const httpConnectorPayload = Object.assign({}, buildInput, {
        http_connector_show_msg_create_iam_user_succeeded: 1,
        http_connector_stop: null,
        http_status_code: linkStatusCode,
        status_code: linkStatusCode != null && linkStatusCode >= 200 && linkStatusCode < 300 ? 0 : linkStatusCode
      });
      const httpConnectorResult = await postJsonToUrl(appUrl + '/quick_add_employee_http_connector', authHeader, httpConnectorPayload, 20000);
      if (!httpConnectorResult.ok) {
        const message = friendlyTsfErrorMessage(httpConnectorResult, (httpConnectorResult.body && typeof httpConnectorResult.body === 'object' && (httpConnectorResult.body.message || httpConnectorResult.body.error)) || 'Gebruiker is aangemaakt, maar de IAM-koppeling is mislukt.');
        sendJson({ status: 'error', message: String(message), result: created });
        return;
      }
      const httpConnector = httpConnectorResult.body && typeof httpConnectorResult.body === 'object' ? httpConnectorResult.body : {};
      if (httpConnector.http_status_code != null && (httpConnector.http_status_code < 200 || httpConnector.http_status_code >= 300)) {
        sendJson({ status: 'error', message: 'Gebruiker is aangemaakt, maar de IAM-koppeling gaf status ' + httpConnector.http_status_code + '.', result: created });
        return;
      }

      sendJson({ status: 'ok', result: created, httpConnector: httpConnector });
    });
    return;
  }

  if (req.method === 'GET' && (parsed.pathname === '/api/gebruikersbeheer/controle-omgeving/users' || parsed.pathname === '/api/gebruikersbeheer/controle-iam/users')) {
    const primaryEntityNames = parsed.pathname === '/api/gebruikersbeheer/controle-iam/users' ? ['usr'] : ['employee'];
    (async function () {
      if (!isEnvironmentConnected()) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'error', message: 'Nog niet verbonden met een omgeving.' }));
        return;
      }

      const params = readJsonSafe(FLOW_PARAMS_PATH, {});
      const appUrl = String(params.application_url || '').trim();
      const authHeader = getIamAuthHeader();
      if (!appUrl || !authHeader) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'error', message: 'Verbindingsgegevens ontbreken.' }));
        return;
      }

      try {
        const rows = await fetchEnvironmentUsers(appUrl, authHeader, primaryEntityNames);
        const users = mapUserRowsForTable(rows);
        const activeCount = users.filter(function (u) { return u.active === 1; }).length;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          status: 'ok',
          users: users,
          totalCount: users.length,
          activeCount: activeCount,
          inactiveCount: users.length - activeCount
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'error', message: String(err && err.message || 'Ophalen van gebruikers is mislukt.') }));
      }
    })();
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

  if (parsed.pathname === '/gebruikersbeheer/controle-iam') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderControleIamPage());
    return;
  }

  if (parsed.pathname === '/gebruikersbeheer/toevoegen-omgeving') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderToevoegenOmgevingPage());
    return;
  }

  if (parsed.pathname === '/gebruikersbeheer/toevoegen-iam') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderToevoegenIamPage());
    return;
  }

  if (parsed.pathname === '/gebruikersbeheer/configuratie-iam') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderConfiguratieIamPage());
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
