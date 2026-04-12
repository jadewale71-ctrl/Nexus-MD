// lib/dbBackup.js — Supabase Storage backup for nexus.db
// Each deployment gets its OWN folder in the bucket based on SESSION_ID,
// so multiple bots sharing the same Supabase project never mix up data.
//
// File path in bucket: nexus-backups/<deploymentId>/nexus.db

'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET       = 'nexus-backups';

const DB_PATH = process.env.DATABASE_URL?.startsWith('./') || process.env.DATABASE_URL?.startsWith('/')
  ? path.resolve(process.cwd(), process.env.DATABASE_URL.replace(/^\.\//, ''))
  : path.resolve(process.cwd(), 'data', 'nexus.db');

// ── Unique deployment ID ──────────────────────────────────────────────────────
// Derived from SESSION_ID so each bot instance has its own folder in the bucket.
// e.g. SESSION_ID = "PLATINUM*V2=abc123" → folder = "abc123"
// Fallback: BOT_NAME + OWNER_NUMBER combo
function getDeploymentId() {
  const sessionId = process.env.SESSION_ID || '';
  if (sessionId.includes('=')) {
    const id = sessionId.split('=').pop().trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (id.length > 4) return id;
  }
  const raw = `${process.env.BOT_NAME || 'nexus'}__${process.env.OWNER_NUMBER || 'unknown'}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

let _deploymentId = null;
function deploymentId() {
  if (!_deploymentId) _deploymentId = getDeploymentId();
  return _deploymentId;
}

function bucketPath() { return `${deploymentId()}/nexus.db`; }

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function uploadDB() {
  const supabase = getClient();
  if (!supabase) return;
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const fileBuffer = fs.readFileSync(DB_PATH);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(bucketPath(), fileBuffer, { contentType: 'application/octet-stream', upsert: true });
    if (error) console.error('[NEXUS-MD] DB backup error:', error.message);
    else console.log(`[NEXUS-MD] DB backed up → ${bucketPath()}`);
  } catch (err) {
    console.error('[NEXUS-MD] DB backup exception:', err.message);
  }
}

async function downloadDB() {
  const supabase = getClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(bucketPath());
    if (error) {
      if (error.message?.includes('not found') || error.message?.includes('Object not found')) {
        console.log(`[NEXUS-MD] No backup found for deployment (${deploymentId()}) — starting fresh.`);
      } else {
        console.error('[NEXUS-MD] DB restore error:', error.message);
      }
      return false;
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(await data.arrayBuffer()));
    console.log(`[NEXUS-MD] DB restored from Supabase (${deploymentId()}).`);
    return true;
  } catch (err) {
    console.error('[NEXUS-MD] DB restore exception:', err.message);
    return false;
  }
}

async function restoreDB() {
  if (fs.existsSync(DB_PATH)) {
    console.log('[NEXUS-MD] Local DB found — skipping restore.');
    return;
  }
  console.log(`[NEXUS-MD] Restoring DB from Supabase (id: ${deploymentId()})...`);
  await downloadDB();
}

function startBackupSchedule() {
  if (!getClient()) {
    console.log('[NEXUS-MD] Supabase not configured — DB backup disabled.');
    return;
  }
  // Upload 1 minute after start so bucket has data right away
  setTimeout(() => uploadDB(), 60 * 1000);
  // Then every 30 minutes
  setInterval(() => uploadDB(), 30 * 60 * 1000);

  process.once('SIGTERM', async () => {
    console.log('[NEXUS-MD] SIGTERM — backing up DB...');
    await uploadDB();
    process.exit(0);
  });
  process.once('SIGINT', async () => {
    console.log('[NEXUS-MD] SIGINT — backing up DB...');
    await uploadDB();
    process.exit(0);
  });
  console.log(`[NEXUS-MD] DB backup active — id: ${deploymentId()}`);
}

module.exports = { restoreDB, startBackupSchedule, uploadDB };
