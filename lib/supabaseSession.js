// lib/supabaseSession.js  ← place this in your Nexus bot's lib/ folder
//
// What this does:
//   loadSession()            — downloads session from Supabase/pair server,
//                              falls back to full interactive auth menu if nothing found
//   makeSupabaseSaveCreds()  — wraps saveCreds to also push updates to Supabase
//   deleteSession()          — cleans up Supabase row + local file on logout

'use strict';

const { createClient } = require('@supabase/supabase-js');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const readline = require('readline');
const config   = require('../config');

// ── Supabase client ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
        '❌ SUPABASE_URL and SUPABASE_KEY must be set in your config.env\n' +
        '   Get them from: Supabase Dashboard → Project Settings → API'
    );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SESSION_DIR = path.join(__dirname, '../session');
const CREDS_PATH  = path.join(SESSION_DIR, 'creds.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
}

function askQuestion(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

// Extract the raw ID from PLATINUM*V2=<id>
function getStorageKey() {
    const raw = process.env.SESSION_ID || config.SESSION_ID || '';
    if (raw.startsWith('PLATINUM*V2=')) return raw.replace('PLATINUM*V2=', '').trim();
    return raw.trim() || 'default';
}

// ── loadSession ──────────────────────────────────────────────────────────────
// Priority order:
//   1. Local creds.json already exists          → use it (fast path, no download)
//   2. SESSION_ID set in env                    → download from pair server
//   3. Nothing found                            → show interactive auth menu
//      Menu options:
//        1. Enter Session ID manually
//        2. Enter Phone Number (pairing code via Baileys)
//        3. Scan QR Code
async function loadSession() {
    ensureSessionDir();

    // ── 1. Fast path: local creds already present ────────────────────────────
    if (fs.existsSync(CREDS_PATH)) {
        console.log('✅ Local session found — skipping download.');
        return;
    }

    // ── 2. SESSION_ID set — try downloading from pair server ─────────────────
    if (config.SESSION_ID && config.SESSION_ID.startsWith('PLATINUM*V2=')) {
        try {
            const idv = config.SESSION_ID.replace('PLATINUM*V2=', '');
            console.log('🔄 Fetching session from server...');
            const { data } = await axios.get(
                `${config.PAIR_SERVER_URL}/download/${idv}`
            );
            fs.writeFileSync(CREDS_PATH, JSON.stringify(data, null, 2), 'utf8');
            console.log('✅ Session loaded successfully.');
            return;
        } catch (err) {
            console.error('❌ Failed to load session from SESSION_ID:', err.message);
            console.log('⚠️  Falling back to interactive auth menu...\n');
        }
    }

    // ── 3. No session found — show interactive auth menu ─────────────────────
    console.log('\x1b[33m┌──────────────────────────────────────┐');
    console.log('│       Choose Authentication Method    │');
    console.log('├──────────────────────────────────────┤');
    console.log('│  1. Enter Session ID                  │');
    console.log('│  2. Enter Phone Number (Pairing Code) │');
    console.log('│  3. Scan QR Code                      │');
    console.log('└──────────────────────────────────────┘\x1b[0m');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let choice = '';
    while (!['1', '2', '3'].includes(choice)) {
        choice = (await askQuestion(rl, '\nYour choice (1, 2, or 3): ')).trim();
        if (!['1', '2', '3'].includes(choice)) console.log('❌ Invalid choice. Enter 1, 2, or 3.');
    }

    if (choice === '1') {
        // ── Session ID flow ──────────────────────────────────────────────────
        let sessionId = '';
        while (!sessionId.startsWith('PLATINUM*V2=')) {
            sessionId = (await askQuestion(rl, 'Enter your Session ID (starts with PLATINUM*V2=): ')).trim();
            if (!sessionId.startsWith('PLATINUM*V2=')) console.log('❌ Invalid. Must start with PLATINUM*V2=');
        }
        rl.close();
        try {
            const idv = sessionId.replace('PLATINUM*V2=', '');
            console.log('🔄 Downloading session...');
            const { data } = await axios.get(
                `${config.PAIR_SERVER_URL}/download/${idv}`
            );
            fs.writeFileSync(CREDS_PATH, JSON.stringify(data, null, 2), 'utf8');
            config.SESSION_ID = sessionId;
            console.log('✅ Session saved! Bot will now connect.');
        } catch (err) {
            console.error('❌ Failed to download session:', err.message);
            process.exit(1);
        }

    } else if (choice === '2') {
        // ── Phone number pairing flow ────────────────────────────────────────
        let phoneNum = '';
        while (!phoneNum.match(/^\d{7,15}$/)) {
            phoneNum = (await askQuestion(
                rl,
                'Enter phone number with country code (digits only, e.g. 2348012345678): '
            )).trim().replace(/\D/g, '');
            if (!phoneNum.match(/^\d{7,15}$/)) console.log('❌ Invalid number. Digits only, 7–15 chars.');
        }
        rl.close();
        // Store for use in connectToWA after socket opens
        process.env._PAIRING_NUMBER = phoneNum;
        console.log(`📱 Will request pairing code for +${phoneNum} after connecting...`);

    } else {
        // ── QR flow ──────────────────────────────────────────────────────────
        rl.close();
        console.log('📷 QR Code will appear below. Scan with WhatsApp > Linked Devices > Add Device.');
    }
}

// ── makeSupabaseSaveCreds ────────────────────────────────────────────────────
// Wraps Baileys' saveCreds so every creds update is also pushed to Supabase.
// This keeps Supabase always in sync so restarts always get fresh creds.
function makeSupabaseSaveCreds(originalSaveCreds) {
    const key = getStorageKey();

    return async function saveCredsWithSupabase() {
        // 1. Save locally first (Baileys requires this)
        await originalSaveCreds();

        // 2. Push to Supabase in background — non-blocking so it never
        //    slows down message handling
        setImmediate(async () => {
            try {
                if (!fs.existsSync(CREDS_PATH)) return;

                const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));

                const { error } = await supabase
                    .from('sessions')
                    .upsert(
                        { session_id: key, creds, updated_at: new Date().toISOString() },
                        { onConflict: 'session_id' }
                    );

                if (error) console.error('❌ Supabase saveCreds error:', error.message);
            } catch (err) {
                console.error('❌ Supabase saveCreds exception:', err.message);
            }
        });
    };
}

// ── deleteSession ────────────────────────────────────────────────────────────
// Call on logout so the dead session is cleaned up from Supabase too.
async function deleteSession() {
    const key = getStorageKey();
    if (!key || key === 'default') return;

    try {
        await supabase.from('sessions').delete().eq('session_id', key);
        console.log('🗑️  Session removed from Supabase.');
    } catch (err) {
        console.error('❌ Failed to delete session from Supabase:', err.message);
    }

    // Wipe local file too
    try { if (fs.existsSync(CREDS_PATH)) fs.unlinkSync(CREDS_PATH); } catch {}
}

module.exports = { loadSession, makeSupabaseSaveCreds, deleteSession };
