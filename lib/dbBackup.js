// lib/dbBackup.js — Supabase Storage backup for nexus.db
// Backs up the SQLite database to Supabase Storage so data
// (warnings, group settings, mode, greetings etc) survives Render redeploys.
//
// How it works:
//   - On startup     → restores nexus.db from Supabase if local file is missing
//   - Every 30 min   → uploads nexus.db to Supabase Storage silently
//   - On shutdown    → uploads one final backup before process exits

'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET       = 'nexus-backups';        // Storage bucket name
const FILE_NAME    = 'nexus.db';             // File name inside bucket

const DB_PATH = process.env.DATABASE_URL?.startsWith('./') || process.env.DATABASE_URL?.startsWith('/')
  ? path.resolve(process.cwd(), process.env.DATABASE_URL.replace(/^\.\//, ''))
  : path.resolve(process.cwd(), 'data', 'nexus.db');

// ── Safety guard: if Supabase isn't configured just skip silently ─────────────
function getClient() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── Upload nexus.db → Supabase Storage ───────────────────────────────────────
async function uploadDB() {
    const supabase = getClient();
    if (!supabase) return;
    try {
        if (!fs.existsSync(DB_PATH)) return;
        const fileBuffer = fs.readFileSync(DB_PATH);
        const { error } = await supabase.storage
            .from(BUCKET)
            .upload(FILE_NAME, fileBuffer, {
                contentType: 'application/octet-stream',
                upsert: true,
            });
        if (error) {
            console.error('❌ DB backup upload error:', error.message);
        } else {
            console.log('☁️  DB backed up to Supabase Storage.');
        }
    } catch (err) {
        console.error('❌ DB backup exception:', err.message);
    }
}

// ── Download nexus.db ← Supabase Storage ─────────────────────────────────────
async function downloadDB() {
    const supabase = getClient();
    if (!supabase) return false;
    try {
        const { data, error } = await supabase.storage
            .from(BUCKET)
            .download(FILE_NAME);
        if (error) {
            // No backup exists yet — that's fine on first deploy
            if (error.message?.includes('not found') || error.message?.includes('Object not found')) {
                console.log('ℹ️  No DB backup found in Supabase — starting fresh.');
            } else {
                console.error('❌ DB restore error:', error.message);
            }
            return false;
        }
        // Write to disk
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        const arrayBuffer = await data.arrayBuffer();
        fs.writeFileSync(DB_PATH, Buffer.from(arrayBuffer));
        console.log('✅ DB restored from Supabase Storage.');
        return true;
    } catch (err) {
        console.error('❌ DB restore exception:', err.message);
        return false;
    }
}

// ── restoreDB: call this on startup BEFORE botdb.js initializes ───────────────
// Only restores if local DB is missing (i.e. after a redeploy wipe)
async function restoreDB() {
    if (fs.existsSync(DB_PATH)) {
        console.log('✅ Local DB found — skipping restore.');
        return;
    }
    console.log('🔄 Local DB missing — restoring from Supabase...');
    await downloadDB();
}

// ── startBackupSchedule: call this after bot is connected ────────────────────
// Backs up every 30 minutes and registers shutdown hooks
function startBackupSchedule() {
    if (!getClient()) {
        console.log('⚠️  Supabase not configured — DB backup disabled.');
        return;
    }

    // Periodic backup every 30 minutes
    setInterval(async () => {
        await uploadDB();
    }, 30 * 60 * 1000);

    // Backup on clean shutdown (SIGTERM = Render redeploy signal)
    process.once('SIGTERM', async () => {
        console.log('🛑 SIGTERM received — backing up DB before shutdown...');
        await uploadDB();
        process.exit(0);
    });

    // Backup on SIGINT (Ctrl+C / manual stop)
    process.once('SIGINT', async () => {
        console.log('🛑 SIGINT received — backing up DB before shutdown...');
        await uploadDB();
        process.exit(0);
    });

    console.log('🗄️  DB backup schedule started (every 30 min + on shutdown).');
}

module.exports = { restoreDB, startBackupSchedule, uploadDB };
