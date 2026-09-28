'use strict';

// Prompts for the IAM password (input hidden) and stores it DPAPI-encrypted in
// connection.json, so the real password is never written to disk in plain text.
// Usage: node "Database Onderhoud/scripts/set-connection-password.cjs"

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const CONNECTION_CONFIG_PATH = path.resolve(__dirname, '..', 'params', 'connection.json');

function promptHidden(question) {
  return new Promise(function (resolve) {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    function onData(char) {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '\u0003') process.exit(1);
      if (char === '\u007f') { input = input.slice(0, -1); return; }
      input += char;
    }
    stdin.on('data', onData);
  });
}

function encryptWithDpapi(plainText) {
  const result = cp.spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$plain = [Console]::In.ReadLine(); ' +
    '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force; ' +
    'ConvertFrom-SecureString -SecureString $secure'
  ], { input: plainText + '\n', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'DPAPI-encryptie mislukt.');
  return result.stdout.trim();
}

async function main() {
  const password = await promptHidden('Wachtwoord voor authUser (invoer wordt niet getoond): ');
  if (!password) {
    console.error('Geen wachtwoord opgegeven.');
    process.exitCode = 1;
    return;
  }

  const encrypted = encryptWithDpapi(password);
  const current = fs.existsSync(CONNECTION_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONNECTION_CONFIG_PATH, 'utf8') || '{}')
    : {};
  delete current.authUserPassword;
  current.authUserPasswordEncrypted = encrypted;

  fs.mkdirSync(path.dirname(CONNECTION_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONNECTION_CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log('Wachtwoord versleuteld opgeslagen in ' + CONNECTION_CONFIG_PATH);
}

main().catch(function (err) {
  console.error(err && err.message || err);
  process.exitCode = 1;
});
