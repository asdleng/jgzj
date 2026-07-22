#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const KEY_PATH = process.env.RELOCALIZATION_VIN_HMAC_KEY_PATH ||
  '/home/admin1/.config/cloud-agent/relocalization_vin_hmac_key';
const REGISTRY_PATH = process.env.RELOCALIZATION_VEHICLE_TOKEN_REGISTRY_PATH ||
  '/home/admin1/.config/cloud-agent/relocalization_vehicle_tokens.json';
const LEGACY_TOKEN_PATH = process.env.RELOCALIZATION_LEGACY_TOKEN_PATH ||
  '/home/admin1/.config/cloud-agent/relocalization_token';
const INVENTORY_URL = process.env.CLOUD_AGENT_VEHICLE_INVENTORY_URL ||
  'http://127.0.0.1:8000/api/vehicles';
const VEHICLE_RE = /^(?:BIT-\d{4}|FTUGV-\d{3})$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function ensurePrivateParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
}

function ensureKey() {
  ensurePrivateParent(KEY_PATH);
  try {
    fs.writeFileSync(KEY_PATH, crypto.randomBytes(32).toString('hex'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  fs.chmodSync(KEY_PATH, 0o600);
  const raw = fs.readFileSync(KEY_PATH, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error('invalid HMAC key');
  return Buffer.from(raw, 'hex');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 5000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`inventory HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('inventory timeout')));
    request.on('error', reject);
  });
}

function canonicalVin(value) {
  const vin = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{8,128}$/.test(vin)) throw new Error('invalid or missing VIN');
  return vin;
}

function deriveToken(key, vehicleId, vin) {
  const digest = crypto
    .createHmac('sha256', key)
    .update(`${vehicleId}\0${canonicalVin(vin)}`, 'utf8')
    .digest('base64url');
  return `vin1.${digest}`;
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function vehicleRecords() {
  const payload = await fetchJson(INVENTORY_URL);
  const records = new Map();
  for (const item of payload.vehicles || []) {
    const vehicleId = String(item.vehicle_id || '').trim();
    if (VEHICLE_RE.test(vehicleId) && !records.has(vehicleId)) records.set(vehicleId, item);
  }
  return records;
}

function privateAtomicWrite(filePath, payload) {
  ensurePrivateParent(filePath);
  const temporary = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

async function buildRegistry(vehicleIds) {
  const key = ensureKey();
  const records = await vehicleRecords();
  const tokens = [];
  for (const vehicleId of vehicleIds) {
    if (!VEHICLE_RE.test(vehicleId)) throw new Error(`invalid vehicle ID: ${vehicleId}`);
    const record = records.get(vehicleId);
    if (!record) throw new Error(`vehicle is not connected: ${vehicleId}`);
    const vin = canonicalVin(record.vin);
    const token = deriveToken(key, vehicleId, vin);
    tokens.push({
      vehicle_id: vehicleId,
      token_sha256: tokenDigest(token),
      source: 'vin_hmac_sha256_v1',
      vin_sha256: tokenDigest(vin)
    });
  }

  if (fs.existsSync(LEGACY_TOKEN_PATH)) {
    const legacyToken = fs.readFileSync(LEGACY_TOKEN_PATH, 'utf8').trim();
    if (legacyToken) {
      tokens.push({
        vehicle_id: 'BIT-0046',
        token_sha256: tokenDigest(legacyToken),
        source: 'legacy_bound'
      });
    }
  }

  tokens.sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id));
  const vehicleSet = new Set(tokens.map((entry) => entry.vehicle_id));
  if (vehicleSet.size !== tokens.length) throw new Error('duplicate vehicle registry entry');
  privateAtomicWrite(REGISTRY_PATH, `${JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    tokens
  }, null, 2)}\n`);
  process.stdout.write(`${tokens.map((entry) => entry.vehicle_id).join('\n')}\n`);
}

async function issue(vehicleId) {
  if (!VEHICLE_RE.test(vehicleId)) throw new Error('invalid vehicle ID');
  const key = ensureKey();
  const records = await vehicleRecords();
  const record = records.get(vehicleId);
  if (!record) throw new Error(`vehicle is not connected: ${vehicleId}`);
  process.stdout.write(deriveToken(key, vehicleId, canonicalVin(record.vin)));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build-registry' && args.length > 0) {
    await buildRegistry(args);
    return;
  }
  if (command === 'issue' && args.length === 1) {
    await issue(args[0]);
    return;
  }
  fail('usage: relocalization_vin_token_admin.js build-registry VEHICLE... | issue VEHICLE');
}

main().catch((error) => fail(error.message || String(error)));
