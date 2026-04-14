// plugins/economy.js
// Enhanced Economy & Underworld Plugin for Platinum-V2 — Weirdos World
// FULLY INTEGRATED WITH RPG ECOSYSTEM (`rpgplayers` collection)
// v4.0 — Location-locked Rob, Gear-based Stats, Gang Rob, Economy Drains Toggle

const { cast, makeSmartQuote } = require('../cast');
const { MongoClient } = require("mongodb");
const { lidToPhone } = require("../lib/lid");

const uri = process.env.MONGO_URI || "mongodb+srv://anthonycampbell736_db_user:R9eP6aJQssTrz6DW@nexus-md.zoatrff.mongodb.net/?appName=Nexus-MD";
const client = new MongoClient(uri, {});

let _db;
async function connectDB() {
  if (!_db) {
    await client.connect();
    _db = client.db("test");
  }
  return _db;
}

function now(){ return Date.now(); }
function msToTime(ms){
  if (ms <= 0) return "0s";
  const s = Math.floor((ms/1000)%60), m = Math.floor((ms/60000)%60), h = Math.floor(ms/3600000);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// ----------------- Global ID Resolution -----------------
function normalizeId(jidOrDigits) {
    if (!jidOrDigits) return null;
    let s = String(jidOrDigits).split(':')[0].split('@')[0];
    return s.replace(/\D/g, '');
}

async function getPlayerId(conn, jid) {
    if (!jid) return null;
    let str = String(jid);
    if (str.includes('@lid')) {
        try {
            let pn = await lidToPhone(conn, str);
            if (pn) return normalizeId(pn);
        } catch(e) {}
    }
    return normalizeId(str);
}

async function getTargetId(conn, mek, args, argIndex = 0) {
    let targetId = null;
    if (mek.message?.extendedTextMessage?.contextInfo?.participant) {
        targetId = mek.message.extendedTextMessage.contextInfo.participant;
    } else if (mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
        targetId = mek.message.extendedTextMessage.contextInfo.mentionedJid[0];
    } else if (args && args[argIndex]) {
        targetId = args[argIndex].replace(/[^0-9@lid]/g, '');
    }
    return await getPlayerId(conn, targetId);
}

function toJid(id) { return id.includes('@') ? id : `${id}@s.whatsapp.net`; }

// ----------------- Unified DB Helpers -----------------
async function getAccount(id) {
  const db = await connectDB();
  const coll = db.collection("weirdo_rpg");
  let acc = await coll.findOne({ _id: id });

  if (!acc) {
    acc = {
        _id: id,
        money: 100,
        bank: 0,
        health: 100, maxHealth: 100,
        energy: 100, maxEnergy: 100,
        strength: 3, defense: 3, speed: 3, dexterity: 3,
        level: 1, exp: 0,
        inventory: {}, properties: {}, titles: [],
        investments: [],
        jailedUntil: 0,
        crimeLevel: 0,
        lastCrimeLevelDecay: Date.now(),
        kidnappedBy: null,
        activeDrugs: [],
        createdAt: new Date()
    };
    await coll.insertOne(acc);
  }

  // Ensure missing economy fields on old accounts
  if (typeof acc.bank !== 'number') acc.bank = 0;
  if (!acc.investments) acc.investments = [];
  if (!acc.inventory) acc.inventory = {};
  if (!acc.properties) acc.properties = {};
  if (typeof acc.crimeLevel !== 'number') acc.crimeLevel = 0;
  if (!acc.lastCrimeLevelDecay) acc.lastCrimeLevelDecay = Date.now();
  if (acc.kidnappedBy === undefined) acc.kidnappedBy = null;
  if (!acc.tycoon) acc.tycoon = {};
  if (!acc.swordStreak) acc.swordStreak = 0;

  // Pet hunger — if not fed in 36h, pet runs away
  if (acc.pet?.type) {
      const hoursSinceFed = (Date.now() - (acc.pet.lastFed || 0)) / 3600000;
      if (hoursSinceFed > 36) {
          const gone = acc.pet.type;
          acc.pet = null;
          // Note: conn not available here, just wipe silently. User sees it on next pet status.
      }
  }

  // Rental eviction
  if (acc.rentedHome && acc.rentedHomeExpiresAt > 0 && acc.rentedHomeExpiresAt <= Date.now()) {
      acc.rentedHome = null;
      acc.rentedHomeExpiresAt = 0;
  }

  // Gear insurance expiry
  if (acc.gearInsurance && acc.gearInsuranceExpiresAt > 0 && acc.gearInsuranceExpiresAt <= Date.now()) {
      acc.gearInsurance = false;
      acc.gearInsuranceExpiresAt = 0;
  }

  // Medical bill on auto-discharge
  if (acc.jailedUntil && acc.jailedUntil > 0 && acc.jailedUntil <= Date.now()) {
      acc.jailedUntil = 0; acc.inJail = false;
      if (acc.health <= 0) acc.health = 20;
      const bill = iC(500) * (acc.level || 1);
      if (bill > 0) { acc.money = Math.max(MIN_WALLET, (acc.money || 0) - bill); logFinancial(acc, `Hospital discharge fee`, -bill); }
  }

  // Passive crimeLevel decay: -5 per hour
  const hoursSinceDecay = (Date.now() - (acc.lastCrimeLevelDecay || 0)) / 3600000;
  if (hoursSinceDecay >= 1) {
      const ticks = Math.floor(hoursSinceDecay);
      acc.crimeLevel = Math.max(0, (acc.crimeLevel || 0) - (5 * ticks));
      acc.lastCrimeLevelDecay = Date.now();
  }

  // Hourly economy drains
  await applyHourlyDrains(acc);

  // Loan shark — HOURLY compounding (not per-5-min — that was way too aggressive)
  if (acc.activeLoan && acc.activeLoan.owed > 0) {
      const HOURLY_INTERVAL = 60 * 60 * 1000; // 1 hour
      const GRACE_PERIOD    = 2 * 60 * 60 * 1000; // 2hr grace — no interest
      const loanAge = Date.now() - (acc.activeLoan.takenAt || 0);

      if (loanAge > GRACE_PERIOD) {
          // Credit score determines interest rate:
          // 750+  → 0.5%/hr  | 680+ → 0.8%/hr | 580+ → 1%/hr | 480+ → 1.2%/hr | <480 → 1.5%/hr
          const _s = acc.activeLoan.creditScore || 580;
          const RATE_PER_HOUR = _s >= 750 ? 0.005 : _s >= 680 ? 0.008 : _s >= 580 ? 0.010 : _s >= 480 ? 0.012 : 0.015;

          const lastComp  = acc.activeLoan.lastCompound || (acc.activeLoan.takenAt + GRACE_PERIOD);
          const intervals = Math.floor((Date.now() - lastComp) / HOURLY_INTERVAL);
          if (intervals > 0) {
              let owed = acc.activeLoan.owed;
              for (let i = 0; i < intervals; i++) owed = Math.ceil(owed * (1 + RATE_PER_HOUR));
              acc.activeLoan.owed         = owed;
              acc.activeLoan.lastCompound = lastComp + intervals * HOURLY_INTERVAL;
          }

          // Auto-deduct after 6 hours overdue — shark takes 20% of wallet+bank
          // (was 2hr, now 6hr — players need time to respond)
          if (loanAge >= 6 * 60 * 60 * 1000 && (acc.money > 0 || acc.bank > 0)) {
              const lastAutoDeduct = acc.activeLoan.lastAutoDeduct || 0;
              if (Date.now() - lastAutoDeduct >= 6 * 60 * 60 * 1000) { // once per 6hr max
                  const targetPay  = Math.ceil(acc.activeLoan.owed * 0.20);
                  const fromWallet = Math.min(Math.max(0, acc.money || 0), targetPay);
                  acc.money        = Math.max(MIN_WALLET, (acc.money || 0) - fromWallet);
                  const fromBank   = Math.min(acc.bank || 0, targetPay - fromWallet);
                  acc.bank         = Math.max(0, (acc.bank || 0) - fromBank);
                  const forcePay   = fromWallet + fromBank;
                  if (forcePay > 0) {
                      acc.activeLoan.owed        -= forcePay;
                      acc.activeLoan.lastAutoDeduct = Date.now();
                      logFinancial(acc, `🦈 Shark auto-collected (6hr overdue)`, -forcePay);
                  }
                  if (acc.activeLoan.owed <= 0) acc.activeLoan = null;
              }
          }
      }
  }

  // Rob immunity expiry
  if (acc.robImmunityUntil && acc.robImmunityUntil <= Date.now()) {
      acc.robImmunityUntil = 0;
  }

  // Extortion auto-collection — if this player has an active extortion demand, pay it now
  if (global.extortions && global.extortions[acc._id]) {
      const ext = global.extortions[acc._id];
      if (ext.expiresAt > Date.now()) {
          const pay = Math.min(acc.money || 0, ext.amount);
          if (pay > 0) {
              acc.money -= pay;
              logFinancial(acc, `Extortion payment to @${ext.extorterId}`, -pay);
              // Pay the extorter
              try {
                  const db = await connectDB();
                  await db.collection('rpgplayers').updateOne({ _id: ext.extorterId }, { $inc: { money: pay } });
              } catch(_) {}
          }
          delete global.extortions[acc._id];
      } else {
          delete global.extortions[acc._id];
      }
  }

  return acc;
}

async function saveAccount(acc) {
  const db = await connectDB();
  await db.collection("weirdo_rpg").updateOne({ _id: acc._id }, { $set: acc }, { upsert: true });
}

function isHospitalized(acc) {
    return (acc.jailedUntil && acc.jailedUntil > now()) || acc.health <= 0;
}

function isKidnapped(acc) {
    return acc.kidnappedBy && acc.kidnappedBy !== null;
}

function isInFlight(acc) {
    return acc.travelingUntil && acc.travelingUntil > now();
}

function logFinancial(acc, description, amount) {
    const d = new Date();
    const timeStr = `${d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' })} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    const sign = amount >= 0 ? `+${fmtMoney(amount)}` : `-${fmtMoney(Math.abs(amount))}`;
    acc.financialHistory = acc.financialHistory || [];
    acc.financialHistory.push(`[${timeStr}] ${sign} — ${description}`);
    if (acc.financialHistory.length > 100) acc.financialHistory.shift();
}

function crimeLevelBar(lvl) {
    const l = lvl || 0;
    if (l === 0) return `⚪ 0/100 (Clean)`;
    if (l < 25) return `🟢 ${l}/100 (Cool)`;
    if (l < 50) return `🟡 ${l}/100 (Noticed)`;
    if (l < 75) return `🟠 ${l}/100 (Wanted)`;
    return `🔴 ${l}/100 (HOT — Liable to arrest!)`;
}

async function addExp(acc, amount){
  acc.exp = (acc.exp || 0) + (amount || 0);
  let leveled = false;
  while (acc.exp >= (acc.level * 100)) {
    acc.exp -= (acc.level * 100);
    acc.level += 1;
    acc.maxHealth += 10;
    acc.health = acc.maxHealth;
    acc.maxEnergy += 5;
    acc.energy = acc.maxEnergy;
    acc.money += 250 * acc.level; logFinancial(acc, `⭐ Level up bonus (Level ${acc.level})`, 250 * acc.level);
    leveled = true;
  }
  await saveAccount(acc);
  return leveled;
}

function fmtMoney(x) { return `$${Number(x).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }

const VAT_RATE_BASE = 0.12;
const MIN_WALLET = -500000; // wallet floor for negative balance
const MAX_WALLET = 999_000_000_000; // $999B hard cap
const MAX_BANK   = 999_000_000_000;
function capBalance(n){ return Math.min(n, MAX_WALLET); }

function applyVAT(gross) {
    if (!global.weirdo_tax_enabled) return { net: gross, vat: 0 };
    const presDiscount = (global.wwPresident && global.wwPresident.termEndsAt > Date.now()) ? 0.02 : 0;
    const rate = Math.max(0, VAT_RATE_BASE - presDiscount);
    const vat  = Math.ceil(gross * rate);
    return { net: gross - vat, vat };
}

// ─── GLOBAL FLAGS — safe defaults before DB config loads ────────────────────
if (global.weirdo_drains_enabled === undefined) global.weirdo_drains_enabled = true;
if (global.weirdo_tax_enabled    === undefined) global.weirdo_tax_enabled    = true;
if (global.wealth_drain_enabled  === undefined) global.wealth_drain_enabled  = true;
if (global.INFLATION_MULT        === undefined) global.INFLATION_MULT        = 1;

// Load toggles from DB on startup (runs once, overwrites defaults above)
(async () => {
    try {
        const db  = await connectDB();
        const cfg = await db.collection('weirdo_config').findOne({ _id: 'game_config' });
        if (cfg) {
            if (cfg.drainsEnabled    !== undefined) global.weirdo_drains_enabled = cfg.drainsEnabled;
            if (cfg.wealthDrainEnabled !== undefined) global.wealth_drain_enabled = cfg.wealthDrainEnabled;
            if (cfg.taxEnabled       !== undefined) global.weirdo_tax_enabled    = cfg.taxEnabled;
            if (cfg.inflationMult    !== undefined) global.INFLATION_MULT        = cfg.inflationMult;
            console.log(`✅ economy.js config loaded — drains:${global.weirdo_drains_enabled} tax:${global.weirdo_tax_enabled} inflation:x${global.INFLATION_MULT}`);
        }
    } catch(e) { console.error('economy.js config load error:', e.message); }
})();

// Scale any cost by current inflation
function iC(base) { return Math.ceil(base * global.INFLATION_MULT); }

// Tax income tracker — only active when tax is enabled
function addTaxableIncome(acc, amount) {
    if (!amount || amount <= 0) return;
    if (!global.weirdo_tax_enabled) return;
    acc.taxableIncome = (acc.taxableIncome || 0) + amount;
}

// Location normaliser — same as torn.js, keeps legacy "Torn City" compatible
const LOC_ALIASES_ECO = { 'torn city':'Weirdos World','torn':'Weirdos World','torncity':'Weirdos World','weirdosworld':'Weirdos World','home':'Weirdos World','ww':'Weirdos World','weirdos world':'Weirdos World','mexico':'Mexico','london':'London','japan':'Japan','switzerland':'Switzerland','swiss':'Switzerland' };
function normLoc(loc) { if (!loc) return 'Weirdos World'; const k = loc.trim().toLowerCase(); return LOC_ALIASES_ECO[k] || loc.trim(); }

// Persist drain/inflation config to DB (same collection as torn.js GameConfig)
async function saveGameConfig() {
    try {
        const db = await connectDB();
        await db.collection('weirdo_config').updateOne(
            { _id: 'game_config' },
            { $set: { inflationMult: global.INFLATION_MULT, drainsEnabled: global.weirdo_drains_enabled, wealthDrainEnabled: global.wealth_drain_enabled, taxEnabled: global.weirdo_tax_enabled } },
            { upsert: true }
        );
    } catch (e) { console.error('economy saveGameConfig error:', e.message); }
}

const PROPERTY_TAX_RATE  = 0.002;
const WEALTH_TAX_BRACKETS = [
    { threshold: 1_000_000_000, rate: 0.010 },
    { threshold: 100_000_000,  rate: 0.005 },
    { threshold: 10_000_000,   rate: 0.002 },
    { threshold: 1_000_000,    rate: 0.001 },
];
const GEAR_MAINTENANCE_BASE = { legendary: 50000, epic: 15000, rare: 5000, uncommon: 1000, common: 200 };
const FACTION_DUES_BASE = 5000;

function getWealthTaxRate(balance) {
    for (const b of WEALTH_TAX_BRACKETS) { if (balance >= b.threshold) return b.rate; }
    return 0;
}

const GEAR_RARITIES = { railgun:'legendary', nuclearbriefcase:'legendary', godspear:'legendary', warlordhelm:'legendary',
    powerfists:'legendary', titanlegs:'legendary', hermes:'legendary', glacierstriders:'legendary',
    royalsword:'legendary', queenhelmet:'legendary', oniblade:'legendary', mythiclegrob:'legendary',
    flamethrower:'epic', precisionrifle:'epic', energyblade:'epic', titanhelmet:'epic', combatgauntlets:'epic',
    combatlegs:'epic', speedforce:'epic', dragonscale:'epic', cartelhelmet:'epic', goldenknuckles:'epic',
    desertstriders:'epic', knightgauntlet:'epic', royalguardleg:'epic', kabuto:'epic', ironzori:'epic',
    alpine:'epic', mountainknight:'epic', avalanchegloves:'epic', sniperx:'epic', grenadlauncher:'epic',
    sniper:'rare', doubleshotgun:'rare', naginata:'rare', ak47:'rare', obsidianknife:'rare', crossbow:'rare',
    tacticalhelmet:'rare', legguards:'rare', tacboots:'rare', chainmail:'rare', serpentskin:'rare',
    cowboyboots:'rare', tophat:'rare', knightleg:'rare', suneate:'rare', ninjawaraji:'rare',
    swisshelmet:'rare', bankervault:'rare', alpineboots:'rare', knifegloves:'rare', tekko:'rare',
    smg:'uncommon', taserx2:'uncommon', crownofthorns:'uncommon', superherosuit:'uncommon',
    motorcyclehelmet:'uncommon', tackleknees:'uncommon', heavyboots:'uncommon', rollerskates:'uncommon',
    ninjahandwraps:'uncommon', hachiganji:'uncommon', snowguard:'uncommon', lordgloves:'uncommon',
    lucha:'uncommon', armadilloleg:'uncommon', oxfordsteel:'uncommon' };

function getItemRarity(itemId) { return GEAR_RARITIES[itemId] || 'common'; }

async function applyHourlyDrains(acc) {
    if (!global.weirdo_drains_enabled) return;
    const currentTime = now();
    const hourMs = 3_600_000;

    // Property tax
    const propTicks = Math.floor((currentTime - (acc.lastPropertyTax || currentTime)) / hourMs);
    if (propTicks >= 1 && acc.properties && Object.keys(acc.properties).length > 0) {
        let propTax = 0;
        for (const [propId, qty] of Object.entries(acc.properties)) {
            propTax += Math.ceil((DEFAULT_PROP_PRICES[propId] || 0) * PROPERTY_TAX_RATE * (qty || 0) * propTicks);
        }
        if (propTax > 0) {
            if (acc.money >= propTax) {
                acc.money -= propTax;
                logFinancial(acc, `🏠 Property tax (${propTicks}hr)`, -propTax);
            } else {
                const sorted = Object.entries(acc.properties).sort((a,b) => (DEFAULT_PROP_PRICES[b[0]]||0)-(DEFAULT_PROP_PRICES[a[0]]||0));
                if (sorted.length > 0) {
                    const [evId] = sorted[0];
                    acc.properties[evId] = Math.max(0, (acc.properties[evId]||1) - 1);
                    if (acc.properties[evId] === 0) delete acc.properties[evId];
                    logFinancial(acc, `⚠️ Evicted from ${evId} (unpaid tax)`, 0);
                }
                acc.money = Math.max(MIN_WALLET, acc.money - propTax);
                logFinancial(acc, `🏠 Property tax (${propTicks}hr) — partial`, -propTax);
            }
        }
        acc.lastPropertyTax = currentTime;
    }

    // Wealth tax — separate toggle (togglewealthdrain)
    const wealthDrainOn = global.wealth_drain_enabled !== false;
    const wealthTicks = Math.floor((currentTime - (acc.lastWealthTax || currentTime)) / hourMs);
    if (wealthDrainOn && wealthTicks >= 1) {
        const total = (acc.money || 0) + (acc.bank || 0);
        const rate = getWealthTaxRate(total);
        if (rate > 0) {
            const walletShare = Math.ceil(acc.money * rate * wealthTicks);
            const bankShare   = Math.ceil((acc.bank||0) * rate * wealthTicks);
            const totalTax    = walletShare + bankShare;
            acc.money = Math.max(MIN_WALLET, acc.money - walletShare);
            acc.bank  = Math.max(0, (acc.bank||0) - bankShare);
            logFinancial(acc, `💸 Wealth tax ${(rate*100).toFixed(1)}%/hr (${wealthTicks}hr)`, -totalTax);
        }
        acc.lastWealthTax = currentTime;
    }

    // Gear maintenance
    const gearTicks = Math.floor((currentTime - (acc.lastGearMaintenance || currentTime)) / hourMs);
    if (gearTicks >= 1) {
        const slots = ['equippedWeapon','equippedArmor','equippedHelmet','equippedGloves','equippedKneePads','equippedBoots'];
        let totalGearCost = 0;
        for (const slot of slots) {
            if (!acc[slot]) continue;
            const cost = iC(GEAR_MAINTENANCE_BASE[getItemRarity(acc[slot])] || 200) * gearTicks;
            if (acc.money >= cost) {
                acc.money -= cost;
                totalGearCost += cost;
            } else {
                logFinancial(acc, `🔧 ${acc[slot]} broke down (no maintenance funds)`, 0);
                acc[slot] = null;
            }
        }
        if (totalGearCost > 0) logFinancial(acc, `🔧 Gear maintenance (${gearTicks}hr)`, -totalGearCost);
        acc.lastGearMaintenance = currentTime;
    }

    // Faction dues
    const factionTicks = Math.floor((currentTime - (acc.lastFactionDues || currentTime)) / hourMs);
    if (factionTicks >= 1 && acc.faction) {
        const dues = iC(FACTION_DUES_BASE) * factionTicks;
        if (acc.money >= dues) {
            acc.money -= dues;
            logFinancial(acc, `🏢 Faction dues (${factionTicks}hr)`, -dues);
        } else {
            logFinancial(acc, `🏢 Kicked from faction (unpaid dues ${fmtMoney(dues)})`, 0);
            acc.faction = null;
        }
        acc.lastFactionDues = currentTime;
    }
}

// Rough property price lookup for tax (economy.js doesn't have full shop list)
const DEFAULT_PROP_PRICES = {
    shack: 5000, condo: 500000, island: 500000000,
    cartelmansion: 3500000, hideout: 75000,
    penthouse: 1500000, townhouse: 300000,
    ryokan: 850000, zenmansion: 6000000,
    cabin: 150000, chalet: 2000000, castle: 20000000
};

// Gear stat bonuses mirror (matches torn.js DEFAULT_SHOP entries)
// format: itemId → { atkBonus, defBonus, strBonus, spdBonus, dexBonus }
const GEAR_STAT_BONUSES = {
    // ── weapons ──
    knife:          { atkBonus: 10 }, dagger:        { atkBonus: 22 },
    bat:            { atkBonus: 18 }, machete:       { atkBonus: 35 },
    katana:         { atkBonus: 60 }, smg:           { atkBonus: 75 },
    shotgun:        { atkBonus: 55 }, doubleshotgun: { atkBonus: 85 },
    ar15:           { atkBonus: 95 }, sniper:        { atkBonus: 120 },
    precisionrifle: { atkBonus: 145 },flamethrower:  { atkBonus: 160 },
    railgun:        { atkBonus: 280, strBonus: 30 }, energyblade: { atkBonus: 170, dexBonus: 20 },
    naginata:       { atkBonus: 105, spdBonus: 12 }, ak47:        { atkBonus: 110 },
    obsidianknife:  { atkBonus: 95, dexBonus: 10 },  crossbow:    { atkBonus: 48 },
    taserx2:        { atkBonus: 45 }, stunguns:      { atkBonus: 88 },
    grenadlauncher: { atkBonus: 195 },godspear:      { atkBonus: 350, strBonus: 40 },
    royalsword:     { atkBonus: 320, strBonus: 35 }, oniblade:    { atkBonus: 310, dexBonus: 30 },
    nuclearbriefcase:{ atkBonus: 400, strBonus: 50 },sniperx:     { atkBonus: 210 },
    // ── armor (body) ──
    leatherjacket:  { defBonus: 8 },  chainmail:     { defBonus: 30 },
    kevlar:         { defBonus: 55 }, tacticalvest:  { defBonus: 80 },
    dragonscale:    { defBonus: 150 },superherosuit: { defBonus: 30, spdBonus: 8 },
    trasharmor:     { defBonus: 6 },
    // ── head ──
    motorcyclehelmet:{ defBonus: 15 },tacticalhelmet:{ defBonus: 40 },
    warlordhelm:    { defBonus: 120, strBonus: 25 }, titanhelmet: { defBonus: 90, strBonus: 15 },
    tinfoilhat:     { defBonus: 4 },  crownofthorns: { defBonus: 25, strBonus: 5 },
    lucha:          { defBonus: 28, strBonus: 10 },  cartelhelmet: { defBonus: 130, strBonus: 15 },
    tophat:         { defBonus: 55, dexBonus: 12 },  queenhelmet: { defBonus: 220, strBonus: 30, dexBonus: 15 },
    hachiganji:     { defBonus: 18, dexBonus: 12 },  kabuto:      { defBonus: 140, strBonus: 20, dexBonus: 10 },
    swisshelmet:    { defBonus: 72, dexBonus: 8 },   alpine:      { defBonus: 160, strBonus: 20 },
    // ── hands ──
    powerfists:     { strBonus: 50, defBonus: 60 },  combatgauntlets: { defBonus: 80, strBonus: 30 },
    ovegloves:      { defBonus: 2 }, knifegloves:   { defBonus: 38, strBonus: 22 },
    serpentskin:    { defBonus: 30, dexBonus: 15 },  goldenknuckles: { defBonus: 70, strBonus: 50 },
    lordgloves:     { defBonus: 20, dexBonus: 8 },   knightgauntlet: { defBonus: 95, strBonus: 45 },
    tekko:          { defBonus: 32, dexBonus: 18 },  ninjahandwraps: { defBonus: 16, dexBonus: 10 },
    bankervault:    { defBonus: 45, strBonus: 20 },  avalanchegloves:{ defBonus: 130, strBonus: 90 },
    // ── legs ──
    tackleknees:    { defBonus: 20, spdBonus: 5 },   legguards:   { defBonus: 50 },
    combatlegs:     { defBonus: 75, spdBonus: 20 },  titanlegs:   { defBonus: 180, strBonus: 40 },
    jeansleg:       { defBonus: 4 }, armadilloleg:  { defBonus: 25, spdBonus: 8 },
    knightleg:      { defBonus: 65, spdBonus: 15 },  royalguardleg: { defBonus: 190, spdBonus: 55 },
    suneate:        { defBonus: 55, spdBonus: 20 },  mythiclegrob: { defBonus: 200, spdBonus: 60 },
    snowguard:      { defBonus: 28, spdBonus: 10 },  mountainknight: { defBonus: 100, spdBonus: 30 },
    // ── feet ──
    heavyboots:     { defBonus: 25, spdBonus: 8 },   tacboots:    { defBonus: 55, spdBonus: 18 },
    speedforce:     { defBonus: 90, spdBonus: 60 },  hermes:      { defBonus: 150, spdBonus: 120 },
    flipflops:      { defBonus: 2, spdBonus: 3 },    rollerskates: { defBonus: 18, spdBonus: 30 },
    cowboyboots:    { defBonus: 42, spdBonus: 22 },  desertstriders: { defBonus: 80, spdBonus: 50 },
    oxfordsteel:    { defBonus: 20, spdBonus: 10 },  ninjawaraji: { defBonus: 38, spdBonus: 35 },
    ironzori:       { defBonus: 88, spdBonus: 55 },  alpineboots: { defBonus: 58, spdBonus: 28 },
    glacierstriders:{ defBonus: 170, spdBonus: 100 },
};

// Sum all gear bonuses for a player (reads equipped slots)
function getEconGearBonus(acc) {
    const slots = ['equippedWeapon','equippedArmor','equippedHelmet','equippedGloves','equippedKneePads','equippedBoots'];
    const total = { atkBonus: 0, defBonus: 0, strBonus: 0, spdBonus: 0, dexBonus: 0 };
    for (const slot of slots) {
        const item = acc[slot];
        if (!item) continue;
        const b = GEAR_STAT_BONUSES[item] || {};
        total.atkBonus += b.atkBonus || 0;
        total.defBonus += b.defBonus || 0;
        total.strBonus += b.strBonus || 0;
        total.spdBonus += b.spdBonus || 0;
        total.dexBonus += b.dexBonus || 0;
    }
    return total;
}

// ----------------- System Data -----------------
const BLACKMARKET = {
  luckycharm: { price: 15000, desc: "Better odds in casino/wagers (Consumed automatically)." },
  lockpick:   { price: 5000,  desc: "Increases your robbery success rate (Consumed)." },
  medkit:     { price: 120,   desc: "Heals you. Discharges you from hospital." }
};

const JOBS = [
  // name, min, max, expReq, levelReq, statReq {stat, min}, note
  { name: "street cleaner",   min: 80,     max: 200,    expReq: 0,    levelReq: 1,  statReq: null,                         note: "No requirements" },
  { name: "delivery driver",  min: 150,    max: 400,    expReq: 10,   levelReq: 2,  statReq: { stat: 'speed', min: 5 },    note: "Req: 5 Speed" },
  { name: "mechanic",         min: 300,    max: 700,    expReq: 25,   levelReq: 4,  statReq: { stat: 'dexterity', min: 8 },note: "Req: 8 Dexterity" },
  { name: "security guard",   min: 500,    max: 1200,   expReq: 40,   levelReq: 5,  statReq: { stat: 'strength', min: 10 },note: "Req: 10 Strength" },
  { name: "teacher",          min: 800,    max: 1800,   expReq: 80,   levelReq: 8,  statReq: { stat: 'intelligence', min: 10 }, note: "Req: 10 Intelligence" },
  { name: "nurse",            min: 1400,   max: 2800,   expReq: 120,  levelReq: 10, statReq: { stat: 'intelligence', min: 15 }, note: "Req: Level 10 + 15 Intelligence" },
  { name: "police officer",   min: 2000,   max: 4500,   expReq: 180,  levelReq: 12, statReq: { stat: 'strength', min: 20 },note: "Req: Level 12 + 20 Strength" },
  { name: "lawyer",           min: 3500,   max: 7000,   expReq: 300,  levelReq: 15, statReq: { stat: 'intelligence', min: 30 }, degreeReq: 'law', note: "Req: Level 15 + Law degree + 30 Intel" },
  { name: "software engineer",min: 5000,   max: 10000,  expReq: 500,  levelReq: 20, statReq: { stat: 'intelligence', min: 50 }, degreeReq: 'computerscience', note: "Req: Level 20 + CS degree + 50 Intel" },
  { name: "surgeon",          min: 8000,   max: 16000,  expReq: 800,  levelReq: 25, statReq: { stat: 'intelligence', min: 80 }, degreeReq: 'nursing', note: "Req: Level 25 + Nursing degree + 80 Intel" },
  { name: "astronaut",        min: 13000,  max: 25000,  expReq: 1500, levelReq: 35, statReq: { stat: 'endurance', min: 100 }, note: "Req: Level 35 + 100 Endurance" }
];

/* ----------------- Commands ------------------ */

// WALLET
async function handleWalletCmd(conn, mek, m, { args, reply }) {
  try {
      const senderId = await getPlayerId(conn, m.sender);
      const CREATOR_ID = '2348084644182';

      // Creator can view any player by replying/mentioning
      let id = senderId;
      if (senderId === CREATOR_ID) {
          const targetId = await getTargetId(conn, mek, args || [], 0).catch(() => null);
          if (targetId && targetId !== senderId) id = targetId;
      }

      const acc = await getAccount(id);

      let status = "🟢 Free";
      if (isInFlight(acc)) {
          status = `✈️ In-flight → ${acc.travelingTo} (${msToTime(acc.travelingUntil - now())} left)`;
      } else if (isKidnapped(acc)) {
          status = `🔒 KIDNAPPED by @${acc.kidnappedBy}`;
      } else if (isHospitalized(acc)) {
          status = acc.health <= 0 ? `🏥 Hospitalized (${msToTime(acc.jailedUntil - now())})` : `🚔 Jailed (${msToTime(acc.jailedUntil - now())})`;
      }

      const viewingOther = id !== senderId;
      const text = `${viewingOther ? `👑 *Viewing: @${acc._id}*\n` : ''}👤 *${acc.username || 'Citizen'}* (@${acc._id})\n` +
                   `💸 Wallet: ${fmtMoney(acc.money)}\n` +
                   `🏦 Bank: ${fmtMoney(acc.bank)}\n` +
                   `⭐ Level: ${acc.level} (${acc.exp} XP)\n` +
                   `🔫 Weapon: ${acc.equippedWeapon || 'None'} (Ammo: ${acc.ammo || 0})\n` +
                   `🔥 Crime Heat: ${crimeLevelBar(acc.crimeLevel)}\n` +
                   `📍 Status: ${status}`;
      return conn.sendMessage(m.chat, { text, mentions: [toJid(acc._id)] }, { quoted: mek });
  } catch(e) { console.error(e); }
}
cast({ pattern: 'wallet',  desc: 'Check your wallet and bank balance', category: 'rpg', filename: __filename }, handleWalletCmd);
cast({ pattern: 'bankbal', desc: 'Check finances (alias: wallet)',     category: 'rpg', filename: __filename }, handleWalletCmd);

// BANKING
// ─────────────────────────────────────────────────────────────────────────────
// LOAN AUTO-DEDUCTION HELPER
// Call this whenever a player receives money (wage, wire, gamble, etc.)
// It checks if they have an active shark loan and auto-pays as much as possible.
// Returns a message string to APPEND to the existing reply, or '' if no loan.
// ─────────────────────────────────────────────────────────────────────────────
function tryDeductLoan(acc, credited, sourceLabel) {
    if (!acc.activeLoan || acc.activeLoan.owed <= 0) return '';
    const owed      = acc.activeLoan.owed;
    const deduct    = Math.min(credited, owed, acc.money); // only take what was just credited
    if (deduct <= 0) return '';
    acc.money -= deduct;
    acc.activeLoan.owed -= deduct;
    logFinancial(acc, `🦈 Shark auto-deducted from ${sourceLabel}`, -deduct);
    if (acc.activeLoan.owed <= 0) {
        acc.activeLoan = null;
        return `\n\n🦈 *LOAN UPDATE* — ${sourceLabel} earned you ${fmtMoney(credited)}. Shark auto-deducted *${fmtMoney(deduct)}* and your debt is *CLEARED*! ✅`;
    }
    return `\n\n🦈 *LOAN UPDATE* — ${sourceLabel} earned you ${fmtMoney(credited)}. Shark took *${fmtMoney(deduct)}*. Remaining debt: *${fmtMoney(acc.activeLoan.owed)}*`;
}

// Same but for player-to-player loans (P2P)
// Checks P2P loan collection — deducts from credited amount
async function tryDeductP2PLoans(db, acc, credited) {
    // Find active P2P loans where this player is the borrower
    const loans = await db.collection('weirdo_p2ploans').find({ borrowerId: acc._id, status: 'active' }).toArray();
    if (!loans.length) return '';
    let msgs = [];
    let remaining = credited;
    for (const loan of loans) {
        if (remaining <= 0) break;
        // Apply compound interest first
        const hoursElapsed = (Date.now() - (loan.lastCompound || loan.takenAt)) / 3600000;
        const ticks = Math.floor(hoursElapsed);
        if (ticks > 0) {
            let owed = loan.owed;
            for (let i = 0; i < ticks; i++) owed = Math.ceil(owed * (1 + loan.ratePerHour));
            loan.owed         = owed;
            loan.lastCompound = Date.now();
        }
        const deduct = Math.min(remaining, loan.owed, acc.money);
        if (deduct <= 0) continue;
        acc.money    -= deduct;
        loan.owed    -= deduct;
        remaining    -= deduct;
        const cleared = loan.owed <= 0;
        if (cleared) loan.status = 'paid';
        await db.collection('weirdo_p2ploans').updateOne({ _id: loan._id }, { $set: { owed: loan.owed, status: loan.status, lastCompound: loan.lastCompound } });
        // Credit the lender
        await db.collection('weirdo_rpg').updateOne({ _id: loan.lenderId }, { $inc: { money: deduct } });
        msgs.push(`🤝 *P2P Loan* — @${loan.lenderId} took *${fmtMoney(deduct)}*${cleared ? ` — debt *CLEARED*! ✅` : ` — still owe ${fmtMoney(loan.owed)}`}`);
    }
    return msgs.length ? '\n\n' + msgs.join('\n') : '';
}


cast({ pattern: "bank", desc: "Deposit or withdraw safe money", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId   = await getPlayerId(conn, m.sender);
      const CREATOR_ID = '2348084644182';

      const action = (args[0] || "").toLowerCase();
      if (!action || !["deposit","withdraw","bal"].includes(action))
          return reply(`Usage: bank deposit <amount|all> | bank withdraw <amount|all> | bank bal`);

      // ── CREATOR PATH: bank deposit @player <amount> ───────────────────────
      // Only enters creator path if there's BOTH a mention AND an amount after it
      let id = senderId;
      let amountRaw = args[1] || "";

      if (senderId === CREATOR_ID) {
          // Check if args[1] looks like a mention (not a number)
          const possibleMention = args[1] || "";
          const looksLikeMention = possibleMention.startsWith('@') || possibleMention.match(/^\d{10,}(@|$)/);
          if (looksLikeMention && args[2]) {
              const targetId = await getTargetId(conn, mek, args, 1).catch(() => null);
              if (targetId && targetId !== senderId) {
                  id = targetId;
                  amountRaw = args[2];
              }
          }
      }

      const acc = await getAccount(id);
      const isCreatorAction = id !== senderId;

      if (!isCreatorAction && isHospitalized(acc)) return reply(`🚨 Action restricted. You are incarcerated or hospitalized.`);
      if (!isCreatorAction && isKidnapped(acc)) return reply(`🔒 You are kidnapped.`);

      if (action === "bal") return reply(`🏦 ${isCreatorAction?`@${id}'s `:``}Bank Balance: ${fmtMoney(acc.bank)}`);

      let amount = 0;
      if (amountRaw.toLowerCase() === "all") amount = action === "deposit" ? acc.money : acc.bank;
      else amount = parseInt(amountRaw, 10);
      if (isNaN(amount) || amount <= 0) return reply(`Invalid amount. Usage: bank ${action} <amount|all>`);

      if (action === "deposit") {
        if (acc.money < amount) return reply(`Not enough cash. Wallet: ${fmtMoney(acc.money)}`);
        // ANTI-EXPLOIT: Can't shelter loan money in bank
        if (acc.activeLoan && acc.activeLoan.owed > 0) {
            const maxDeposit = Math.floor(acc.money * 0.50); // can only bank 50% if in debt
            if (amount > maxDeposit) return reply(`🦈 *Blocked* — You have an outstanding loan of ${fmtMoney(acc.activeLoan.owed)}. You can only deposit 50% of your wallet (${fmtMoney(maxDeposit)}) while in debt.\nPay off your loan first: *loan pay all*`);
        }
        acc.money -= amount; acc.bank += amount;
        logFinancial(acc, `Bank deposit${isCreatorAction?' (creator)':''}`, -amount);
        await saveAccount(acc);
        return reply(`✅ ${isCreatorAction?`Deposited ${fmtMoney(amount)} for @${id}.`:`Deposited ${fmtMoney(amount)}.`}\nWallet: ${fmtMoney(acc.money)} | Bank: ${fmtMoney(acc.bank)}`);
      } else {
        if (acc.bank < amount) return reply(`Not enough in bank. Bank: ${fmtMoney(acc.bank)}`);
        acc.bank -= amount; acc.money = Math.min(999000000000, (acc.money||0) + amount);
        logFinancial(acc, `Bank withdraw${isCreatorAction?' (creator)':''}`, amount);
        await saveAccount(acc);
        return reply(`✅ ${isCreatorAction?`Withdrew ${fmtMoney(amount)} for @${id}.`:`Withdrew ${fmtMoney(amount)}.`}\nWallet: ${fmtMoney(acc.money)} | Bank: ${fmtMoney(acc.bank)}`);
      }
  } catch(e) { console.error('bank error', e); }
});

// PAYDAY
cast({ pattern: "payday", desc: "Claim economy daily", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 Action restricted.`);
      if (isKidnapped(acc)) return reply(`🔒 You are kidnapped. Escape or pay the ransom first.`);

      const DAY = 24*60*60*1000;
      const last = acc.cooldowns?.payday || 0;
      if (now() - last < DAY) return reply(`⏳ The bank is processing your paycheck. Return in ${msToTime(DAY - (now() - last))}`);

      const gross = 1000 + Math.floor(Math.random() * 2000);
      const { net: reward, vat } = applyVAT(gross);
      acc.money = capBalance((acc.money||0) + reward);
      const paydayLoanMsg = tryDeductLoan(acc, reward, 'Payday');
      acc.totalEarned = (acc.totalEarned||0) + reward;
      // Referral cut (async, non-blocking)
      if (acc.referredBy) {
          const joinedAt = acc.bornAt || (acc.createdAt ? new Date(acc.createdAt).getTime() : 0);
          if (Date.now() - joinedAt < 7*24*60*60*1000) {
              const cut = Math.floor(reward * 0.05);
              if (cut > 0) {
                  const db = await connectDB();
                  await db.collection('weirdo_rpg').updateOne({ _id: acc.referredBy }, { $inc: { money: cut, referralEarnings: cut } }).catch(()=>{});
              }
          }
      }

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.payday = now();

      const leveled = await addExp(acc, 25);
      logFinancial(acc, `Daily Payday`, reward);
      return reply(`💼 *PAYDAY!* Gross: ${fmtMoney(gross)} — 🏛️ VAT: -${fmtMoney(vat)} = *${fmtMoney(reward)}* + 25 XP!${leveled ? `\n🎉 Level Up! You are now level ${acc.level}!` : ''}${paydayLoanMsg}`);
  } catch(e) { console.error(e); }
});

// SHIFTS
cast({ pattern: "shifts", desc: "List available tier jobs", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const acc = await getAccount(await getPlayerId(conn, m.sender)).catch(()=>null);
      let out = "👔 *AVAILABLE SHIFTS*\n_✅ = available  🔒 = locked_\n_⏳ 6-hour cooldown between shifts_\n\n";
      for (const j of JOBS) {
          const locked = !acc || (acc.level||1) < (j.levelReq||1) || (acc.exp||0) < j.expReq
                      || (j.statReq && (acc[j.statReq.stat]||0) < j.statReq.min)
                      || (j.degreeReq && !(acc.degrees||[]).some(d=>d.startsWith(j.degreeReq)));
          out += `${locked?'🔒':'✅'} *${j.name.toUpperCase()}* — ${fmtMoney(j.min)}-${fmtMoney(j.max)}\n   ${j.note||''}\n\n`;
      }
      out += "*Command:* shift <job name>";
      return reply(out);
  } catch(e) { console.error('shifts error', e); }
});

cast({ pattern: "shift", desc: "Work a shift", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 You cannot go to work from a hospital bed/jail cell.`);
      if (isKidnapped(acc)) return reply(`🔒 You are kidnapped. You can't work right now.`);
      if (isInFlight(acc)) return reply(`✈️ You're in-flight to ${acc.travelingTo}. Work when you land.`);

      const COOLDOWN = 6*60*60*1000; // 6 hours
      const last = acc.cooldowns?.shift || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ You are tired. Shift starts in ${msToTime(COOLDOWN - (now() - last))})`);

      let chosen;
      const requested = (args.join(" ") || "").toLowerCase();
      function meetsJobReq(acc, j) {
          if ((acc.exp || 0) < j.expReq) return { ok: false, reason: `Need ${j.expReq} XP` };
          if ((acc.level || 1) < (j.levelReq || 1)) return { ok: false, reason: `Need Level ${j.levelReq}` };
          if (j.statReq) {
              const statVal = acc[j.statReq.stat] || 0;
              if (statVal < j.statReq.min) return { ok: false, reason: `Need ${j.statReq.min} ${j.statReq.stat} (you have ${statVal})` };
          }
          if (j.degreeReq) {
              const hasDeg = (acc.degrees || []).some(d => d.startsWith(j.degreeReq));
              if (!hasDeg) return { ok: false, reason: `Need a ${j.degreeReq} degree (*enroll ${j.degreeReq}*)` };
          }
          return { ok: true };
      }

      if (requested) {
          chosen = JOBS.find(j => j.name.toLowerCase() === requested.toLowerCase());
          if (!chosen) return reply("Job not found. Use *shifts* to list available jobs.");
          const req = meetsJobReq(acc, chosen);
          if (!req.ok) return reply(`❌ *${chosen.name}* — ${req.reason}.`);
      } else {
          const possible = JOBS.filter(j => meetsJobReq(acc, j).ok);
          if (!possible.length) return reply(`No shifts available. Train your stats or level up.`);
          chosen = possible[Math.floor(Math.random() * possible.length)];
      }

      // Live wages — scale with global wage index + seasonal bonus
      const wageM    = global.WAGE_INDEX ?? 1.0;
      const baseWage = Math.ceil((chosen.min + Math.floor(Math.random()*(chosen.max - chosen.min + 1))) * wageM);
      // Seasonal event bonus
      const _sevt = (() => { const d=new Date(),m=d.getMonth()+1,day=d.getDate(); if(m===12&&day>=20)return 0.50; if(m===10&&day>=28)return 0; if(m===1&&day<=3)return 1.0; return 0; })();
      const gross = Math.ceil(baseWage * (1 + _sevt));
      const wageTag = wageM > 1.15 ? ' 📈' : wageM < 0.85 ? ' 📉' : '';
      const { net: pay, vat } = applyVAT(gross);
      acc.money = capBalance((acc.money||0) + pay);
      addTaxableIncome(acc, pay);
      acc.jobsDone    = (acc.jobsDone || 0) + 1;
      acc.manualLabor = (acc.manualLabor||0) + Math.ceil(pay/10000);
      acc.endurance   = (acc.endurance||0) + 1;
      acc.totalEarned = (acc.totalEarned||0) + pay;
      // Tick daily challenge
      const _today = new Date().toISOString().split('T')[0];
      if (acc.dailyChallenge?.date === _today) {
          for (const t of acc.dailyChallenge.tasks||[]) {
              if (!t.done) {
                  if (t.key==='shifts') { t.progress=(t.progress||0)+1; if(t.progress>=t.target)t.done=true; }
                  if (t.key==='earned') { t.progress=(t.progress||0)+pay; if(t.progress>=t.target)t.done=true; }
              }
          }
      }

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.shift = now();

      const shiftLoanMsg = tryDeductLoan(acc, pay, `${chosen.name} shift`);
      const leveled = await addExp(acc, Math.floor(pay/100) + 5);
      logFinancial(acc, `Shift: ${chosen.name}`, pay);
      await saveAccount(acc);
      return reply(`👔 *${chosen.name.toUpperCase()}* shift complete!${wageTag}\nGross: ${fmtMoney(gross)} | VAT: -${fmtMoney(vat)} | *Net: ${fmtMoney(pay)}*${leveled ? `\n🎉 Level Up! You are now level ${acc.level}!` : ''}${shiftLoanMsg}`);
  } catch(e) { console.error(e); }
});

// ROB — Strength-based outcome, crime bar tracking
// ROB — same location, full stat-based outcome
cast({ pattern: "rob", desc: "rob @user (must be in same city)", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const attackerId = await getPlayerId(conn, m.sender);
      const targetId   = await getTargetId(conn, mek, args, 0);
      if (!targetId)              return reply("Tag someone to rob. Usage: rob @user");
      if (targetId === attackerId) return reply("You can't rob yourself.");

      const acc    = await getAccount(attackerId);
      const victim = await getAccount(targetId);

      if (isHospitalized(acc)) return reply(`🚨 You're hospitalized or in jail. Can't rob from there.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped. Escape first.`);
      if (isInFlight(acc))     return reply(`✈️ You're in-flight. Rob when you land.`);
      if (isInFlight(victim))  return reply(`✈️ That player is in-flight and unreachable.`);
      if (victim.robImmunityUntil && victim.robImmunityUntil > now()) {
          return reply(`🛡️ *${victim.username || targetId}* has active rob protection for another ${msToTime(victim.robImmunityUntil - now())}. Find someone else.`);
      }

      // ── SAME LOCATION REQUIRED ────────────────────────────────────────────
      const myCity     = normLoc(acc.location);
      const victimCity = normLoc(victim.location);
      if (myCity !== victimCity) {
          return reply(`🌍 *Different city!*\nYou're in *${myCity}* — they're in *${victimCity}*.\nTravel there first to rob them.`);
      }

      const COOLDOWN = 20 * 60 * 1000;
      if (now() - (acc.lastRob || 0) < COOLDOWN)
          return reply(`⏳ Lay low for ${msToTime(COOLDOWN - (now() - (acc.lastRob || 0)))} before robbing again.`);

      if (!victim.money || victim.money <= 100)
          return reply("That player is broke. Nothing worth taking.");

      // ── FULL STAT + GEAR + LEVEL FORMULA ─────────────────────────────────
      const accGear  = getEconGearBonus(acc);
      const vicGear  = getEconGearBonus(victim);

      // Level scaling: +8% per level above 1, same formula as attack command
      const atkLvlMult = 1 + ((acc.level    || 1) - 1) * 0.08;
      const defLvlMult = 1 + ((victim.level || 1) - 1) * 0.08;

      // Pet combat power — a dragon fighting alongside you adds 200 raw power
      const atkPetPower = (() => { const p = getPetBonus(acc);    return (p.strBonus||0) + (p.spdBonus||0) + (p.dexBonus||0); })();
      const defPetPower = (() => { const p = getPetBonus(victim); return (p.defBonus||0) + (p.strBonus||0); })();

      let atkPower = ((acc.strength || 3) + (acc.speed || 3) + accGear.atkBonus + accGear.strBonus + accGear.spdBonus + atkPetPower) * atkLvlMult;
      let usedStr  = '';

      // Ranged weapon consumes ammo, melee does not
      if (acc.equippedWeapon && (acc.ammo || 0) > 0) {
          acc.ammo -= 1;
          usedStr = `\n🔫 Drew ${acc.equippedWeapon}! (Ammo -1)`;
      } else if (acc.equippedWeapon) {
          usedStr = `\n🔪 Raised ${acc.equippedWeapon}!`;
      }
      if ((acc.inventory?.lockpick || 0) > 0) {
          atkPower += 15; acc.inventory.lockpick -= 1; usedStr += `\n🔓 Lockpick used.`;
      }
      if ((acc.inventory?.luckycharm || 0) > 0) {
          atkPower += 20; acc.inventory.luckycharm -= 1; usedStr += `\n🍀 Lucky Charm used!`;
      }

      // Defender power: all defensive stats + gear + level + pet
      const defPower = ((victim.strength || 3) + (victim.defense || 3)
                     + vicGear.defBonus + vicGear.strBonus + vicGear.dexBonus + defPetPower
                     + (victim.equippedWeapon && (victim.ammo || 0) > 0 ? 45 : victim.equippedWeapon ? 20 : 0)) * defLvlMult;

      const powerRatio = atkPower / Math.max(1, defPower);

      // Weaker attackers are heavily penalised — a ratio <1 caps at 20% max
      let successChance;
      if (powerRatio < 1.0) {
          successChance = Math.max(0.05, 0.20 * powerRatio);
      } else {
          successChance = Math.min(0.72, 0.30 + 0.21 * (powerRatio - 1));
      }

      let warningMsg = '';
      if      (powerRatio < 0.5)  warningMsg = `\n⚠️ *Danger:* Your target is far stronger — nearly hopeless.`;
      else if (powerRatio < 1.0)  warningMsg = `\n⚠️ Your target is stronger — this is risky.`;
      else if (powerRatio >= 2.5) warningMsg = `\n💪 Outmatched them completely.`;

      acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 15);
      acc.lastRob    = now();

      // Pet flavour line
      const robPetLine = (() => {
          if (!acc.pet?.type) return '';
          const petLvl  = acc.pet.level || 1;
          const petNick = acc.pet.nickname || null;
          const lvlTag  = petLvl > 1 ? ` (Lv${petLvl})` : '';
          const n       = petNick ? `${petNick}` : null;
          const PET_ROB_LINES = {
              dog:     `🐶 ${n || `Your Dog${lvlTag}`} growled at the target — they froze up!`,
              cat:     `🐱 ${n || `Your Cat${lvlTag}`} darted at their ankles — perfect distraction!`,
              parrot:  `🦜 ${n || `Your Parrot${lvlTag}`} screamed in their face — chaos ensued!`,
              penguin: `🐧 ${n || `Your Penguin${lvlTag}`} waddled menacingly between you and the target.`,
              wolf:    `🐺 ${n || `Your Wolf${lvlTag}`} circled the target — they were too scared to resist.`,
              bear:    `🐻 ${n || `Your Bear${lvlTag}`} rose up and roared — target surrendered immediately.`,
              shark:   `🦈 ${n || `Your Shark${lvlTag}`}... somehow appeared. The target ran.`,
              dragon:  `🐉 ${n || `Your Dragon${lvlTag}`} breathed fire. They handed over everything.`,
          };
          return '\n' + (PET_ROB_LINES[acc.pet.type] || '');
      })();

      if (Math.random() < successChance) {
          const pct        = 0.10 + Math.random() * 0.20;
          const stealGross = Math.floor(victim.money * pct);
          const { net: stolen, vat } = applyVAT(stealGross);
          victim.money -= stealGross;
          acc.money    += stolen;
          acc.crimesCommitted = (acc.crimesCommitted || 0) + 1;
          addTaxableIncome(acc, stolen);
          logFinancial(acc,    `Robbed @${targetId}`,     stolen);
          logFinancial(victim, `Robbed by @${acc._id}`, -stealGross);
          await saveAccount(victim);
          await saveAccount(acc);
          return conn.sendMessage(m.chat, {
              text: `🦹 *ROB SUCCESS!*${usedStr}${robPetLine}${warningMsg}\n\nTook ${fmtMoney(stealGross)} from @${targetId}\n🏛️ VAT -${fmtMoney(vat)} = *${fmtMoney(stolen)} net*\n🔥 Heat: ${crimeLevelBar(acc.crimeLevel)}`,
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      } else {
          if (Math.random() < 0.40) {
              const fine = Math.min(acc.money, 500 + Math.floor(Math.random() * 1000));
              acc.jailedUntil = now() + 15 * 60 * 1000;
              acc.money -= fine;
              await saveAccount(acc);
              return reply(`🚔 *BUSTED!*${usedStr}${warningMsg}\n\nCops caught you. Fined ${fmtMoney(fine)} + 15 min jail.`);
          } else {
              const fine = Math.min(acc.money, 200 + Math.floor(Math.random() * 500));
              acc.money -= fine;
              await saveAccount(acc);
              return reply(`🚨 *ROB FAILED!*${usedStr}${warningMsg}\n\nTripped the alarm — dropped ${fmtMoney(fine)} escaping.`);
          }
      }
  } catch(e) { console.error('rob error', e); }
});

// CALL COPS — Report a high-crime player for arrest
cast({ pattern: "callcops", desc: "callcops @user — Report a wanted criminal", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const callerId = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);

      if (!targetId) return reply("Tag the player you want to report. Usage: callcops @user");
      if (targetId === callerId) return reply("You can't report yourself.");

      const caller = await getAccount(callerId);
      if (isHospitalized(caller)) return reply("You can't call the cops from jail/hospital.");

      // Per-caller cooldown: 5 minutes
      const COOLDOWN = 5 * 60 * 1000;
      const lastCall = (caller.cooldowns?.callcops || 0);
      if (now() - lastCall < COOLDOWN) return reply(`⏳ You already called the cops recently. Wait ${msToTime(COOLDOWN - (now() - lastCall))}.`);

      const target = await getAccount(targetId);
      const heat = target.crimeLevel || 0;

      caller.cooldowns = caller.cooldowns || {};
      caller.cooldowns.callcops = now();
      await saveAccount(caller);

      if (heat < 10) {
          return conn.sendMessage(m.chat, {
              text: `👮 You reported @${targetId} to the police.\n\nThe cops checked them out but their crime heat is too low (${heat}/100). No grounds for arrest.`,
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      }

      // Arrest chance scales with heat level
      const arrestChance = Math.min(0.90, 0.30 + (heat - 10) * 0.0075);
      const arrested = Math.random() < arrestChance;

      if (arrested) {
          const hasLawDeg  = (target.degrees || []).some(d => d.startsWith('law_'));
          const jailReduce = hasLawDeg ? 0.80 : 1.0;
          const jailMs = Math.max(5 * 60 * 1000, Math.floor(heat * 30000 * jailReduce));
          target.jailedUntil     = now() + jailMs;
          target.inJail          = true;
          target.jailWorkDone    = 0;
          target.lawyerCallUsed  = false;
          target.sentencedAt     = now();
          target.sentenceMs      = jailMs;
          target.crimeLevel      = 0;
          target.lastCrimeLevelDecay = now();

          // Caller gets a reward
          // Informant reward scales heavily with how hot the criminal was
          const reward = 1000 + Math.floor(Math.random() * 2000) + Math.floor(heat * 50);
          caller.money = (caller.money || 0) + reward;
          await saveAccount(target);
          await saveAccount(caller);

          return conn.sendMessage(m.chat, {
              text: `🚔 *ARREST MADE!*\n\n@${callerId} tipped off the cops about @${targetId}!\n\nThe police caught them with a crime heat of 🔴 ${heat}/100.\n\n⛓️ @${targetId} has been jailed for ${msToTime(jailMs)}.\n💰 Informant reward: *${fmtMoney(reward)}* 🎉`,
              mentions: [toJid(callerId), toJid(targetId)]
          }, { quoted: mek });
      } else {
          // Failed arrest — target gets a small heat reduction (they got lucky this time)
          target.crimeLevel = Math.max(0, heat - 15);
          await saveAccount(target);

          return conn.sendMessage(m.chat, {
              text: `👮 *REPORT FILED — ESCAPED!*\n\n@${callerId} tipped off the police about @${targetId} (Heat: 🟠 ${heat}/100).\n\nThe cops responded but @${targetId} slipped away. Their heat cooled slightly.`,
              mentions: [toJid(callerId), toJid(targetId)]
          }, { quoted: mek });
      }
  } catch(e) { console.error(e); }
});

// BLACKMARKET
cast({ pattern: "bm", desc: "View underworld items (alias: blackmarket)", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  let out = "🌑 *THE BLACKMARKET*\n_No questions asked._\n\n";
  for (const k of Object.keys(BLACKMARKET)) {
      out += `• *${k}* — ${fmtMoney(BLACKMARKET[k].price)}\n  ↳ _${BLACKMARKET[k].desc}_\n\n`;
  }
  out += "*Command:* underworld <item>  (or use *deal <number>* for torn's black market)";
  return reply(out);
});

cast({ pattern: "underworld", desc: "Buy from black market (alias: deal)", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const item = (args[0] || "").toLowerCase();
      if (!BLACKMARKET[item]) return reply(`Item not found. Use *bm* to browse available items.`);

      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      const bmPrice = Math.ceil(BLACKMARKET[item].price * (global.ECON_INDEX ?? 1.0) * (global.INFLATION_MULT ?? 1));
      if (acc.money < bmPrice) return reply(`You don't have enough cash. Costs ${fmtMoney(bmPrice)}.`);

      acc.money -= bmPrice;
      acc.moneySpent = (acc.moneySpent || 0) + bmPrice;
      logFinancial(acc, `🌑 Blackmarket: ${item}`, -bmPrice);

      let effectMsg = '';
      // Apply immediate effects where applicable
      if (item === 'medkit') {
          // Medkit: heal and possibly discharge from hospital
          const healAmt = Math.floor(5 + Math.random() * 6);
          acc.health = Math.min(acc.maxHealth || 100, (acc.health || 100) + healAmt);
          if (!acc.inJail && acc.health >= 40 && acc.jailedUntil > now()) {
              acc.jailedUntil = 0;
              effectMsg = `\n✅ +${healAmt} HP — Discharged from hospital!`;
          } else {
              effectMsg = `\n❤️ +${healAmt} HP (${acc.health}/${acc.maxHealth || 100})`;
              acc.inventory = acc.inventory || {};
              acc.inventory[item] = (acc.inventory[item] || 0) + 1;
          }
      } else if (item === 'luckycharm') {
          // Lucky charm: store in inventory, auto-consumed in rob/wager/gamble
          acc.inventory = acc.inventory || {};
          acc.inventory[item] = (acc.inventory[item] || 0) + 1;
          effectMsg = `\n🍀 Lucky charm stored — auto-activates in your next rob, wager, or gamble!`;
      } else if (item === 'lockpick') {
          // Lockpick: store in inventory, auto-consumed in rob
          acc.inventory = acc.inventory || {};
          acc.inventory[item] = (acc.inventory[item] || 0) + 1;
          effectMsg = `\n🔓 Lockpick stored — auto-activates in your next robbery for +15 success!`;
      } else {
          acc.inventory = acc.inventory || {};
          acc.inventory[item] = (acc.inventory[item] || 0) + 1;
      }

      logFinancial(acc, `BM purchase: ${item}`, -bmPrice);
      await saveAccount(acc);
      return reply(`🤝 Deal done. You purchased 1x *${item}* for ${fmtMoney(bmPrice)}.${effectMsg}`);
  } catch(e) { console.error(e); }
});

// INVEST
// =============================================================================
// INVESTMENT SLOTS — Up to 5 named slots, each with progress tracking
// invest <slot> <amount> <term> — invest 1 50000 6h
// invest status                 — see all slots with P&L and time left
// invest withdraw <slot>        — pull out early (lose 20% as penalty)
// invest claim <slot>           — collect matured investment
// =============================================================================
const MAX_INV_SLOTS = 5;
const INV_TERMS = {
    '30m':  { ms: 30*60*1000,    baseRate: 0.02,  label: '30 min' },
    '1h':   { ms: 60*60*1000,    baseRate: 0.05,  label: '1 hour' },
    '3h':   { ms: 3*60*60*1000,  baseRate: 0.12,  label: '3 hours' },
    '6h':   { ms: 6*60*60*1000,  baseRate: 0.22,  label: '6 hours' },
    '12h':  { ms: 12*60*60*1000, baseRate: 0.38,  label: '12 hours' },
    '24h':  { ms: 24*60*60*1000, baseRate: 0.60,  label: '24 hours' },
};

cast({ pattern: "invest", desc: "invest status | invest <slot> <amount> <term> | invest claim/withdraw <slot>", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 Action restricted.`);
      if (isKidnapped(acc))    return reply(`🔒 You are kidnapped.`);

      // Ensure investments array has slot structure
      if (!Array.isArray(acc.investments)) acc.investments = [];
      // Migrate old flat investments to slot format
      acc.investments = acc.investments.map((inv, i) => {
          if (!inv.slot) return { ...inv, slot: i + 1 };
          return inv;
      });

      const sub = (args[0] || 'status').toLowerCase();
      const nowTs = now();
      const econM = Math.max(0.4, Math.min(2.0, global.ECON_INDEX ?? 1.0));
      const econLabel = econM > 1.3 ? '📈 Bull Market' : econM < 0.7 ? '📉 Bear Market' : '📊 Stable';

      // ── STATUS ──────────────────────────────────────────────────────────────
      if (sub === 'status' || sub === 'slots') {
          const lines = [`💼 *INVESTMENT PORTFOLIO*`, `Market: ${econLabel}`, ``];
          for (let slot = 1; slot <= MAX_INV_SLOTS; slot++) {
              const inv = acc.investments.find(i => i.slot === slot);
              if (!inv) {
                  lines.push(`[Slot ${slot}] ⬜ *Empty* — invest ${slot} <amount> <term>`);
              } else {
                  const elapsed   = nowTs - inv.boughtAt;
                  const progress  = Math.min(1, elapsed / inv.termMs);
                  const matured   = elapsed >= inv.termMs;
                  const timeLeft  = matured ? 0 : inv.termMs - elapsed;
                  // Current value = principal + accrued interest (linear)
                  const accrued   = Math.floor(inv.amount * inv.rate * progress);
                  const currentVal = inv.amount + accrued;
                  const finalVal  = Math.floor(inv.amount * (1 + inv.rate));
                  const plPct     = ((currentVal - inv.amount) / inv.amount * 100).toFixed(1);
                  const bar       = '█'.repeat(Math.floor(progress * 10)) + '░'.repeat(10 - Math.floor(progress * 10));
                  lines.push(`[Slot ${slot}] ${matured ? '✅ *MATURE*' : '⏳ *Active*'}`);
                  lines.push(`  💵 Invested: ${fmtMoney(inv.amount)} | Now: ${fmtMoney(currentVal)} (+${plPct}%)`);
                  lines.push(`  🎯 At maturity: ${fmtMoney(finalVal)} | Rate: ${(inv.rate*100).toFixed(1)}%`);
                  lines.push(`  ${bar} ${matured ? 'Ready!' : msToTime(timeLeft) + ' left'}`);
                  lines.push(matured
                      ? `  → *invest claim ${slot}* to collect`
                      : `  → *invest withdraw ${slot}* (−20% early penalty)`);
              }
              lines.push('');
          }
          lines.push(`Terms: ${Object.entries(INV_TERMS).map(([k,v])=>`${k}(${(v.baseRate*econM*100).toFixed(0)}%)`).join(' | ')}`);
          return reply(lines.join('\n'));
      }

      // ── CLAIM ────────────────────────────────────────────────────────────────
      if (sub === 'claim') {
          const slot = parseInt(args[1]);
          if (!slot || slot < 1 || slot > MAX_INV_SLOTS) return reply(`Usage: invest claim <slot 1-${MAX_INV_SLOTS}>`);
          const idx = acc.investments.findIndex(i => i.slot === slot);
          if (idx === -1) return reply(`❌ Slot ${slot} is empty.`);
          const inv = acc.investments[idx];
          if (nowTs - inv.boughtAt < inv.termMs) {
              const left = inv.termMs - (nowTs - inv.boughtAt);
              return reply(`⏳ Slot ${slot} isn't mature yet. ${msToTime(left)} remaining.\nUse *invest withdraw ${slot}* to exit early (−20% penalty).`);
          }
          // ── Market risk — longer terms carry higher loss chance ──────────────
          const econM2 = Math.max(0.4, Math.min(2.0, global.ECON_INDEX ?? 1.0));
          // Bear market = more risk; bull = less. Term > 12h = higher exposure.
          const baseRisk   = econM2 < 0.7 ? 0.35 : econM2 < 1.0 ? 0.18 : 0.08;
          const termRisk   = inv.termMs >= 24*60*60*1000 ? 0.12 : inv.termMs >= 12*60*60*1000 ? 0.07 : inv.termMs >= 6*60*60*1000 ? 0.04 : 0.01;
          const totalRisk  = Math.min(0.45, baseRisk + termRisk);
          const roll       = Math.random();

          if (roll < totalRisk * 0.4) {
              // Total loss — market crashed
              acc.investments.splice(idx, 1);
              await saveAccount(acc);
              return reply([
                  `📉 *INVESTMENT LOST — Slot ${slot}*`, ``,
                  `The market collapsed on your position.`,
                  `💸 Lost: *${fmtMoney(inv.amount)}*`,
                  `💰 Balance: ${fmtMoney(acc.money)}`,
                  `_Risk is real. Not every investment pays off._`
              ].join('\n'));
          } else if (roll < totalRisk) {
              // Partial loss — returned only 50-85% of principal, no profit
              const returnPct = 0.50 + Math.random() * 0.35;
              const returned  = Math.floor(inv.amount * returnPct);
              const lost      = inv.amount - returned;
              acc.money += returned;
              logFinancial(acc, `Investment slot ${slot} partial loss`, -lost);
              acc.investments.splice(idx, 1);
              await saveAccount(acc);
              return reply([
                  `📉 *INVESTMENT UNDERPERFORMED — Slot ${slot}*`, ``,
                  `Market conditions were unfavourable.`,
                  `💸 Principal lost: *-${fmtMoney(lost)}*`,
                  `💵 Recovered: *${fmtMoney(returned)}* (${(returnPct*100).toFixed(0)}% of principal)`,
                  `💰 Balance: ${fmtMoney(acc.money)}`
              ].join('\n'));
          }

          // Success path (majority of the time)
          const payout = Math.floor(inv.amount * (1 + inv.rate));
          const profit  = payout - inv.amount;
          acc.money += payout;
          addTaxableIncome(acc, profit);
          logFinancial(acc, `Investment slot ${slot} matured`, profit);
          acc.investments.splice(idx, 1);
          await saveAccount(acc);
          return reply([
              `✅ *INVESTMENT CLAIMED — Slot ${slot}*`, ``,
              `Principal: ${fmtMoney(inv.amount)}`,
              `Profit: *+${fmtMoney(profit)}* (${(inv.rate*100).toFixed(1)}%)`,
              `Total paid out: *${fmtMoney(payout)}*`,
              `💰 New balance: ${fmtMoney(acc.money)}`
          ].join('\n'));
      }

      // ── WITHDRAW (early exit, 20% penalty) ──────────────────────────────────
      if (sub === 'withdraw') {
          const slot = parseInt(args[1]);
          if (!slot || slot < 1 || slot > MAX_INV_SLOTS) return reply(`Usage: invest withdraw <slot 1-${MAX_INV_SLOTS}>`);
          const idx = acc.investments.findIndex(i => i.slot === slot);
          if (idx === -1) return reply(`❌ Slot ${slot} is empty.`);
          const inv = acc.investments[idx];
          if (nowTs - inv.boughtAt >= inv.termMs) return reply(`✅ Slot ${slot} is already mature! Use *invest claim ${slot}*.`);
          const PENALTY = 0.20;
          const returned = Math.floor(inv.amount * (1 - PENALTY));
          const lost = inv.amount - returned;
          acc.money += returned;
          logFinancial(acc, `Investment slot ${slot} early withdrawal (penalty)`, -lost);
          acc.investments.splice(idx, 1);
          await saveAccount(acc);
          return reply([
              `💸 *EARLY WITHDRAWAL — Slot ${slot}*`, ``,
              `Original: ${fmtMoney(inv.amount)}`,
              `Penalty (20%): -${fmtMoney(lost)}`,
              `Returned: *${fmtMoney(returned)}*`,
              `💰 New balance: ${fmtMoney(acc.money)}`
          ].join('\n'));
      }

      // ── NEW INVESTMENT: invest <slot> <amount> <term> ────────────────────────
      const slot   = parseInt(args[0]);
      const amount = parseInt(args[1]);
      const termKey = (args[2] || '6h').toLowerCase();

      if (!slot || slot < 1 || slot > MAX_INV_SLOTS || !amount || amount <= 0) {
          return reply([
              `📈 *INVESTMENT SLOTS*`, ``,
              `*Open new:*  invest <slot 1-5> <amount> <term>`,
              `*View all:*  invest status`,
              `*Collect:*   invest claim <slot>`,
              `*Exit early: invest withdraw <slot>* (−20% penalty)`, ``,
              `Terms: ${Object.entries(INV_TERMS).map(([k,v])=>`${k}=${(v.baseRate*econM*100).toFixed(0)}%`).join(' | ')}`
          ].join('\n'));
      }

      const termDef = INV_TERMS[termKey];
      if (!termDef) return reply(`Invalid term. Choose: ${Object.keys(INV_TERMS).join(' | ')}`);

      const existing = acc.investments.find(i => i.slot === slot);
      if (existing) return reply(`❌ Slot ${slot} is occupied. Claim or withdraw it first.`);
      if (acc.investments.length >= MAX_INV_SLOTS) return reply(`❌ All ${MAX_INV_SLOTS} investment slots are full.`);
      if (acc.money < amount) return reply(`Not enough cash. Have: ${fmtMoney(acc.money)}`);
      if (amount < 1000) return reply(`Minimum investment is ${fmtMoney(1000)}.`);

      const rate = +(termDef.baseRate * econM).toFixed(4);
      const projectedReturn = Math.floor(amount * (1 + rate));

      acc.money -= amount;
      acc.investments.push({ slot, amount, boughtAt: nowTs, termMs: termDef.ms, rate, term: termKey });
      logFinancial(acc, `Investment slot ${slot} opened (${termKey})`, -amount);
      await saveAccount(acc);
      return reply([
          `📈 *SLOT ${slot} OPENED*`, ``,
          `Invested: *${fmtMoney(amount)}*`,
          `Term: *${termDef.label}* | Rate: *${(rate*100).toFixed(1)}%*`,
          `Projected return: *${fmtMoney(projectedReturn)}* (+${fmtMoney(projectedReturn - amount)})`,
          `Market: ${econLabel}`,
          `Matures: ${new Date(nowTs + termDef.ms).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}`,
          ``,
          `Use *invest status* to track progress.`
      ].join('\n'));
  } catch(e) { console.error('invest error', e); }
});

cast({ pattern: "claim", desc: "Alias: invest claim <slot>", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  // Redirect to invest claim for backward compat
  args.unshift('claim');
  m.args = args;
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const slot = parseInt(args[1]);
      if (!slot) {
          // Old behavior: claim all matured
          const nowTs = now();
          const matured = acc.investments.filter(i => nowTs - i.boughtAt >= i.termMs);
          if (!matured.length) return reply(`No matured investments. Use *invest status* to check.`);
          let total = 0, profits = 0;
          for (const inv of matured) {
              const pay = Math.floor(inv.amount * (1 + inv.rate));
              total += pay; profits += pay - inv.amount;
          }
          acc.money += total;
          addTaxableIncome(acc, profits);
          acc.investments = acc.investments.filter(i => nowTs - i.boughtAt < i.termMs);
          await saveAccount(acc);
          return reply(`💸 Claimed ${matured.length} matured investments: *${fmtMoney(total)}*`);
      }
  } catch(e) { console.error(e); }
});

// WAGER
cast({ pattern: "wager", desc: "wager <amount>", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 You cannot gamble right now.`);
      if (isKidnapped(acc)) return reply(`🔒 You are kidnapped. Escape first.`);

      const amount = parseInt(args[0]);
      if (!amount || amount <= 0) return reply("Usage: wager <amount>");
      if (acc.money < amount) return reply("Not enough balance.");

      const COOLDOWN = 5*60*1000;
      const last = acc.cooldowns?.wager || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Wait ${msToTime(COOLDOWN - (now() - last))} before tossing the dice again.`);

      let winChance = 0.38;
      let charmMsg = '';

      if (acc.inventory['luckycharm'] && acc.inventory['luckycharm'] > 0) {
          winChance = 0.70;
          acc.inventory['luckycharm'] -= 1;
          charmMsg = `\n🍀 Your Lucky Charm glowed and was consumed!`;
      }

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.wager = now();

      if (Math.random() < winChance) {
        const profit = Math.floor(amount * (1 + Math.random()*0.7));
        acc.money += profit;
        addTaxableIncome(acc, profit);
        await saveAccount(acc);
        return reply(`🎲 *WINNER!* The dice rolled your way. You won ${fmtMoney(profit)}!${charmMsg}`);
      } else {
        acc.money -= amount;
        await saveAccount(acc);
        return reply(`💀 *BUST!* Snake eyes. You lost ${fmtMoney(amount)}.${charmMsg}`);
      }
  } catch(e) { console.error(e); }
});

// WIRE
cast({ pattern: "wire", desc: "wire @user <amount>", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId   = await getPlayerId(conn, m.sender);
      const CREATOR_ID = '2348084644182';

      // Creator: wire @from @to <amount>  OR normal: wire @to <amount>
      let fromId   = senderId;
      let targetId = await getTargetId(conn, mek, args, 0);
      let amountRaw = args[args.length - 1];

      if (senderId === CREATOR_ID && args.length >= 3) {
          // Try to parse wire @from @to <amount>
          const secondTarget = await getTargetId(conn, mek, args, 1).catch(() => null);
          if (secondTarget && secondTarget !== targetId) {
              fromId   = targetId;   // first mention = sender
              targetId = secondTarget; // second mention = recipient
          }
      }

      const amount = parseInt(amountRaw);
      if (!targetId || isNaN(amount) || amount <= 0) return reply(`Usage: wire @user <amount>${senderId===CREATOR_ID?' | wire @from @to <amount> (creator)':''}`);
      if (targetId === fromId) return reply("Cannot wire to yourself.");

      const acc = await getAccount(fromId);
      const rec = await getAccount(targetId);
      const isCreatorAction = fromId !== senderId;

      if (!isCreatorAction && isHospitalized(acc)) return reply(`🚨 Action restricted.`);
      if (!isCreatorAction && isKidnapped(acc)) return reply(`🔒 You are kidnapped.`);
      if (!isCreatorAction && (acc.money||0) < -100000) return reply(`🔴 *Blocked* — Wallet is ${fmtMoney(acc.money)}. Clear your debts before wiring money.`);

      // 30-second cooldown on wires to prevent spam transfers
      if (!isCreatorAction) {
          const lastWire = acc.lastWire || 0;
          const WIRE_CD  = 30 * 1000;
          if (now() - lastWire < WIRE_CD) return reply(`⏳ Wait ${Math.ceil((WIRE_CD-(now()-lastWire))/1000)}s before wiring again.`);
      }
      // P2P wire fee: 10% VAT on sender (receiver always gets full amount)
      const wireFee = isCreatorAction ? 0 : Math.ceil(amount * 0.10);
      const totalCost = amount + wireFee;
      if (acc.money < totalCost) return reply(`Insufficient funds. Wire costs ${fmtMoney(amount)} + 10% fee (${fmtMoney(wireFee)}) = ${fmtMoney(totalCost)}. You have ${fmtMoney(acc.money)}.`);

      acc.money -= totalCost;
      rec.money = capBalance((rec.money||0) + amount);
      logFinancial(acc, `Wire sent → @${targetId}${isCreatorAction?' (creator)':''}`, -totalCost);
      logFinancial(rec, `Wire received ← @${fromId}${isCreatorAction?' (creator)':''}`, amount);

      if (!isCreatorAction) acc.lastWire = now();
      await saveAccount(acc); await saveAccount(rec);
      return conn.sendMessage(m.chat, {
          text: `💸 ${isCreatorAction?`👑 Creator wired `:''}${fmtMoney(amount)} sent to @${targetId}.${isCreatorAction ? '' : `
🏛️ Transfer fee (10%): -${fmtMoney(wireFee)}
Total deducted: ${fmtMoney(totalCost)}`}`,
          mentions: [toJid(fromId), toJid(targetId)]
      }, { quoted: mek });
  } catch(e) { console.error(e); }
});

// STATEMENT — Last 20 financial transactions
// =============================================================================
// WIRECRYPTO — Transfer crypto between players
// Usage: wirecrypto @player <coin> <amount>
// =============================================================================
cast({ pattern: "wirecrypto", desc: "wirecrypto @player <coin> <amount> — Send crypto to another player", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId = await getPlayerId(conn, m.sender);
      const acc      = await getAccount(senderId);
      if (isHospitalized(acc)) return reply(`🚨 Can't transfer crypto right now.`);

      const targetId = await getTargetId(conn, mek, args, 0);
      const coin     = (args[1] || '').toUpperCase();
      const amount   = parseFloat(args[2]);

      if (!targetId || !coin || !amount || amount <= 0) return reply([
          `🪙 *CRYPTO TRANSFER*`, ``,
          `Usage: *wirecrypto @player <coin> <amount>*`,
          `Example: wirecrypto @mark BTC 0.05`,
          ``,
          `Current coins: ${Object.keys(global.market||{}).join(', ')}`
      ].join('\n'));

      if (targetId === senderId) return reply(`You can't send crypto to yourself.`);
      if (!global.market?.[coin]) return reply(`❌ Unknown coin *${coin}*. Use *crypto* to see available coins.`);

      // Check sender's crypto balance
      const senderCrypto = acc.cryptoPortfolio instanceof Map
          ? acc.cryptoPortfolio
          : new Map(Object.entries(acc.cryptoPortfolio || {}));

      const owned = senderCrypto.get(coin) || 0;
      if (owned < amount) return reply(`❌ You only have *${owned.toFixed(6)} ${coin}*. Can't send ${amount}.`);

      // Deduct from sender
      senderCrypto.set(coin, owned - amount);
      acc.cryptoPortfolio = Object.fromEntries(senderCrypto);

      // Add to recipient
      const rec = await getAccount(targetId);
      const recCrypto = rec.cryptoPortfolio instanceof Map
          ? rec.cryptoPortfolio
          : new Map(Object.entries(rec.cryptoPortfolio || {}));
      recCrypto.set(coin, (recCrypto.get(coin) || 0) + amount);
      rec.cryptoPortfolio = Object.fromEntries(recCrypto);

      const usdValue = amount * (global.market[coin] || 0);
      logFinancial(acc, `Crypto sent: ${amount.toFixed(6)} ${coin} → @${targetId}`, -Math.floor(usdValue));
      logFinancial(rec, `Crypto received: ${amount.toFixed(6)} ${coin} ← @${senderId}`, Math.floor(usdValue));

      await saveAccount(acc);
      await saveAccount(rec);

      return conn.sendMessage(m.chat, {
          text: [
              `🪙 *CRYPTO SENT*`, ``,
              `Sent: *${amount.toFixed(6)} ${coin}*`,
              `To: @${targetId}`,
              `≈ ${fmtMoney(Math.floor(usdValue))} at current price`,
              ``,
              `Your ${coin} remaining: *${(owned - amount).toFixed(6)}*`
          ].join('\n'),
          mentions: [toJid(targetId)]
      }, { quoted: mek });
  } catch(e) { console.error('wirecrypto error', e); }
});

// =============================================================================
// PAYWITHCRYPTO — Pay a player in crypto (they must be online and accept)
// Usage: paycrypto @player <coin> <amount>
// =============================================================================
cast({ pattern: "paycrypto", desc: "paycrypto @player <coin> <amount> — Pay someone in crypto", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId = await getPlayerId(conn, m.sender);
      const acc      = await getAccount(senderId);

      const targetId = await getTargetId(conn, mek, args, 0);
      const coin     = (args[1] || '').toUpperCase();
      const amount   = parseFloat(args[2]);

      if (!targetId || !coin || !amount || amount <= 0)
          return reply(`Usage: *paycrypto @player <coin> <amount>*\nExample: paycrypto @mark ETH 0.1`);
      if (!global.market?.[coin]) return reply(`❌ Unknown coin. Use *crypto* to see coins.`);

      const senderCrypto = acc.cryptoPortfolio instanceof Map
          ? acc.cryptoPortfolio : new Map(Object.entries(acc.cryptoPortfolio||{}));
      const owned = senderCrypto.get(coin) || 0;
      if (owned < amount) return reply(`❌ You only have ${owned.toFixed(6)} ${coin}.`);

      // Direct transfer — no cooldown, no fee (crypto is instant)
      senderCrypto.set(coin, owned - amount);
      acc.cryptoPortfolio = Object.fromEntries(senderCrypto);

      const rec = await getAccount(targetId);
      const recCrypto = rec.cryptoPortfolio instanceof Map
          ? rec.cryptoPortfolio : new Map(Object.entries(rec.cryptoPortfolio||{}));
      recCrypto.set(coin, (recCrypto.get(coin)||0)+amount);
      rec.cryptoPortfolio = Object.fromEntries(recCrypto);

      const usdVal = Math.floor(amount * (global.market[coin]||0));
      logFinancial(acc, `Crypto payment: ${amount.toFixed(6)} ${coin} to @${targetId}`, -usdVal);
      logFinancial(rec, `Crypto payment received: ${amount.toFixed(6)} ${coin} from @${senderId}`, usdVal);

      await saveAccount(acc); await saveAccount(rec);

      return conn.sendMessage(m.chat, {
          text: [`💸 *CRYPTO PAYMENT*`,``,`${amount.toFixed(6)} *${coin}* → @${targetId}`,`≈ ${fmtMoney(usdVal)}`].join('\n'),
          mentions: [toJid(targetId)]
      }, { quoted: mek });
  } catch(e) { console.error('paycrypto error', e); }
});

cast({ pattern: "statement", desc: "View full financial statement — statement [page] | statement @player", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId   = await getPlayerId(conn, m.sender);
      const CREATOR_ID = '2348084644182';

      let id = senderId;
      let pageArg = 1;

      if (senderId === CREATOR_ID) {
          const targetId = await getTargetId(conn, mek, args, 0).catch(() => null);
          if (targetId && targetId !== senderId) {
              id = targetId;
              pageArg = parseInt(args[1]) || 1;
          } else {
              pageArg = parseInt(args[0]) || 1;
          }
      } else {
          pageArg = parseInt(args[0]) || 1;
      }

      const acc  = await getAccount(id);
      const hist = acc.financialHistory || [];

      if (hist.length === 0) {
          return reply([
              `📊 *Financial Statement*`,
              ``,
              `No transactions on record yet.`,
              `Every crime, job, purchase, attack, wire, tax, and investment is logged here.`
          ].join('\n'));
      }

      const PER_PAGE   = 20;
      const reversed   = [...hist].reverse(); // newest first
      const totalPages = Math.ceil(reversed.length / PER_PAGE);
      const page       = Math.max(1, Math.min(pageArg, totalPages));
      const slice      = reversed.slice((page-1)*PER_PAGE, page*PER_PAGE);

      // Calculate totals from full history
      let totalIn = 0, totalOut = 0;
      for (const entry of hist) {
          const match = entry.match(/([+-])\$([\d,]+)/);
          if (match) {
              const val = parseInt(match[2].replace(/,/g,''));
              if (match[1] === '+') totalIn  += val;
              else                  totalOut += val;
          }
      }

      const label = id === senderId ? (acc.username || `Player`) : `@${id}`;
      const lines = [
          `📊 *Financial Statement — ${label}*`,
          `💰 Balance: ${fmtMoney(acc.money)} | 🏦 Bank: ${fmtMoney(acc.bank||0)}`,
          `📈 Total in: ${fmtMoney(totalIn)} | 📉 Total out: ${fmtMoney(totalOut)}`,
          `_Page ${page}/${totalPages} — ${hist.length} entries (newest first)_`,
          ``,
          ...slice,
          ``,
          page < totalPages ? `_Next page: statement ${page+1}_` : `_Showing all entries_`
      ];

      return conn.sendMessage(m.chat, {
          text: lines.join('\n'),
          mentions: id !== senderId ? [toJid(id)] : []
      }, { quoted: mek });
  } catch(e) { console.error('statement error', e); }
});

// LEADERBOARD
cast({ pattern: "econboard", desc: "Show economy leaderboard", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const db = await connectDB();
      // Filter: must have a username AND be registered AND not a child NPC
      const rows = await db.collection("weirdo_rpg").find({
          username: { $exists: true, $ne: null, $ne: "" },
          isChildNpc: { $ne: true },
          $or: [{ registered: true }, { level: { $gt: 1 } }, { money: { $gt: 0 } }]
      }).toArray();

      if (!rows || rows.length === 0) return reply("No registered players yet. Players join with *joinrpg*.");

      const scored = rows
        .map(r => ({ id: r._id, user: r.username, score: (r.money||0)+(r.bank||0) }))
        .filter(r => r.user && r.user !== r.id) // must have real username
        .sort((a,b) => b.score - a.score)
        .slice(0, 10);

      if (!scored.length) return reply("No ranked players yet.");

      const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
      let out = "🏆 *GLOBAL ECONOMY BOARD*\n_(Wallet + Bank)_\n\n";
      const ecMentions = [];

      for (let i=0; i<scored.length; i++) {
        ecMentions.push(toJid(scored[i].id));
        out += `${medals[i]} *${scored[i].user}* — ${fmtMoney(scored[i].score)}\n`;
      }
      return conn.sendMessage(m.chat, { text: out, mentions: ecMentions }, { quoted: mek });
  } catch(e) { console.error(e); }
});

// STASH
async function handleStashCmd(conn, mek, m, { reply }) {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      let invText = "Empty";
      if (acc.inventory) {
          const keys = Object.keys(acc.inventory).filter(k => acc.inventory[k] > 0);
          if (keys.length > 0) {
              invText = keys.map(k => `${k} x${acc.inventory[k]}`).join("\n");
          }
      }

      return reply(`🎒 *Your Stash:*\n\n${invText}`);
  } catch(e) { console.error(e); }
}
cast({ pattern: 'stash',   desc: 'View your inventory',          category: 'rpg', filename: __filename }, handleStashCmd);
cast({ pattern: 'econinv', desc: 'View inventory (alias: stash)', category: 'rpg', filename: __filename }, handleStashCmd);

// BAILOUT
cast({ pattern: "bailout", desc: "Bribe cops to reduce prison time", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      if (!acc.jailedUntil || acc.jailedUntil <= now()) return reply("You're not in jail.");
      // Distinguish jail vs hospital
      if (!acc.inJail) return reply(`🏥 You're in *hospital*, not jail. Use *paymeds* or *callnurse @friend* instead.`);

      const remaining   = acc.jailedUntil - now();
      // Flat $500 per minute — affordable for everyone regardless of level
      const costPerMin  = iC(500);
      const maxReduceMs = Math.floor(remaining * 0.60);
      const maxReduceMin = Math.ceil(maxReduceMs / 60000);
      const maxCost     = costPerMin * maxReduceMin;

      const amount = parseInt(args[0]||"0");
      if (isNaN(amount) || amount <= 0) return reply([
          `⛓️ *IN JAIL* — ${msToTime(remaining)}`,
          ``,
          `*Bribe Cops:* bailout <amount>`,
          `   Rate: *${fmtMoney(costPerMin)}/minute*`,
          `   Max reduction: 60% of sentence`,
          `   Full 60% bail: *${fmtMoney(maxCost)}*`,
          ``,
          `Tip: *jailwork* (free, -20min×3), *lawyercall* (50% off), *callawyer @friend* (law degree helps), *helpbailout @friend* (they pay for you)`
      ].join('\n'));

      if (acc.money < amount) return reply(`Not enough cash. You have ${fmtMoney(acc.money)}.`);

      const minsReduced  = Math.floor(amount / costPerMin);
      const actualReduce = Math.min(minsReduced * 60 * 1000, maxReduceMs);
      if (actualReduce <= 0) return reply(`Minimum bribe is ${fmtMoney(costPerMin)} (removes 1 minute).`);

      const actualCost = Math.ceil(actualReduce / 60000) * costPerMin;
      acc.money -= actualCost;
      acc.jailedUntil = Math.max(now(), acc.jailedUntil - actualReduce);
      if (acc.jailedUntil <= now()) acc.inJail = false;
      logFinancial(acc, `⛓️ Bail paid (${Math.ceil(actualReduce/60000)} min)`, -actualCost);
      await saveAccount(acc);
      if (acc.jailedUntil <= now()) {
          return reply(`🚔 Paid *${fmtMoney(actualCost)}*. Cops released you — free!`);
      } else {
          return reply(`🚔 Paid *${fmtMoney(actualCost)}*. Remaining: *${msToTime(acc.jailedUntil - now())}*`);
      }
  } catch(e) { console.error(e); }
});

// PAY MEDS
cast({ pattern: "paymeds", desc: "Pay private docs to heal instantly", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      if (!acc.jailedUntil || acc.jailedUntil <= now()) return reply("You're not in hospital.");
      if (acc.inJail) return reply(`⛓️ You're in *jail*, not hospital. Use *bailout* or *callawyer @friend* instead.`);

      const remaining = acc.jailedUntil - now();
      const lvl = acc.level || 1;
      // Hospital: $10k × level per minute (reasonable)
      const medCostPerMin = iC(10000) * lvl;
      const maxMedReduce  = Math.floor(remaining * 0.60);
      const maxMedMin     = Math.ceil(maxMedReduce / 60000);
      const maxMedCost    = medCostPerMin * maxMedMin;

      const amount = parseInt(args[0]||"0");
      if (isNaN(amount) || amount <= 0) return reply([
          `🏥 *IN HOSPITAL* — ${msToTime(remaining)}`,
          ``,
          `*Private Medical Discharge:* paymeds <amount>`,
          `   Rate: *${fmtMoney(medCostPerMin)}/minute* (Level ${lvl})`,
          `   Max reduction: 60% of sentence`,
          `   Full 60% discharge: *${fmtMoney(maxMedCost)}*`,
          ``,
          `_Cheaper alternatives: use medkits to restore HP, or wait it out._`
      ].join('\n'));

      if (acc.money < amount) return reply(`Not enough cash. You have ${fmtMoney(acc.money)}.`);

      const medMinsReduced = Math.floor(amount / medCostPerMin);
      const actualMedReduce = Math.min(medMinsReduced * 60 * 1000, maxMedReduce);
      if (actualMedReduce <= 0) return reply(`Minimum payment is ${fmtMoney(medCostPerMin)} (removes 1 minute).`);

      const actualMedCost = Math.ceil(actualMedReduce / 60000) * medCostPerMin;
      acc.money -= actualMedCost;
      acc.jailedUntil = Math.max(now(), acc.jailedUntil - actualMedReduce);

      if (acc.jailedUntil <= now()) {
          acc.health = Math.min(acc.maxHealth || 100, (acc.health || 1) + 30);
          acc.inJail = false;
          await saveAccount(acc);
          return reply(`🏥 Paid *${fmtMoney(actualMedCost)}*. You've been discharged. Partially healed (+30 HP).`);
      } else {
          await saveAccount(acc);
          return reply(`🏥 You paid ${fmtMoney(amount)}. Remaining recovery time: ${msToTime(acc.jailedUntil - now())}`);
      }
  } catch(e) { console.error(e); }
});

// GANG ROB — Organised crime: multiple players gang up on one target, split loot
// Usage: gangrob @target   — initiates or joins an active gang rob in your city
// How it works:
//   • First person to run gangrob @target opens a 3-minute window
//   • Anyone in the same city can join within that window (max 5 attackers)
//   • After 3 min (or when 5 members join) the creator runs  gangrob go  to execute
//   • Combined attacker power is pooled — easy to overpower even strong targets
//   • Loot split equally after VAT; each participant heat +10
// global.gangRobSessions is shared with torn.js tick via global — DO NOT redeclare
if (!global.gangRobSessions) global.gangRobSessions = new Map();

cast({ pattern: "gangrob", desc: "gangrob @target | gangrob go — Organised mugging", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId  = await getPlayerId(conn, m.sender);
      const senderAcc = await getAccount(senderId);
      const from      = m.chat;

      if (isHospitalized(senderAcc)) return reply(`🚨 You're hospitalized. Can't gang rob.`);
      if (isKidnapped(senderAcc))    return reply(`🔒 You're kidnapped.`);
      if (isInFlight(senderAcc))     return reply(`✈️ You're in-flight.`);

      const subCmd = (args[0] || '').toLowerCase();

      // ── EXECUTE: gangrob go ───────────────────────────────────────────────
      if (subCmd === 'go') {
          // Find session where this sender is the organiser (first in list)
          let session = null, sessionTargetId = null;
          for (const [tid, s] of global.gangRobSessions.entries()) {
              if (s.attackers[0] === senderId) { session = s; sessionTargetId = tid; break; }
          }
          if (!session) return reply(`❌ You don't have an open gang rob session.\nStart one with: gangrob @target`);
          if (session.openUntil < now()) {
              global.gangRobSessions.delete(sessionTargetId);
              return reply(`⏰ Your gang rob session expired. Start a new one.`);
          }
          if (session.attackers.length < 2) return reply(`👥 Need at least 2 attackers. Wait for more to join.`);

          const victim = await getAccount(sessionTargetId);
          if (!victim.money || victim.money <= 100) {
              global.gangRobSessions.delete(sessionTargetId);
              return reply(`😂 Target is broke. Victim has nothing worth taking.`);
          }
          if (victim.robImmunityUntil && victim.robImmunityUntil > now()) {
              global.gangRobSessions.delete(sessionTargetId);
              return reply(`🛡️ *${victim.username || sessionTargetId}* just activated rob protection! Session cancelled.`);
          }

          // Pool all attacker power
          let totalAtkPower = 0;
          const attackerAccounts = [];
          for (const aid of session.attackers) {
              const a = await getAccount(aid);
              const g = getEconGearBonus(a);
              totalAtkPower += (a.strength || 3) + (a.speed || 3) + g.atkBonus + g.strBonus + g.spdBonus;
              attackerAccounts.push(a);
          }

          const vicGear  = getEconGearBonus(victim);
          const defPower = (victim.strength || 3) + (victim.defense || 3)
                         + vicGear.defBonus + vicGear.strBonus + vicGear.dexBonus
                         + (victim.equippedWeapon && (victim.ammo||0) > 0 ? 45 : victim.equippedWeapon ? 20 : 0);

          const ratio   = totalAtkPower / Math.max(1, defPower);
          // Pooled attackers get a generous success curve
          const chance  = Math.min(0.92, 0.40 + 0.25 * (ratio - 1));

          // Apply heat + cooldown to all attackers regardless of outcome
          for (const a of attackerAccounts) {
              a.crimeLevel = Math.min(100, (a.crimeLevel || 0) + 10);
              a.lastRob    = now();
          }

          global.gangRobSessions.delete(sessionTargetId);
          const mentions = session.attackers.map(toJid).concat([toJid(sessionTargetId)]);

          if (Math.random() < chance) {
              const pct        = 0.15 + Math.random() * 0.20; // 15–35% loot
              const totalGross = Math.floor(victim.money * pct);
              const { net: totalNet, vat } = applyVAT(totalGross);
              const perPerson  = Math.floor(totalNet / attackerAccounts.length);

              victim.money -= totalGross;
              logFinancial(victim, `Gang-robbed by ${attackerAccounts.length} players`, -totalGross);
              await saveAccount(victim);

              let resultLines = `🦹‍♂️ *GANG ROB SUCCESS!*\n👥 ${attackerAccounts.length} attackers vs @${sessionTargetId}\n\nStole ${fmtMoney(totalGross)} — VAT -${fmtMoney(vat)} = *${fmtMoney(totalNet)} net*\n💰 Each attacker gets: *${fmtMoney(perPerson)}*\n\n`;
              for (const a of attackerAccounts) {
                  a.money += perPerson;
                  a.crimesCommitted = (a.crimesCommitted || 0) + 1;
                  addTaxableIncome(a, perPerson);
                  logFinancial(a, `Gang rob cut vs @${sessionTargetId}`, perPerson);
                  await saveAccount(a);
                  resultLines += `• @${a._id}: +${fmtMoney(perPerson)}\n`;
              }
              return conn.sendMessage(from, { text: resultLines, mentions }, { quoted: mek });
          } else {
              // Failed — all attackers get fined / chance to be jailed
              let resultLines = `🚔 *GANG ROB BUSTED!*\n👮 The target called the cops on all of you!\n\n`;
              for (const a of attackerAccounts) {
                  if (Math.random() < 0.5) {
                      const fine = Math.min(a.money, 300 + Math.floor(Math.random() * 700));
                      a.money -= fine;
                      a.jailedUntil = now() + 10 * 60 * 1000;
                      resultLines += `• @${a._id}: Jailed 10min + fined ${fmtMoney(fine)}\n`;
                  } else {
                      const fine = Math.min(a.money, 100 + Math.floor(Math.random() * 300));
                      a.money -= fine;
                      resultLines += `• @${a._id}: Escaped but dropped ${fmtMoney(fine)}\n`;
                  }
                  await saveAccount(a);
              }
              return conn.sendMessage(from, { text: resultLines, mentions }, { quoted: mek });
          }
      }

      // ── INVITE CHILD: gangrob invitechild <childname> ────────────────────
      if (subCmd === 'invitechild') {
          const childName = (args[1] || '').toLowerCase();
          if (!childName) return reply(`Usage: *gangrob invitechild <childname>*\nInvites your activated child to join your active gang rob.`);

          // Find active session this player organised
          let mySession = null, myTargetId = null;
          for (const [tid, s] of global.gangRobSessions.entries()) {
              if (s.attackers[0] === senderId) { mySession = s; myTargetId = tid; break; }
          }
          if (!mySession) return reply(`❌ You don't have an open gang rob. Start one with: *gangrob @target*`);
          if (mySession.openUntil < now()) {
              global.gangRobSessions.delete(myTargetId);
              return reply(`⏰ Your session expired.`);
          }
          if (mySession.attackers.length >= 5) return reply(`👥 Crew is full (5/5).`);

          // Look up activated children of this player from torn.js Player model
          const mongoose = require('mongoose');
          const Player2  = mongoose.models.RPGPlayer;
          if (!Player2) return reply(`❌ Can't look up children right now.`);

          const parent = await Player2.findById(senderId).exec().catch(()=>null);
          if (!parent) return reply(`❌ Could not find your player record.`);

          const childRecord = (parent.children||[]).find(c =>
              c.activated && (c.childPid || c.playerId) &&
              (c.name||'').toLowerCase().includes(childName)
          );
          if (!childRecord) return reply(`❌ No activated child named "${args[1]}" found.\nUse *mychildren* to see your activated children and their names.`);

          const childId = childRecord.childPid || childRecord.playerId;
          if (mySession.attackers.includes(childId)) return reply(`✅ ${childRecord.name} is already in the crew.`);

          mySession.attackers.push(childId);
          return conn.sendMessage(from, {
              text: [`🤜 *${childRecord.name}* (your child) joined the gang rob!`, `👥 Crew: ${mySession.attackers.length}/5`, ``, `Run *gangrob go* when ready.`].join('\n'),
              mentions: [toJid(senderId)]
          }, { quoted: mek });
      }

      // ── JOIN: if there's an active session for this target, join it ───────
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage:\n• *gangrob @target* — start or join a gang rob\n• *gangrob invitechild <name>* — add your activated child\n• *gangrob go* — execute when ready (organiser only)`);
      if (targetId === senderId) return reply("You can't rob yourself.");

      const myCity     = normLoc(senderAcc.location);
      const victim2    = await getAccount(targetId);
      const victimCity = normLoc(victim2.location);
      if (myCity !== victimCity) {
          return reply(`🌍 Target is in *${victim2.location || 'Weirdos World'}* — you're in *${senderAcc.location || 'Weirdos World'}*. Travel there first.`);
      }

      // Check if there's an existing session for this target
      if (global.gangRobSessions.has(targetId)) {
          const s = global.gangRobSessions.get(targetId);
          if (s.openUntil < now()) {
              global.gangRobSessions.delete(targetId); // expired, start fresh below
          } else if (s.attackers.includes(senderId)) {
              return reply(`✅ You're already in this gang rob. Organiser runs *gangrob go* to execute.\n👥 Current crew: ${s.attackers.length}/5`);
          } else if (s.attackers.length >= 5) {
              return reply(`👥 That gang rob already has 5 attackers (max). Full crew.`);
          } else {
              s.attackers.push(senderId);
              return conn.sendMessage(from, {
                  text: `🤝 @${senderId} joined the gang rob against @${targetId}!\n👥 Crew: ${s.attackers.length}/5 | ${msToTime(s.openUntil - now())} left\n\nOrganiser (@${s.attackers[0]}): run *gangrob go* when ready.`,
                  mentions: [toJid(senderId), toJid(targetId), toJid(s.attackers[0])]
              }, { quoted: mek });
          }
      }

      // ── START: open a new session ─────────────────────────────────────────
      const COOLDOWN = 20 * 60 * 1000;
      if (now() - (senderAcc.lastRob || 0) < COOLDOWN)
          return reply(`⏳ Rob cooldown: ${msToTime(COOLDOWN - (now() - (senderAcc.lastRob||0)))} left.`);
      if (!victim2.money || victim2.money <= 100) return reply("Target is broke — nothing to steal.");

      global.gangRobSessions.set(targetId, {
          attackers: [senderId],
          openUntil: now() + 3 * 60 * 1000,
          from
      });

      // Auto-expire after 3 minutes
      setTimeout(async () => {
          const sess = global.gangRobSessions.get(targetId);
          if (!sess) return; // already executed
          global.gangRobSessions.delete(targetId);
          // Auto-execute if at least 2 attackers joined (organiser might be a child NPC)
          if (sess.attackers.length < 2) return;
          try {
              const victim = await getAccount(targetId);
              if (!victim || (victim.money||0) <= 100) return;
              let totalAtkPower = 0;
              const attackerAccounts = [];
              for (const aid of sess.attackers) {
                  const a = await getAccount(aid).catch(()=>null);
                  if (!a) continue;
                  const g = getEconGearBonus(a);
                  totalAtkPower += (a.strength||3)+(a.speed||3)+g.atkBonus+g.strBonus+g.spdBonus;
                  attackerAccounts.push(a);
              }
              if (!attackerAccounts.length) return;
              const vicGear = getEconGearBonus(victim);
              const defPow  = (victim.strength||3)+(victim.defense||3)+vicGear.defBonus+vicGear.strBonus;
              const chance  = Math.min(0.92, 0.40 + 0.25 * (totalAtkPower / Math.max(1, defPow) - 1));
              for (const a of attackerAccounts) { a.crimeLevel = Math.min(100,(a.crimeLevel||0)+10); a.lastRob = now(); }
              if (Math.random() < chance) {
                  const pct       = 0.15 + Math.random()*0.20;
                  const totalGross = Math.floor((victim.money||0) * pct);
                  const { net: totalNet, vat } = applyVAT(totalGross);
                  const perPerson = Math.floor(totalNet / attackerAccounts.length);
                  victim.money -= totalGross;
                  logFinancial(victim, `Gang-robbed (auto) by ${attackerAccounts.length} attackers`, -totalGross);
                  await saveAccount(victim);
                  for (const a of attackerAccounts) {
                      a.money = capBalance((a.money||0) + perPerson);
                      a.crimesCommitted = (a.crimesCommitted||0)+1;
                      addTaxableIncome(a, perPerson);
                      logFinancial(a, `Gang rob (auto) cut`, perPerson);
                      await saveAccount(a);
                  }
                  const names = attackerAccounts.map(a=>a.username||a._id).join(', ');
                  const msg = `🦹 *AUTO GANG ROB EXECUTED!*\n${names} robbed *${victim.username||targetId}*!\nStole *${fmtMoney(totalGross)}* → *${fmtMoney(perPerson)}* each`;
                  if (global.wwGameChat && global.wwConn) {
                      global.wwConn.sendMessage(global.wwGameChat, { text: msg }).catch(()=>{});
                  }
              } else {
                  for (const a of attackerAccounts) {
                      if (Math.random() < 0.4) { a.jailedUntil = now()+10*60*1000; a.inJail = true; }
                      await saveAccount(a);
                  }
              }
          } catch(autoErr) { console.error('gangrob auto-execute error:', autoErr); }
      }, 3 * 60 * 1000);

      return conn.sendMessage(from, {
          text: `🦹 *Gang Rob Initiated!*\n\nTarget: @${targetId} (in *${victim2.location || 'Weirdos World'}*)\n👥 Crew: 1/5\n⏳ Window: 3 minutes\n\n*Others in ${senderAcc.location || 'Weirdos World'} can join with:*\ngangrob @${targetId}\n\nOrganiser runs *gangrob go* when ready.`,
          mentions: [toJid(targetId)]
      }, { quoted: mek });

  } catch(e) { console.error('gangrob error', e); }
});

// TOGGLE DRAINS — Creator only: flip hourly economy drains on/off, persistent
// =============================================================================
// GANG ATTACK & DEFEND
// Usage: gangattack @target — start/join a gang attack on someone
//        gangattack go      — execute when ready (organiser only)
//        defend @player     — join the defence of someone being gang attacked
// How it works:
//   • Attacker opens a 3-min window. Others join with gangattack @target
//   • Defender and their allies join with defend @target
//   • On 'gangattack go': combined attacker power vs combined defender power
//   • Winner takes 15–30% of target's wallet. Losers get fined/jailed.
// =============================================================================
if (!global.gangAttackSessions) global.gangAttackSessions = new Map();

cast({ pattern: "gangattack", desc: "gangattack @target | gangattack go — Organised gang attack", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId  = await getPlayerId(conn, m.sender);
      const senderAcc = await getAccount(senderId);
      const from      = m.chat;

      if (isHospitalized(senderAcc)) return reply(`🚨 You're hospitalized. Can't attack.`);
      if (isKidnapped(senderAcc))    return reply(`🔒 You're kidnapped.`);
      if (isInFlight(senderAcc))     return reply(`✈️ You're in-flight.`);

      const subCmd = (args[0] || '').toLowerCase();

      // ── EXECUTE ───────────────────────────────────────────────────────────
      if (subCmd === 'go') {
          let session = null, sessionTargetId = null;
          for (const [tid, s] of global.gangAttackSessions.entries()) {
              if (s.attackers[0] === senderId) { session = s; sessionTargetId = tid; break; }
          }
          if (!session) return reply(`❌ You don't have an open gang attack. Start one: gangattack @target`);
          if (session.openUntil < now()) { global.gangAttackSessions.delete(sessionTargetId); return reply(`⏰ Session expired.`); }
          if (session.attackers.length < 2) return reply(`👥 Need at least 2 attackers. Wait for others to join.`);

          const victim = await getAccount(sessionTargetId);
          if (!victim.money || victim.money <= 100) { global.gangAttackSessions.delete(sessionTargetId); return reply(`😂 Target is broke. Nothing worth taking.`); }

          // Load all accounts
          const attackerAccs = await Promise.all(session.attackers.map(id => getAccount(id)));
          const defenderAccs = await Promise.all(session.defenders.map(id => getAccount(id)));

          // Calculate total power for each side
          function calcPower(accs) {
              return accs.reduce((total, a) => {
                  const lm  = 1 + ((a.level || 1) - 1) * 0.08;
                  const g   = getEconGearBonus(a);
                  const pet = getPetBonus(a);
                  return total + ((a.strength||3)*0.45 + (a.dexterity||3)*0.25 + (a.speed||3)*0.20 + (a.defense||3)*0.10 + g.atkBonus + g.strBonus + (pet.strBonus||0) + (pet.spdBonus||0)) * lm;
              }, 0);
          }

          const atkPower = calcPower(attackerAccs);
          const defPower = calcPower([victim, ...defenderAccs]);
          const ratio    = atkPower / Math.max(1, defPower);
          // ±15% RNG
          const atkRoll  = atkPower * (0.85 + Math.random() * 0.30);
          const defRoll  = defPower * (0.85 + Math.random() * 0.30);
          const atkWon   = atkRoll > defRoll;

          global.gangAttackSessions.delete(sessionTargetId);
          const mentions = [...session.attackers, ...session.defenders, sessionTargetId].map(toJid);

          const powerBar = (pow, total) => { const n = Math.min(10, Math.round((pow/Math.max(1,total))*10)); return '█'.repeat(n)+'░'.repeat(10-n); };
          const total = atkPower + defPower;

          let resultLines = [
              `⚔️ *GANG ATTACK — RESULT*`,
              ``,
              `🔴 *Attackers* (${session.attackers.length}) — Power: ${Math.floor(atkPower).toLocaleString()}  ${powerBar(atkPower, total)}`,
              `🔵 *Defenders* (${session.defenders.length+1}) — Power: ${Math.floor(defPower).toLocaleString()}  ${powerBar(defPower, total)}`,
              ``,
          ];

          if (atkWon) {
              const pct      = 0.15 + Math.random() * 0.15;
              const gross    = Math.floor(victim.money * pct);
              const { net, vat } = applyVAT(gross);
              const perPerson = Math.floor(net / attackerAccs.length);
              victim.money  -= gross;
              logFinancial(victim, `Gang attacked by ${attackerAccs.length} players`, -gross);
              await saveAccount(victim);
              for (const a of attackerAccs) {
                  a.money += perPerson;
                  a.crimeLevel = Math.min(100, (a.crimeLevel||0) + 15);
                  a.crimesCommitted = (a.crimesCommitted||0) + 1;
                  logFinancial(a, `Gang attack cut vs @${sessionTargetId}`, perPerson);
                  await saveAccount(a);
              }
              resultLines.push(`🏆 *ATTACKERS WIN!*`);
              resultLines.push(`💰 Looted ${fmtMoney(gross)} — VAT -${fmtMoney(vat)} = *${fmtMoney(net)} net*`);
              resultLines.push(`💵 Each attacker gets: *${fmtMoney(perPerson)}*`);
              if (defenderAccs.length > 0) resultLines.push(`🛡️ Defenders fought bravely but couldn't hold them off.`);
          } else {
              resultLines.push(`🛡️ *DEFENCE HOLDS!*`);
              resultLines.push(defenderAccs.length > 0 ? `@${sessionTargetId} and their allies repelled the attack!` : `@${sessionTargetId} held their ground alone!`);
              // Attackers get fined/jailed
              for (const a of attackerAccs) {
                  const fine = Math.min(a.money, 300 + Math.floor(Math.random()*700));
                  a.money -= fine;
                  if (Math.random() < 0.5) a.jailedUntil = now() + 10*60*1000;
                  a.crimeLevel = Math.min(100, (a.crimeLevel||0) + 20);
                  logFinancial(a, `Gang attack failed — fined`, -fine);
                  await saveAccount(a);
              }
              resultLines.push(`💸 All attackers fined and some jailed.`);
          }

          return conn.sendMessage(from, { text: resultLines.join('\n'), mentions }, { quoted: mek });
      }

      // ── START / JOIN ──────────────────────────────────────────────────────
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage:\n• *gangattack @target* — start or join a gang attack\n• *gangattack go* — execute (organiser only)\n• *defend @player* — defend someone being attacked`);
      if (targetId === senderId) return reply(`You can't attack yourself.`);

      const myCity  = normLoc(senderAcc.location);
      const victim  = await getAccount(targetId);
      const vicCity = normLoc(victim.location);
      if (myCity !== vicCity) return reply(`🌍 Target is in *${vicCity}* — you're in *${myCity}*. Travel there first.`);
      if (!victim.money || victim.money <= 100) return reply(`Target is broke. Nothing worth taking.`);

      // Check if target is already being defended — can still attack them
      if (global.gangAttackSessions.has(targetId)) {
          const s = global.gangAttackSessions.get(targetId);
          if (s.openUntil < now()) { global.gangAttackSessions.delete(targetId); }
          else if (s.attackers.includes(senderId)) return reply(`✅ You're already in this attack. Organiser runs *gangattack go*.`);
          else if (s.attackers.length >= 5) return reply(`👥 Attack crew is full (5/5).`);
          else {
              s.attackers.push(senderId);
              return conn.sendMessage(from, { text: `🔴 @${senderId} joined the gang attack on @${targetId}!\n👥 Attackers: ${s.attackers.length}/5 | Defenders: ${s.defenders.length}\n⏳ ${msToTime(s.openUntil - now())} left`, mentions: [toJid(senderId), toJid(targetId)] }, { quoted: mek });
          }
      }

      // Start new session
      const COOLDOWN = 20 * 60 * 1000;
      if (now() - (senderAcc.lastRob || 0) < COOLDOWN) return reply(`⏳ Rob cooldown: ${msToTime(COOLDOWN - (now()-(senderAcc.lastRob||0)))} left.`);

      global.gangAttackSessions.set(targetId, { attackers: [senderId], defenders: [], openUntil: now() + 3*60*1000, from });
      setTimeout(() => { global.gangAttackSessions.delete(targetId); }, 3*60*1000);

      return conn.sendMessage(from, {
          text: [`⚔️ *GANG ATTACK OPENED!*`, ``, `Target: @${targetId} (${vicCity})`, `👥 Attackers: 1/5 | 🛡️ Defenders: 0`, `⏳ 3-minute window`, ``, `*Join the attack:* gangattack @${targetId}`, `*Defend ${victim.username||targetId}:* defend @${targetId}`, ``, `Organiser runs *gangattack go* when ready.`].join('\n'),
          mentions: [toJid(targetId)]
      }, { quoted: mek });

  } catch(e) { console.error('gangattack error', e); }
});

cast({ pattern: "defend", desc: "defend @player — join someone's defence against a gang attack", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const senderId  = await getPlayerId(conn, m.sender);
      const senderAcc = await getAccount(senderId);
      const from      = m.chat;

      if (isHospitalized(senderAcc)) return reply(`🚨 You're hospitalized.`);
      if (isKidnapped(senderAcc))    return reply(`🔒 You're kidnapped.`);
      if (isInFlight(senderAcc))     return reply(`✈️ You're in-flight.`);

      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage: defend @player\n\nJoins the defence of a player being gang attacked.`);
      if (targetId === senderId) return reply(`You're already defending yourself by being the target.`);

      if (!global.gangAttackSessions.has(targetId)) return reply(`@${targetId} is not currently under a gang attack. Nothing to defend.`);
      const s = global.gangAttackSessions.get(targetId);
      if (s.openUntil < now()) { global.gangAttackSessions.delete(targetId); return reply(`The attack window expired.`); }

      const myCity  = normLoc(senderAcc.location);
      const victim  = await getAccount(targetId);
      if (myCity !== normLoc(victim.location)) return reply(`🌍 You need to be in the same city as @${targetId} to defend them.`);
      if (s.attackers.includes(senderId)) return reply(`You're already on the attacking side. Pick a side.`);
      if (s.defenders.includes(senderId)) return reply(`✅ You're already defending @${targetId}.`);
      if (s.defenders.length >= 5) return reply(`🛡️ Defence is full (5 defenders).`);

      s.defenders.push(senderId);

      return conn.sendMessage(from, {
          text: [`🛡️ *@${senderId} is defending @${targetId}!*`, ``, `🔴 Attackers: ${s.attackers.length} | 🛡️ Defenders: ${s.defenders.length}`, `⏳ ${msToTime(s.openUntil - now())} left`, ``, `_More can join: defend @${targetId}_`].join('\n'),
          mentions: [toJid(senderId), toJid(targetId)]
      }, { quoted: mek });
  } catch(e) { console.error('defend error', e); }
});

cast({ pattern: "toggledrains", desc: "[Creator] Toggle hourly economy drains on/off", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const senderId   = await getPlayerId(conn, m.sender);
      const CREATOR_ID = '2348084644182';
      if (senderId !== CREATOR_ID) return reply(`❌ Creator-only command.`);
      global.weirdo_drains_enabled = !global.weirdo_drains_enabled;
      await saveGameConfig(); // ← persist to DB so toggle survives restarts
      const on = global.weirdo_drains_enabled;
      return reply([
          `⚙️ *Economy Drains: ${on ? '✅ ON' : '❌ OFF'}*`,
          `_Saved to database — survives bot restarts_`,
          ``,
          on
              ? `All hourly drains are now active:\n• Property tax\n• Wealth tax\n• Gear maintenance\n• Faction dues\n• Hospital discharge fees`
              : `All hourly drains suspended.\nBalances will not be drained until toggled back on.`
      ].join('\n'));
  } catch(e) { console.error('toggledrains error', e); }
});

// ECON DRAINS INFO — Anyone can check drain status
cast({ pattern: "econdrains", desc: "Check all active drains and toggle status", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const senderId = await getPlayerId(conn, m.sender);
      const acc      = await getAccount(senderId);
      const total    = (acc.money || 0) + (acc.bank || 0);

      // Toggle status
      const drainsOn  = global.weirdo_drains_enabled !== false;
      const wealthOn  = global.wealth_drain_enabled  !== false;
      const taxOn     = global.weirdo_tax_enabled    !== false;

      // Calculate each drain (inflation-adjusted)
      let propTax = 0;
      for (const [pId, qty] of Object.entries(acc.properties || {})) {
          propTax += Math.ceil(iC(DEFAULT_PROP_PRICES[pId] || 0) * PROPERTY_TAX_RATE * (qty || 0));
      }
      let gearCost = 0;
      const gearBreakdown = [];
      for (const slot of ['equippedWeapon','equippedArmor','equippedHelmet','equippedGloves','equippedKneePads','equippedBoots']) {
          if (!acc[slot]) continue;
          const c = iC(GEAR_MAINTENANCE_BASE[getItemRarity(acc[slot])] || 200);
          gearCost += c;
          gearBreakdown.push(`${acc[slot]}: ${fmtMoney(c)}/hr`);
      }
      const wRate     = getWealthTaxRate(total);
      const wealthTax = wealthOn ? Math.ceil(total * wRate) : 0;
      const facDues   = acc.faction ? iC(FACTION_DUES_BASE) : 0;
      const loanInt   = acc.activeLoan?.owed > 0
          ? Math.ceil(acc.activeLoan.owed * (acc.activeLoan.ratePerHour || 0.010))
          : 0;

      const totalDrain = (drainsOn ? propTax + gearCost + facDues : 0) + wealthTax + loanInt;

      const lines = [
          `📊 *YOUR DRAIN STATUS*`, ``,
          `⚙️ Main drains (toggledrains):   ${drainsOn  ? '✅ ON' : '❌ OFF'}`,
          `💸 Wealth drain (togglewealthdrain): ${wealthOn ? '✅ ON' : '❌ OFF'}`,
          `🏛️ Tax / VAT (toggletax):        ${taxOn     ? '✅ ON' : '❌ OFF'}`,
          ``,
          `*Your costs (per hour):*`,
          drainsOn ? `🏠 Property tax:    ${fmtMoney(propTax)}/hr` : `🏠 Property tax:    SUSPENDED`,
          drainsOn ? `🔧 Gear maint:      ${fmtMoney(gearCost)}/hr${gearBreakdown.length ? `\n   (${gearBreakdown.join(', ')})` : ''}` : `🔧 Gear maint:      SUSPENDED`,
          `💸 Wealth tax (${(wRate*100).toFixed(1)}%): ${wealthOn ? fmtMoney(wealthTax)+'/hr' : 'SUSPENDED'}`,
          acc.faction ? (drainsOn ? `🏢 Faction dues:    ${fmtMoney(facDues)}/hr` : `🏢 Faction dues:    SUSPENDED`) : `🏢 Faction dues:    N/A (no faction)`,
          loanInt > 0 ? `🦈 Loan interest:   ${fmtMoney(loanInt)}/hr on ${fmtMoney(acc.activeLoan.owed)} owed` : null,
          ``,
          `💀 *Active total drain: ${fmtMoney(totalDrain)}/hr*`,
          acc.gearInsurance ? `🛡️ Gear Insurance: Active` : `❌ No gear insurance`
      ].filter(l => l !== null);

      return reply(lines.join('\n'));
  } catch(e) { console.error('econdrains error', e); }
});


// =============================================================================
// LOTTERY — Global jackpot. Buy tickets, creator draws a winner.
// =============================================================================
if (!global.lottoJackpot) global.lottoJackpot = iC(50000);
if (!global.lottoTickets) global.lottoTickets = {}; // { playerId: ticketCount }

cast({ pattern: "lotto", desc: "lotto buy [qty] | lotto draw | lotto status", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id      = await getPlayerId(conn, m.sender);
      const acc     = await getAccount(id);
      if (isHospitalized(acc)) return reply(`⛓️ Action blocked — you're in ${acc.inJail ? 'jail' : 'hospital'}. Serve your time first.`);
      const sub     = (args[0] || 'status').toLowerCase();
      const CREATOR = '2348084644182';
      const TICKET_PRICE = iC(1000);

      if (sub === 'status') {
          const myTickets = global.lottoTickets[id] || 0;
          const totalTickets = Object.values(global.lottoTickets).reduce((a,b) => a+b, 0);
          const myChance = totalTickets > 0 ? ((myTickets / totalTickets) * 100).toFixed(1) : '0.0';
          return reply([
              `🎟️ *WEIRDOS WORLD LOTTERY*`,
              ``,
              `💰 Jackpot: *${fmtMoney(global.lottoJackpot)}*`,
              `🎫 Total tickets sold: ${totalTickets}`,
              ``,
              `Your tickets: *${myTickets}* (${myChance}% win chance)`,
              `Ticket price: ${fmtMoney(TICKET_PRICE)} each`,
              ``,
              `Buy with: *lotto buy <qty>*`,
              `_Creator draws the winner with: lotto draw_`
          ].join('\n'));
      }

      if (sub === 'draw') {
          if (id !== CREATOR) return reply(`❌ Only the creator can draw the lottery.`);
          const entries = [];
          for (const [pid, qty] of Object.entries(global.lottoTickets)) {
              for (let i = 0; i < qty; i++) entries.push(pid);
          }
          if (entries.length === 0) return reply(`🎟️ No tickets sold yet — no draw possible.`);

          const winnerId = entries[Math.floor(Math.random() * entries.length)];
          const winner   = await getAccount(winnerId);
          const prize    = global.lottoJackpot;

          winner.money += prize;
          logFinancial(winner, `🎟️ Lottery jackpot won!`, prize);
          await saveAccount(winner);

          const oldJackpot = global.lottoJackpot;
          global.lottoJackpot = iC(50000); // reset
          global.lottoTickets = {};

          return conn.sendMessage(m.chat, {
              text: [
                  `🎉 *LOTTERY DRAW!*`,
                  ``,
                  `${entries.length} tickets in the drum...`,
                  ``,
                  `🏆 WINNER: @${winnerId} (*${winner.username || winnerId}*)`,
                  `💰 Prize: *${fmtMoney(prize)}*`,
                  ``,
                  `Jackpot resets to ${fmtMoney(global.lottoJackpot)}.`,
                  `Buy tickets for the next round: lotto buy <qty>`
              ].join('\n'),
              mentions: [toJid(winnerId)]
          }, { quoted: mek });
      }

      if (sub === 'buy') {
          if (isHospitalized(acc)) return reply(`🚨 Can't buy tickets from jail/hospital.`);
          if (isKidnapped(acc))    return reply(`🔒 You're kidnapped. Escape first.`);
          const qty = Math.max(1, Math.min(100, parseInt(args[1]) || 1));
          const cost = TICKET_PRICE * qty;
          if (acc.money < cost) return reply(`Not enough cash. ${qty} ticket(s) = ${fmtMoney(cost)}. You have ${fmtMoney(acc.money)}.`);
          acc.money -= cost;
          acc.moneySpent = (acc.moneySpent || 0) + cost;
          logFinancial(acc, `Lottery tickets x${qty}`, -cost);
          await saveAccount(acc);
          global.lottoTickets[id] = (global.lottoTickets[id] || 0) + qty;
          global.lottoJackpot += Math.floor(cost * 0.8); // 80% of sales go to jackpot
          const total = global.lottoTickets[id];
          const allTickets = Object.values(global.lottoTickets).reduce((a,b) => a+b, 0);
          return reply([
              `🎟️ Bought *${qty} ticket(s)* for ${fmtMoney(cost)}`,
              `Your total: ${total} tickets (${((total/allTickets)*100).toFixed(1)}% chance)`,
              `Jackpot now: *${fmtMoney(global.lottoJackpot)}*`
          ].join('\n'));
      }

      return reply(`Usage: lotto status | lotto buy <qty> | lotto draw (creator)`);
  } catch(e) { console.error('lotto error', e); }
});

// =============================================================================
// SMUGGLE — Run contraband from your current location back to Weirdos World
// Can only be done when NOT already at Weirdos World. High risk, high reward.
// =============================================================================
cast({ pattern: "smuggle", desc: "Run contraband for a big payout (not in Weirdos World)", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      if (isHospitalized(acc)) return reply(`🚨 You're locked up. Can't smuggle.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped. Escape first.`);
      if (isInFlight(acc))     return reply(`✈️ You're in-flight. Wait until you land.`);

      const city = normLoc(acc.location).toLowerCase();
      if (city === 'weirdos world') {
          return reply([
              `🚫 *Smuggling requires you to be abroad.*`,
              ``,
              `Travel to Mexico, London, Japan, or Switzerland first.`,
              `Then run *smuggle* to carry contraband back to Weirdos World.`
          ].join('\n'));
      }

      const COOLDOWN = 45 * 60 * 1000;
      const last = acc.cooldowns?.smuggle || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Lay low for ${msToTime(COOLDOWN - (now()-last))} before smuggling again.`);

      // Reward scales with how far the city is
      const cityTiers = { mexico: 1, london: 2, japan: 3, switzerland: 4 };
      const tier = cityTiers[city] || 1;
      const baseReward = iC(2500) * tier;
      const failChance = 0.45 + (tier * 0.05); // harder cities = riskier

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.smuggle = now();
      acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 20);

      if (Math.random() > failChance) {
          const reward = Math.floor(baseReward + Math.random() * baseReward);
          const { net, vat } = applyVAT(reward);
          acc.money = capBalance((acc.money||0) + net);
          addTaxableIncome(acc, net);
          logFinancial(acc, `Smuggling run from ${acc.location}`, net);
          await saveAccount(acc);
          return reply([
              `🧳 *SMUGGLE SUCCESSFUL!*`,
              ``,
              `You slipped through customs with a hot shipment from *${acc.location}*.`,
              `💰 Gross: ${fmtMoney(reward)} — VAT: -${fmtMoney(vat)} = *${fmtMoney(net)} net*`,
              `⚠️ Crime heat +20`,
              ``,
              `_You're still in ${acc.location}. Travel home when ready._`
          ].join('\n'));
      } else {
          const fine = Math.min(acc.money, iC(5000) * tier + Math.floor(Math.random() * iC(5000)));
          const jailTime = (10 + tier * 5) * 60 * 1000;
          acc.money -= fine;
          acc.jailedUntil = now() + jailTime;
          acc.health = Math.max(0, (acc.health || 100) - 15);
          logFinancial(acc, `Caught smuggling — fined`, -fine);
          await saveAccount(acc);
          return reply([
              `🚔 *BUSTED AT CUSTOMS!*`,
              ``,
              `Border patrol found your stash.`,
              `💸 Fine: ${fmtMoney(fine)}`,
              `⛓️ Jailed: ${msToTime(jailTime)}`,
              `❤️ -15 HP`,
              ``,
              `Use *bailout* to bribe your way out early.`
          ].join('\n'));
      }
  } catch(e) { console.error('smuggle error', e); }
});

// =============================================================================
// HITMAN — Pay to have an NPC crew jail your target for a while
// =============================================================================
cast({ pattern: "hitman", desc: "hitman @player — pay to have someone jailed", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id       = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage: hitman @player\n\nPay a crew to go after someone and put them in hospital.`);
      if (targetId === id) return reply(`You can't send a hitman after yourself.`);

      const acc    = await getAccount(id);
      const target = await getAccount(targetId);

      if (isHospitalized(acc)) return reply(`🚨 You're locked up.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const COST     = iC(50000);
      const COOLDOWN = 60 * 60 * 1000;
      const last     = acc.cooldowns?.hitman || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Your hitman crew needs ${msToTime(COOLDOWN - (now()-last))} to cool off.`);
      if (acc.money < COST) return reply(`💸 Hiring a hitman costs *${fmtMoney(COST)}*. You have ${fmtMoney(acc.money)}.`);

      acc.money -= COST;
      acc.moneySpent = (acc.moneySpent || 0) + COST;
      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.hitman = now();
      acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 25);

      const SUCCESS_CHANCE = 0.65;
      if (Math.random() < SUCCESS_CHANCE) {
          // Hit lands
          const dmg      = 20 + Math.floor(Math.random() * 30);
          const jailTime = (15 + Math.floor(Math.random() * 20)) * 60 * 1000;
          target.health     = Math.max(0, (target.health || 100) - dmg);
          target.jailedUntil = Math.max(target.jailedUntil || 0, now() + jailTime);
          logFinancial(acc, `Hired hitman vs @${targetId}`, -COST);
          await saveAccount(acc);
          await saveAccount(target);
          return conn.sendMessage(m.chat, {
              text: [
                  `🔫 *HIT CONFIRMED*`,
                  ``,
                  `Your crew tracked down @${targetId}.`,
                  `❤️ They took ${dmg} damage`,
                  `⛓️ Hospitalised for ${msToTime(jailTime)}`,
                  ``,
                  `💸 You paid: ${fmtMoney(COST)}`
              ].join('\n'),
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      } else {
          // Hit failed — target spotted your crew, you get heat
          acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 20);
          logFinancial(acc, `Hitman failed vs @${targetId} — fee lost`, -COST);
          await saveAccount(acc);
          return conn.sendMessage(m.chat, {
              text: [
                  `❌ *HIT FAILED*`,
                  ``,
                  `@${targetId} spotted your crew and tipped off police.`,
                  `💸 Fee lost: ${fmtMoney(COST)}`,
                  `⚠️ Your crime heat spiked +45`,
                  ``,
                  `Watch your back.`
              ].join('\n'),
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      }
  } catch(e) { console.error('hitman error', e); }
});

// =============================================================================
// LOAN SHARK — Borrow money at 30% interest. Unpaid loans auto-deduct on login.
// =============================================================================
// LOAN SHARK — Borrow money. Interest compounds every 5 minutes.
// After 30 min unpaid the shark starts taking from your wallet automatically.
// loan take <amount> | loan pay <amount> | loan status
// =============================================================================
cast({ pattern: "loan", desc: "loan take <amount> | loan pay <amount> | loan status", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const sub = (args[0] || 'status').toLowerCase();
      // Credit score: simple inline calc (mirrors torn.js getCreditScore)
      const _total  = (acc.money||0) + (acc.bank||0);
      const _heat   = acc.crimeLevel || 0;
      const _lvl    = acc.level || 1;
      const _deaths = acc.deathCount || 0;
      let _score    = 580;
      if (_total >= 10_000_000) _score += 80;
      else if (_total >= 1_000_000) _score += 50;
      else if (_total >= 100_000) _score += 20;
      else if (_total < 1000) _score -= 50;
      if (_heat >= 75) _score -= 100; else if (_heat >= 50) _score -= 60; else if (_heat >= 25) _score -= 30; else if (_heat === 0) _score += 30;
      if ((acc.taxOwed||0) > 1_000_000) _score -= 80; else if ((acc.taxOwed||0) > 100_000) _score -= 40; else if ((acc.taxPaid||0) > 500_000) _score += 40;
      if (_lvl >= 50) _score += 50; else if (_lvl >= 20) _score += 25; else if (_lvl < 5) _score -= 20;
      if (_deaths >= 3) _score -= 60; else if (_deaths >= 1) _score -= 20;
      _score = Math.min(850, Math.max(300, _score));
      const MAX_LOAN      = _score >= 750 ? iC(2_000_000) : _score >= 680 ? iC(1_000_000) : _score >= 580 ? iC(500_000) : _score >= 480 ? iC(200_000) : iC(50_000);
      const RATE_PER_HOUR_ADJ = _score >= 750 ? 0.005 : _score >= 680 ? 0.008 : _score >= 580 ? 0.010 : _score >= 480 ? 0.012 : 0.015;
      const RATE_DISPLAY  = `${(RATE_PER_HOUR_ADJ*100).toFixed(1)}%/hr`;

      // Loan is already compounded by getAccount — just read it directly
      const loan = acc.activeLoan && acc.activeLoan.owed > 0 ? acc.activeLoan : null;

      if (sub === 'status') {
          if (!loan || loan.owed <= 0) return reply([
              `🦈 *LOAN SHARK*`,
              ``,
              `No outstanding debt. Good.`,
              ``,
              `Borrow up to ${fmtMoney(MAX_LOAN)} | Rate: ${RATE_DISPLAY} (Credit score: ${_score}/850)`,
              `⏳ 2hr grace period — no interest charged in first 2 hours`,
              `⚠️ After 6 hours overdue: shark takes 20% of wallet+bank`,
              `Usage: *loan take <amount>*`
          ].join('\n'));

          const age       = now() - (loan.takenAt || 0);
          const rateDisp  = loan.ratePerHour ? `${(loan.ratePerHour*100).toFixed(1)}%/hr` : '1%/hr';
          const inGrace   = age < 2*60*60*1000;
          const growthPct = ((loan.owed / loan.principal - 1) * 100).toFixed(1);
          const projNext1h = Math.ceil(loan.owed * (1 + (loan.ratePerHour || 0.010)));
          const projNext6h = Math.ceil(loan.owed * Math.pow(1 + (loan.ratePerHour || 0.010), 6));

          return reply([
              `🦈 *YOUR DEBT*`,
              ``,
              `📋 Original loan: ${fmtMoney(loan.principal)}`,
              `💀 Currently owed: *${fmtMoney(loan.owed)}*${parseFloat(growthPct) > 0 ? ` (+${growthPct}%)` : ''}`,
              `⏱️ Taken: ${msToTime(age)} ago`,
              inGrace ? `⏳ *Grace period active* — interest starts in ${msToTime(2*60*60*1000 - age)}` : ``,
              ``,
              `📈 Rate: *${rateDisp}* (compounding hourly)`,
              `   If unpaid — in 1hr: ~${fmtMoney(projNext1h)} | in 6hr: ~${fmtMoney(projNext6h)}`,
              ``,
              `Pay now: *loan pay <amount>*`,
              `Pay all: *loan pay all*`
          ].filter(s => s !== '').join('\n'));
      }

      if (sub === 'take') {
          if (loan && loan.owed > 0) return reply(`🦈 Pay off your existing debt of *${fmtMoney(loan.owed)}* first.\nUse: *loan pay <amount>*`);
          if (isHospitalized(acc)) return reply(`🚨 Loan shark doesn't deal with inmates.`);
          const amount = parseInt(args[1]);
          if (!amount || amount <= 0) return reply(`Usage: loan take <amount>\nMax: ${fmtMoney(MAX_LOAN)}`);
          if (amount > MAX_LOAN) return reply(`Max loan is ${fmtMoney(MAX_LOAN)}.`);

          // Determine rate from credit score (mirrors getAccount logic)
          const hourlyRate = _score >= 750 ? 0.005 : _score >= 680 ? 0.008 : _score >= 580 ? 0.010 : _score >= 480 ? 0.012 : 0.015;
          // Project balances (2hr grace — interest starts after grace period)
          const proj6h  = Math.ceil(amount * Math.pow(1 + hourlyRate, 4));   // 6h - 2h grace = 4h interest
          const proj24h = Math.ceil(amount * Math.pow(1 + hourlyRate, 22));  // 24h - 2h grace = 22h interest
          const proj72h = Math.ceil(amount * Math.pow(1 + hourlyRate, 70));  // 3d - 2h grace = 70h interest

          acc.money = capBalance((acc.money||0) + amount);
          acc.activeLoan = {
              principal:    amount,
              owed:         amount,         // no initial markup — grace period covers first 2h
              takenAt:      now(),
              lastCompound: now() + (2 * 60 * 60 * 1000), // interest clock starts after 2hr grace
              creditScore:  _score,
              ratePerHour:  hourlyRate,
              lastAutoDeduct: 0,
          };
          logFinancial(acc, `Shark loan: ${fmtMoney(amount)} at ${(hourlyRate*100).toFixed(1)}%/hr`, amount);
          await saveAccount(acc);
          return reply([
              `🦈 *LOAN APPROVED*`,
              ``,
              `💵 Borrowed: *${fmtMoney(amount)}*`,
              `📊 Credit score: ${_score}/850 → Rate: *${(hourlyRate*100).toFixed(1)}%/hr*`,
              ``,
              `⏳ *2-hour grace period* — no interest until then`,
              `📈 Projections if unpaid:`,
              `   After 6 hours:  ~${fmtMoney(proj6h)}`,
              `   After 24 hours: ~${fmtMoney(proj24h)}`,
              `   After 3 days:   ~${fmtMoney(proj72h)}`,
              ``,
              `🦈 Shark takes 20% of wallet+bank every 6hr if overdue.`,
              `Pay now: *loan pay all*  |  Check: *loan status*`
          ].join('\n'));
      }

      if (sub === 'pay') {
          if (!loan || loan.owed <= 0) return reply(`You have no outstanding loan.`);
          const payAll = (args[1] || '').toLowerCase() === 'all';
          const amount = payAll ? Math.min(acc.money, loan.owed) : parseInt(args[1]);
          if (!amount || amount <= 0) return reply(`Usage: loan pay <amount> | loan pay all\nYou owe: ${fmtMoney(loan.owed)}`);
          const pay = Math.min(amount, loan.owed, acc.money);
          if (pay <= 0) return reply(`You don't have enough cash. You owe ${fmtMoney(loan.owed)}.`);

          acc.money -= pay;
          acc.moneySpent = (acc.moneySpent || 0) + pay;
          loan.owed -= pay;

          if (loan.owed <= 0) {
              acc.activeLoan = null;
              logFinancial(acc, `Loan fully repaid`, -pay);
              await saveAccount(acc);
              return reply(`🦈 *DEBT CLEARED!* Paid ${fmtMoney(pay)}. You're free. Don't come back.`);
          }

          // Save updated loan with compounded values
          acc.activeLoan = loan;
          logFinancial(acc, `Loan partial payment`, -pay);
          await saveAccount(acc);
          return reply(`🦈 Paid ${fmtMoney(pay)}. Remaining debt: *${fmtMoney(loan.owed)}* (still growing)`);
      }

      return reply(`Usage: loan status | loan take <amount> | loan pay <amount|all>`);
  } catch(e) { console.error('loan error', e); }
});

// =============================================================================
// PROTECT — Pay for temporary immunity from rob and gang rob attacks
// =============================================================================
cast({ pattern: "robshield", desc: "Buy temporary rob immunity for 2 hours", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      if (isHospitalized(acc)) return reply(`🚨 You're in hospital/jail.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const COST     = iC(15000);
      const DURATION = 2 * 60 * 60 * 1000; // 2 hours

      const existing = acc.robImmunityUntil || 0;
      if (existing > now()) {
          return reply([
              `🛡️ *Protection already active!*`,
              `Expires in: ${msToTime(existing - now())}`,
              ``,
              `You are immune to rob and gang rob until then.`
          ].join('\n'));
      }

      if (acc.money < COST) return reply(`💸 Protection costs *${fmtMoney(COST)}* for 2 hours. You have ${fmtMoney(acc.money)}.`);

      acc.money -= COST;
      acc.moneySpent = (acc.moneySpent || 0) + COST;
      acc.robImmunityUntil = now() + DURATION;
      logFinancial(acc, `Rob protection purchased (2h)`, -COST);
      await saveAccount(acc);

      return reply([
          `🛡️ *PROTECTION ACTIVE*`,
          ``,
          `Cost: ${fmtMoney(COST)}`,
          `Duration: 2 hours`,
          `Expires: ${new Date(acc.robImmunityUntil).toLocaleTimeString()}`,
          ``,
          `You are now immune to rob and gang rob attacks.`
      ].join('\n'));
  } catch(e) { console.error('protect error', e); }
});


// =============================================================================
// CARWASH — Launder dirty crime money. Converts crimeLevel heat into clean cash.
// The higher your heat, the bigger the laundry job — but it costs a 20% cut.
// =============================================================================
cast({ pattern: "carwash", desc: "Launder dirty money (costs 20% cut)", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 You're locked up.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const heat = acc.crimeLevel || 0;
      if (heat < 10) return reply([
          `🚗 *Weirdos World Car Wash*`,
          ``,
          `You need at least 10 crime heat to launder.`,
          `Your current heat: ${heat}/100`,
          ``,
          `Commit crimes to build up heat, then come back.`
      ].join('\n'));

      const COOLDOWN = 30 * 60 * 1000;
      const last = acc.cooldowns?.carwash || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ The car wash needs ${msToTime(COOLDOWN - (now()-last))} to dry.`);

      const amount = parseInt(args[0]);
      if (!amount || amount <= 0) {
          const maxLaunder = Math.floor(acc.money * (heat / 100));
          return reply([
              `🚗 *WEIRDOS WORLD CAR WASH*`,
              `_We make your money sparkle clean._`,
              ``,
              `Your heat: 🔴 ${heat}/100`,
              `Max launderable (heat-based): *${fmtMoney(maxLaunder)}*`,
              `Cut: 20% goes to the house`,
              ``,
              `Usage: *carwash <amount>*`
          ].join('\n'));
      }

      const maxLaunder = Math.floor(acc.money * (heat / 100));
      if (amount > maxLaunder) return reply(`🚗 Too hot to launder that much. Max at current heat: ${fmtMoney(maxLaunder)}`);
      if (amount > acc.money)  return reply(`Not enough cash.`);

      const cut  = Math.ceil(amount * 0.20);
      const net  = amount - cut;
      const heatReduced = Math.floor(heat * (amount / Math.max(1, acc.money)) * 2);

      acc.money -= cut; // cut is gone — house takes it
      acc.crimeLevel = Math.max(0, heat - heatReduced);
      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.carwash = now();
      logFinancial(acc, `Car wash laundry (-${fmtMoney(cut)} cut)`, -cut);
      await saveAccount(acc);

      return reply([
          `🚗 *LAUNDRY DONE*`,
          ``,
          `Amount laundered: ${fmtMoney(amount)}`,
          `House cut (20%): -${fmtMoney(cut)}`,
          `Net clean: *${fmtMoney(net)}*`,
          ``,
          `🌡️ Crime heat: ${heat} → *${acc.crimeLevel}* (-${heatReduced})`
      ].join('\n'));
  } catch(e) { console.error('carwash error', e); }
});

// =============================================================================
// PICKPOCKET @player — silent micro-rob, no weapon needed, 10 min cooldown
// Low risk, low reward. Can't fail into jail — just miss.
// =============================================================================
cast({ pattern: "pickpocket", desc: "pickpocket @player — quietly lift their wallet", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id       = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId)          return reply(`Usage: pickpocket @player`);
      if (targetId === id)    return reply(`You can't pickpocket yourself.`);

      const acc    = await getAccount(id);
      const victim = await getAccount(targetId);

      if (isHospitalized(acc)) return reply(`🚨 You're locked up.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);
      if (isInFlight(acc))     return reply(`✈️ You're in-flight.`);
      if (isInFlight(victim))  return reply(`✈️ Target is in-flight.`);

      const myCity = normLoc(acc.location);
      const vicCity = normLoc(victim.location);
      if (myCity !== vicCity) return reply(`🌍 You need to be in the same city as your target.`);

      const COOLDOWN = 10 * 60 * 1000;
      const last = acc.cooldowns?.pickpocket || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Keep your head down for another ${msToTime(COOLDOWN - (now()-last))}.`);

      if (!victim.money || victim.money < 100) return reply(`That player has nothing worth lifting.`);

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.pickpocket = now();
      acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 5);

      // Dexterity-based success
      const myDex  = (acc.dexterity || 3) + (getEconGearBonus(acc).dexBonus || 0);
      const vicSpd = (victim.speed || 3) + (getEconGearBonus(victim).spdBonus || 0);
      const chance = Math.min(0.80, Math.max(0.25, 0.45 + 0.03 * (myDex - vicSpd)));

      if (Math.random() < chance) {
          const stolen = Math.floor(Math.min(victim.money * 0.05, iC(5000)) * (0.5 + Math.random()));
          victim.money -= stolen;
          acc.money    += stolen;
          acc.crimesCommitted = (acc.crimesCommitted || 0) + 1;
          logFinancial(acc,    `Pickpocket vs @${targetId}`, stolen);
          logFinancial(victim, `Pickpocketed by @${id}`, -stolen);
          await saveAccount(acc);
          await saveAccount(victim);
          return reply(`🤚 *Dipped!* You lifted *${fmtMoney(stolen)}* from @${targetId}'s pocket without a sound.`);
      } else {
          await saveAccount(acc);
          return reply(`🤚 *Missed.* @${targetId} shifted just as you reached in. You pulled back clean — no jail, no fine.`);
      }
  } catch(e) { console.error('pickpocket error', e); }
});

// =============================================================================
// FENCE — Sell inventory items for quick cash (60% of blackmarket value)
// =============================================================================
cast({ pattern: "fence", desc: "fence <item> [qty] — sell inventory to a fence", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`⛓️ Action blocked — you're in ${acc.inJail ? 'jail' : 'hospital'}. Serve your time first.`);

      if (!args[0]) {
          const inv = acc.inventory || {};
          const keys = Object.keys(inv).filter(k => inv[k] > 0 && BLACKMARKET[k]);
          if (keys.length === 0) return reply([
              `🕵️ *BLACK MARKET FENCE*`,
              ``,
              `You have no sellable items.`,
              `Buy items from the blackmarket first.`
          ].join('\n'));

          let list = keys.map(k => {
              const val = Math.floor(BLACKMARKET[k].price * 0.60);
              return `• *${k}* x${inv[k]} — ${fmtMoney(val)} each`;
          }).join('\n');

          return reply([`🕵️ *FENCE PRICES (60% of market)*`, ``, list, ``, `Usage: fence <item> [qty]`].join('\n'));
      }

      const item = args[0].toLowerCase();
      const qty  = Math.max(1, parseInt(args[1]) || 1);

      if (!BLACKMARKET[item]) return reply(`❌ The fence doesn't deal in *${item}*.`);
      const have = acc.inventory?.[item] || 0;
      if (have < qty) return reply(`You only have ${have}x *${item}*.`);

      const priceEach = Math.floor(BLACKMARKET[item].price * 0.60);
      const total     = priceEach * qty;

      acc.inventory[item] -= qty;
      acc.money += total;
      logFinancial(acc, `Fenced ${qty}x ${item}`, total);
      await saveAccount(acc);

      return reply([
          `🕵️ *FENCED*`,
          ``,
          `${qty}x *${item}* → *${fmtMoney(total)}*`,
          `(${fmtMoney(priceEach)} each at 60% market rate)`,
          ``,
          `Cash: ${fmtMoney(acc.money)}`
      ].join('\n'));
  } catch(e) { console.error('fence error', e); }
});

// =============================================================================
// EXTORT @player — demand weekly protection money
// If they comply (auto-paid on their next login) you earn. If they fight back, war.
// =============================================================================
if (!global.extortions) global.extortions = {}; // { victimId: { extorterId, amount, expiresAt } }

cast({ pattern: "extort", desc: "extort @player <amount> — demand protection money", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id       = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage: extort @player <amount>`);
      if (targetId === id) return reply(`You can't extort yourself.`);

      const amountArg = [...args].reverse().find(a => /^\d+$/.test(a));
      const amount    = parseInt(amountArg || '0');

      const acc    = await getAccount(id);
      const victim = await getAccount(targetId);

      if (isHospitalized(acc)) return reply(`🚨 You're locked up.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      if (!amount || amount < iC(500)) return reply(`Minimum extortion demand is ${fmtMoney(iC(500))}.\nUsage: extort @player <amount>`);
      if (amount > iC(100000)) return reply(`Max demand is ${fmtMoney(iC(100000))}. Don't be greedy.`);

      const myCity  = normLoc(acc.location);
      const vicCity = normLoc(victim.location);
      if (myCity !== vicCity) return reply(`🌍 You need to be in the same city to extort someone.`);

      if (!acc.equippedWeapon) return reply(`🔫 You need a weapon equipped to make a credible threat.`);

      const existing = global.extortions[targetId];
      if (existing && existing.expiresAt > now()) {
          return reply(`@${targetId} is already being extorted by someone else. Back off.`);
      }

      const COOLDOWN = 2 * 60 * 60 * 1000;
      const last = acc.cooldowns?.extort || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Lay low for ${msToTime(COOLDOWN - (now()-last))} before extorting again.`);

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.extort = now();
      acc.crimeLevel = Math.min(100, (acc.crimeLevel || 0) + 15);

      // Does the target resist?
      const myPower  = (acc.strength || 3) + (acc.level || 1) * 2 + (getEconGearBonus(acc).atkBonus || 0);
      const vicPower = (victim.strength || 3) + (victim.level || 1) * 2 + (getEconGearBonus(victim).defBonus || 0);
      const intimidate = Math.min(0.80, Math.max(0.20, 0.45 + 0.3 * (myPower - vicPower) / Math.max(vicPower, 1)));

      if (Math.random() < intimidate) {
          // Victim backs down — extortion set, auto-collected next login
          global.extortions[targetId] = {
              extorterId: id,
              amount,
              expiresAt: now() + 24 * 60 * 60 * 1000 // 24h window
          };
          setTimeout(() => { delete global.extortions[targetId]; }, 24 * 60 * 60 * 1000);

          await saveAccount(acc);
          return conn.sendMessage(m.chat, {
              text: [
                  `😤 *EXTORTION DEMAND SENT*`,
                  ``,
                  `You cornered @${targetId} and made your demand clear.`,
                  `💰 They owe you: *${fmtMoney(amount)}*`,
                  ``,
                  `It will be auto-collected next time they use any command.`,
                  `⚠️ Heat +15`
              ].join('\n'),
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      } else {
          // Target fights back — both take damage, extorter gets hurt worse
          const dmg = Math.floor(15 + Math.random() * 20);
          acc.health = Math.max(0, (acc.health || 100) - dmg);
          if (acc.health <= 0) acc.jailedUntil = now() + 10 * 60 * 1000;
          await saveAccount(acc);
          return conn.sendMessage(m.chat, {
              text: [
                  `💥 *EXTORTION BACKFIRED!*`,
                  ``,
                  `@${targetId} pulled a weapon and fought back!`,
                  `❤️ You took ${dmg} damage. HP: ${acc.health}`,
                  acc.health <= 0 ? `🚑 You were knocked out — hospitalised 10 min.` : ``,
                  ``,
                  `Maybe pick a softer target.`
              ].filter(Boolean).join('\n'),
              mentions: [toJid(targetId)]
          }, { quoted: mek });
      }
  } catch(e) { console.error('extort error', e); }
});

// Hook extortion auto-collection into getAccount (applied at top of function)
// NOTE: This is handled inline — on every getAccount call, we check extortions.
// We patch saveAccount to run this check. Actually we inject into getAccount via a post-hook below.
// The cleaner way: check in getAccount after loading. We do it by patching extortion check into the return path.

// =============================================================================
// COUNTDOWN — See ALL your active cooldowns and timers in one place
// =============================================================================
async function handleCountdownCmd(conn, mek, m, { reply }) {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const cd  = acc.cooldowns || {};
      const nowTs = now();

      const lines = [];

      if (acc.jailedUntil > nowTs)
          lines.push(`⛓️ Jail/Hospital: *${msToTime(acc.jailedUntil - nowTs)}* left`);
      if (acc.travelingUntil > nowTs)
          lines.push(`✈️ Flight to *${acc.travelingTo}*: *${msToTime(acc.travelingUntil - nowTs)}* left`);
      if (acc.kidnappedBy)
          lines.push(`🔒 Kidnapped by @${acc.kidnappedBy}${acc.ransomAmount > 0 ? ` — Ransom: ${fmtMoney(acc.ransomAmount)}` : ''}`);
      if (acc.robImmunityUntil > nowTs)
          lines.push(`🛡️ Rob protection: *${msToTime(acc.robImmunityUntil - nowTs)}* left`);
      if (acc.gearInsurance && acc.gearInsuranceExpiresAt > nowTs)
          lines.push(`🛡️ Gear insurance: *${msToTime(acc.gearInsuranceExpiresAt - nowTs)}* left`);
      if (acc.activeLoan?.owed > 0)
          lines.push(`🦈 Loan debt: *${fmtMoney(acc.activeLoan.owed)}* outstanding`);

      const COOLDOWNS = {
          shift:      ['👔 Shift',       30*60*1000],
          wager:      ['🎲 Wager',        5*60*1000],
          pickpocket: ['🤚 Pickpocket',  10*60*1000],
          smuggle:    ['🧳 Smuggle',     45*60*1000],
          hitman:     ['🔫 Hitman',      60*60*1000],
          carwash:    ['🚗 Car Wash',    30*60*1000],
          extort:     ['😤 Extort',     120*60*1000],
          duel:       ['⚔️ Duel',         5*60*1000],
      };

      for (const [key, [label, cdMs]] of Object.entries(COOLDOWNS)) {
          const last = cd[key] || 0;
          const remaining = cdMs - (nowTs - last);
          if (remaining > 0) lines.push(`${label}: *${msToTime(remaining)}* left`);
      }

      // Check torn.js cooldowns from shared player doc
      const tornCooldowns = [
          ['⚔️ Attack',       acc.lastAttack  || 0,  3*60*1000],
          ['🔪 Crime',        acc.lastCrime   || 0,  0], // varies by crime
          ['🏦 Bank Rob',     acc.lastBankRob || 0, 60*60*1000],
          ['🎯 Hunt',         acc.lastHunt    || 0, 15*60*1000],
          ['🔍 Search',       acc.lastSearch  || 0, 30*60*1000],
          ['🤲 Beg',          acc.lastBeg     || 0, 15*60*1000],
          ['📅 Daily',        acc.lastDaily   || 0, 24*60*60*1000],
          ['👊 Kidnap',       acc.lastKidnap  || 0,  4*60*60*1000],
      ];
      for (const [label, last, cdMs] of tornCooldowns) {
          if (!last || !cdMs) continue;
          const remaining = cdMs - (nowTs - last);
          if (remaining > 0) lines.push(`${label}: *${msToTime(remaining)}* left`);
      }

      if (lines.length === 0) return reply(`✅ *All clear!* You have no active timers or cooldowns. Go cause trouble.`);

      return reply([`⏳ *YOUR ACTIVE TIMERS*`, ``, ...lines].join('\n'));
  } catch(e) { console.error('countdown error', e); }
}
cast({ pattern: 'countdown', desc: 'See all your active cooldowns',  category: 'rpg', filename: __filename }, handleCountdownCmd);
cast({ pattern: 'timers',    desc: 'See cooldowns (alias: countdown)', category: 'rpg', filename: __filename }, handleCountdownCmd);

// =============================================================================
// AIRDROP — Creator drops cash to every player in a specific city
// =============================================================================
cast({ pattern: "airdrop", desc: "[Creator] airdrop <city> <amount> — drop cash to all players in a city", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      if (id !== '2348084644182') return reply(`❌ Creator-only command.`);

      const city   = (args[0] || '').toLowerCase();
      const amount = parseInt(args[1]);

      const validCities = ['weirdosworld', 'mexico', 'london', 'japan', 'switzerland', 'all'];
      if (!city || !validCities.includes(city.replace(/\s/g,''))) {
          return reply([
              `Usage: airdrop <city> <amount>`,
              `Cities: weirdosworld | mexico | london | japan | switzerland | all`,
              `Example: airdrop all 50000`
          ].join('\n'));
      }
      if (!amount || amount <= 0) return reply(`Usage: airdrop <city> <amount>`);

      const db = await connectDB();
      let query = {};
      if (city !== 'all') {
          // normalise city name for DB match
          const cityMap = { weirdosworld: 'Weirdos World', mexico: 'Mexico', london: 'London', japan: 'Japan', switzerland: 'Switzerland' };
          query = { location: cityMap[city] || city };
      }
      const players = await db.collection('weirdo_rpg').find(query).toArray();
      if (!players.length) return reply(`No players found in ${city}.`);

      const mentions = [];
      for (const p of players) {
          p.money = (p.money || 0) + amount;
          await db.collection('rpgplayers').updateOne({ _id: p._id }, { $inc: { money: amount } });
          mentions.push(toJid(p._id));
      }

      const cityLabel = city === 'all' ? 'ALL cities' : city.charAt(0).toUpperCase() + city.slice(1);
      return conn.sendMessage(m.chat, {
          text: [
              `🪂 *AIRDROP!*`,
              ``,
              `💰 *${fmtMoney(amount)}* dropped to *${players.length} players* in *${cityLabel}*!`,
              ``,
              players.slice(0,10).map(p => `• ${p.username || p._id}`).join('\n'),
              players.length > 10 ? `...and ${players.length - 10} more` : ''
          ].filter(Boolean).join('\n'),
          mentions
      }, { quoted: mek });
  } catch(e) { console.error('airdrop error', e); }
});

// =============================================================================
// DUEL @player <amount> — Direct PvP cash wager. Both lock in, stats decide.
// =============================================================================
if (!global.duelChallenges) global.duelChallenges = {}; // { challengedId: { challengerId, amount, expiresAt } }

cast({ pattern: "quickduel", desc: "quickduel @player <amount> — fast in-memory cash duel", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const sub = (args[0] || '').toLowerCase();

      if (isHospitalized(acc)) return reply(`🚨 You're locked up.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      // ── ACCEPT ────────────────────────────────────────────────────────────
      if (sub === 'accept') {
          const challenge = global.duelChallenges[id];
          if (!challenge) return reply(`You have no pending duel challenge. Someone needs to challenge you first.`);
          if (challenge.expiresAt < now()) {
              delete global.duelChallenges[id];
              return reply(`That duel challenge expired.`);
          }

          const challengerId = challenge.challengerId;
          const amount       = challenge.amount;
          const challenger   = await getAccount(challengerId);

          if (challenger.money < amount) {
              delete global.duelChallenges[id];
              return reply(`@${challengerId} no longer has enough money to cover the duel.`);
          }
          if (acc.money < amount) return reply(`You need ${fmtMoney(amount)} in your wallet to accept.`);

          delete global.duelChallenges[id];

          // Stat-based outcome — attack + speed + gear vs opponent
          const myGear  = getEconGearBonus(acc);
          const theirGear = getEconGearBonus(challenger);
          const myPower = (acc.strength || 3) + (acc.speed || 3) + (acc.dexterity || 3) + myGear.atkBonus + myGear.spdBonus + Math.random() * 30;
          const thPower = (challenger.strength || 3) + (challenger.speed || 3) + (challenger.dexterity || 3) + theirGear.atkBonus + theirGear.spdBonus + Math.random() * 30;

          const myWin = myPower > thPower;
          const winnerId = myWin ? id : challengerId;
          const loserId  = myWin ? challengerId : id;
          const winner   = myWin ? acc : challenger;
          const loser    = myWin ? challenger : acc;

          winner.money += amount;
          addTaxableIncome(winner, amount);
          loser.money  -= amount;
          winner.cooldowns = winner.cooldowns || {}; winner.cooldowns.duel = now();
          loser.cooldowns  = loser.cooldowns  || {}; loser.cooldowns.duel  = now();

          logFinancial(winner, `Duel win vs @${loserId}`, amount);
          logFinancial(loser,  `Duel loss vs @${winnerId}`, -amount);
          await saveAccount(winner);
          await saveAccount(loser);

          return conn.sendMessage(m.chat, {
              text: [
                  `⚔️ *DUEL RESULT*`,
                  ``,
                  `@${id} vs @${challengerId}`,
                  `💰 Pot: ${fmtMoney(amount * 2)} | Winner takes all`,
                  ``,
                  `🏆 *WINNER: @${winnerId}* (+${fmtMoney(amount)})`,
                  `💀 *LOSER: @${loserId}* (-${fmtMoney(amount)})`,
              ].join('\n'),
              mentions: [toJid(id), toJid(challengerId)]
          }, { quoted: mek });
      }

      // ── CHALLENGE ─────────────────────────────────────────────────────────
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply([
          `⚔️ *DUEL SYSTEM*`,
          ``,
          `Challenge: *duel @player <amount>*`,
          `Accept:    *duel accept*`,
          ``,
          `Stats decide the winner. No pure luck.`,
          `Both players must have the amount in wallet.`
      ].join('\n'));

      if (targetId === id) return reply(`You can't duel yourself.`);

      const amountArg = [...args].reverse().find(a => /^\d+$/.test(a));
      const amount    = parseInt(amountArg || '0');
      if (!amount || amount < iC(500)) return reply(`Minimum duel wager is ${fmtMoney(iC(500))}.`);
      if (acc.money < amount) return reply(`You need *${fmtMoney(amount)}* in your wallet to put up as stake.`);

      const COOLDOWN = 5 * 60 * 1000;
      const last = acc.cooldowns?.duel || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Cooldown: ${msToTime(COOLDOWN - (now()-last))} before challenging again.`);

      const myCity  = normLoc(acc.location);
      const target  = await getAccount(targetId);
      const vicCity = normLoc(target.location);
      if (myCity !== vicCity) return reply(`🌍 You need to be in the same city to duel.`);

      // Expire any old challenge to this player
      if (global.duelChallenges[targetId]) delete global.duelChallenges[targetId];

      global.duelChallenges[targetId] = { challengerId: id, amount, expiresAt: now() + 5 * 60 * 1000 };
      setTimeout(() => { delete global.duelChallenges[targetId]; }, 5 * 60 * 1000);

      return conn.sendMessage(m.chat, {
          text: [
              `⚔️ *DUEL CHALLENGE!*`,
              ``,
              `@${id} challenges @${targetId} to a duel!`,
              `💰 Stake: *${fmtMoney(amount)}* each — winner takes *${fmtMoney(amount * 2)}*`,
              ``,
              `@${targetId}: run *duel accept* within 5 minutes.`,
              `_Stats decide the outcome — no pure luck._`
          ].join('\n'),
          mentions: [toJid(id), toJid(targetId)]
      }, { quoted: mek });

  } catch(e) { console.error('duel error', e); }
});

// =============================================================================
// TAXIRIDE — Pay to instantly move to any city without the flight timer
// Costs significantly more than flying but skips the wait entirely
// =============================================================================
cast({ pattern: "taxi", desc: "taxi <city> — instant travel, no flight timer (expensive)", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      if (isHospitalized(acc)) return reply(`🚨 You're in jail/hospital.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);
      if (isInFlight(acc))     return reply(`✈️ You're already in-flight. Can't taxi mid-air.`);

      const TAXI_PRICES = {
          'weirdos world': 0,
          mexico:         iC(25000),
          london:         iC(60000),
          japan:          iC(100000),
          switzerland:    iC(175000),
          dubai:          iC(225000),
          'new york':     iC(90000),
          paris:          iC(75000),
          lagos:          iC(40000),
          moscow:         iC(125000),
          sydney:         iC(150000),
          'rio de janeiro': iC(110000),
      };
      const CITY_NAMES = {
          'weirdos world':  'Weirdos World',
          mexico:           'Mexico',
          london:           'London',
          japan:            'Japan',
          switzerland:      'Switzerland',
          dubai:            'Dubai',
          'new york':       'New York',
          paris:            'Paris',
          lagos:            'Lagos',
          moscow:           'Moscow',
          sydney:           'Sydney',
          'rio de janeiro': 'Rio de Janeiro',
      };

      const TAXI_ALIAS = {
          ww: 'weirdos world', torn: 'weirdos world', torncity: 'weirdos world',
          weirdosworld: 'weirdos world', weirdos: 'weirdos world', home: 'weirdos world',
          mex: 'mexico', mexico: 'mexico',
          london: 'london', uk: 'london', england: 'london',
          jp: 'japan', japan: 'japan', tokyo: 'japan',
          swiss: 'switzerland', switzerland: 'switzerland', zurich: 'switzerland', switz: 'switzerland',
          uae: 'dubai', dubai: 'dubai',
          ny: 'new york', nyc: 'new york', newyork: 'new york',
          fr: 'paris', france: 'paris', paris: 'paris',
          ng: 'lagos', nigeria: 'lagos', lagos: 'lagos',
          ru: 'moscow', russia: 'moscow', moscow: 'moscow',
          au: 'sydney', australia: 'sydney', sydney: 'sydney',
          brazil: 'rio de janeiro', rio: 'rio de janeiro',
      };
      const dest = TAXI_ALIAS[(args[0] || '').toLowerCase().replace(/[\s_-]/g, '')] || (args[0] || '').toLowerCase();

      if (!dest || !TAXI_PRICES.hasOwnProperty(dest)) {
          const currentCity = (acc.location || 'Weirdos World');
          let list = Object.entries(TAXI_PRICES)
              .filter(([c]) => c !== currentCity.toLowerCase())
              .map(([c, p]) => `  ${CITY_NAMES[c]} — ${fmtMoney(p)}`)
              .join('\n');
          return reply([
              `🚕 *TAXI SERVICE*`,
              `_Instant travel. No flight timer._`,
              ``,
              `📍 You are in: *${currentCity}*`,
              ``,
              list,
              ``,
              `Usage: *taxi <city>*`,
              `e.g. taxi japan`
          ].join('\n'));
      }

      const currentCity = normLoc(acc.location).toLowerCase();
      if (dest === currentCity) return reply(`You're already in ${CITY_NAMES[dest] || dest}.`);

      // Weather block check
      const destProper = CITY_NAMES[dest] || dest;
      const weather    = global.cityWeather?.[destProper];
      const sevMap     = { '☀️ Clear':0,'🌤️ Partly Cloudy':0,'🌧️ Rain':1,'⛈️ Thunderstorm':2,'🌨️ Blizzard':3,'🌪️ Hurricane':4,'🌫️ Dense Fog':1 };
      const sev        = sevMap[weather] ?? 0;
      if (sev >= 3) return reply(`⛔ *${destProper}* is currently experiencing *${weather}*. Taxi service suspended — no driver will go there right now.`);

      const fare = TAXI_PRICES[dest];
      if (acc.money < fare) return reply(`🚕 Taxi to *${CITY_NAMES[dest]}* costs *${fmtMoney(fare)}*. You have ${fmtMoney(acc.money)}.`);

      acc.money -= fare;
      acc.moneySpent = (acc.moneySpent || 0) + fare;
      acc.location = CITY_NAMES[dest];
      // Ensure no in-flight state lingers
      acc.travelingTo    = null;
      acc.travelingUntil = 0;

      logFinancial(acc, `Taxi to ${CITY_NAMES[dest]}`, -fare);
      await saveAccount(acc);

      return reply([
          `🚕 *TAXI — ARRIVED!*`,
          ``,
          `Destination: *${CITY_NAMES[dest]}*`,
          `Fare paid: *${fmtMoney(fare)}*`,
          ``,
          `You stepped out of the cab. Welcome to ${CITY_NAMES[dest]}.`
      ].join('\n'));
  } catch(e) { console.error('taxi error', e); }
});


// =============================================================================
// GIFT — Send items from your inventory to another player
// gift @player <item> [qty] | gear slot | property
// =============================================================================
cast({ pattern: "gift", desc: "gift @player <item|weapon|property> — send items, gear, or properties", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id       = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply([
          `🎁 *GIFT SYSTEM*`, ``,
          `Inventory item:  gift @player <item> [qty]`,
          `Equipped gear:   gift @player weapon|armor|helmet|gloves|kneepads|boots`,
          `Property:        gift @player property <propId> [qty]`,
          ``, `Examples:`,
          `  gift @max medkit 5`,
          `  gift @max weapon`,
          `  gift @max property shack 2`
      ].join('\n'));
      if (targetId === id) return reply(`You can't gift to yourself.`);

      const cleanArgs = args.filter(a => !a.includes('@'));
      const itemName  = (cleanArgs[0] || '').toLowerCase();
      const qty       = Math.max(1, parseInt([...cleanArgs].reverse().find(a => /^\d+$/.test(a)) || '1'));
      if (!itemName) return reply(`Usage: gift @player <item> [qty]`);

      const acc    = await getAccount(id);
      const target = await getAccount(targetId);
      if (isHospitalized(acc)) return reply(`🚨 Can't gift from jail/hospital.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const GEAR_SLOTS = { weapon:'equippedWeapon', armor:'equippedArmor', helmet:'equippedHelmet', gloves:'equippedGloves', kneepads:'equippedKneePads', boots:'equippedBoots' };

      // ── EQUIPPED GEAR GIFT ──────────────────────────────────────────────────
      if (GEAR_SLOTS[itemName]) {
          const slotField = GEAR_SLOTS[itemName];
          const gearId    = acc[slotField];
          if (!gearId) return reply(`❌ Nothing equipped in the *${itemName}* slot.`);
          acc[slotField] = null;
          target.inventory = target.inventory || {};
          target.inventory[gearId] = (target.inventory[gearId] || 0) + 1;
          await saveAccount(acc); await saveAccount(target);
          return conn.sendMessage(m.chat, {
              text: [`🎁 *GEAR GIFTED!*`, ``, `@${id} handed their *${gearId}* to @${targetId}`, `📦 It's in @${targetId}'s stash — equip with: use ${gearId}`].join('\n'),
              mentions: [toJid(id), toJid(targetId)]
          }, { quoted: mek });
      }

      // ── PROPERTY GIFT ───────────────────────────────────────────────────────
      if (itemName === 'property') {
          const propId  = (cleanArgs[1] || '').toLowerCase();
          const propQty = Math.max(1, parseInt(cleanArgs[2]) || 1);
          if (!propId) return reply(`Usage: gift @player property <propId> [qty]`);
          const have = acc.properties?.[propId] || 0;
          if (have < propQty) return reply(`❌ You only own ${have}x *${propId}*.`);
          acc.properties[propId] = have - propQty;
          if (acc.properties[propId] === 0) delete acc.properties[propId];
          target.properties = target.properties || {};
          target.properties[propId] = (target.properties[propId] || 0) + propQty;
          await saveAccount(acc); await saveAccount(target);
          return conn.sendMessage(m.chat, {
              text: [`🏠 *PROPERTY GIFTED!*`, ``, `@${id} transferred *${propQty}x ${propId}* to @${targetId}`, `Remaining with you: ${acc.properties[propId] || 0}x ${propId}`].join('\n'),
              mentions: [toJid(id), toJid(targetId)]
          }, { quoted: mek });
      }

      // ── INVENTORY ITEM GIFT ─────────────────────────────────────────────────
      const have = acc.inventory?.[itemName] || 0;
      if (have <= 0) {
          const isEquipped = Object.values(GEAR_SLOTS).some(s => acc[s] === itemName);
          return reply(`❌ You don't have *${itemName}* in your stash.${isEquipped ? '\n💡 It\'s equipped — use: gift @player weapon (or armor/helmet/etc.)' : ''}`);
      }
      if (have < qty) return reply(`❌ You only have ${have}x *${itemName}*.`);
      acc.inventory[itemName] = have - qty;
      target.inventory = target.inventory || {};
      target.inventory[itemName] = (target.inventory[itemName] || 0) + qty;
      await saveAccount(acc); await saveAccount(target);
      return conn.sendMessage(m.chat, {
          text: [`🎁 *GIFT SENT!*`, ``, `@${id} gifted *${qty}x ${itemName}* to @${targetId}`, `📦 Your remaining: ${acc.inventory[itemName]}x ${itemName}`].join('\n'),
          mentions: [toJid(id), toJid(targetId)]
      }, { quoted: mek });
  } catch(e) { console.error('gift error', e); }
})
// =============================================================================
// ROBLOX-INSPIRED FEATURES
// =============================================================================

// ── PET SYSTEM ───────────────────────────────────────────────────────────────
// Adopt pets that give passive stat bonuses. Feed them or they run away.
// pet adopt <name> | pet feed | pet status | pet release
const PETS = {
    dog:     { name: 'Dog',     price: iC(25000),      power: 18,  bonus: { strBonus: 5,  spdBonus: 3  }, icon: '🐶', desc: '+5 Str, +3 Spd. Bites attackers for 18 dmg.' },
    cat:     { name: 'Cat',     price: iC(15000),       power: 14,  bonus: { dexBonus: 8,  spdBonus: 5  }, icon: '🐱', desc: '+8 Dex, +5 Spd. Scratches for 14 dmg.' },
    parrot:  { name: 'Parrot',  price: iC(80000),       power: 20,  bonus: { dexBonus: 12, strBonus: 3  }, icon: '🦜', desc: '+12 Dex, +3 Str. Dive-bombs for 20 dmg.' },
    penguin: { name: 'Penguin', price: iC(50000),       power: 22,  bonus: { defBonus: 10, spdBonus: 6  }, icon: '🐧', desc: '+10 Def, +6 Spd. Body-slams for 22 dmg.' },
    wolf:    { name: 'Wolf',    price: iC(500000),      power: 55,  bonus: { strBonus: 18, spdBonus: 12 }, icon: '🐺', desc: '+18 Str, +12 Spd. Goes for the throat: 55 dmg.' },
    bear:    { name: 'Bear',    price: iC(1500000),     power: 80,  bonus: { strBonus: 25, defBonus: 15 }, icon: '🐻', desc: '+25 Str, +15 Def. Mauls enemies for 80 dmg.' },
    shark:   { name: 'Shark',   price: iC(10000000),    power: 120, bonus: { strBonus: 40, dexBonus: 20 }, icon: '🦈', desc: '+40 Str, +20 Dex. Shreds for 120 dmg.' },
    dragon:  { name: 'Dragon',  price: iC(50000000),    power: 200, bonus: { strBonus: 60, defBonus: 40, spdBonus: 20 }, icon: '🐉', desc: '+60 Str, +40 Def, +20 Spd. Breathes fire: 200 dmg.' },
};

cast({ pattern: "pet", desc: "pet adopt <type> | pet feed | pet status | pet list", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const sub = (args[0] || 'status').toLowerCase();

      if (sub === 'list') {
          let out = `🐾 *AVAILABLE PETS*\n_Your pet fights alongside you in every battle._\n\n`;
          for (const [key, p] of Object.entries(PETS)) {
              out += `${p.icon} *${p.name}* — pet adopt ${key}\n   ⚔️ Combat Power: ${p.power} | 💰 ${fmtMoney(p.price)}\n   ${p.desc}\n\n`;
          }
          return reply(out);
      }

      if (sub === 'status') {
          if (!acc.pet?.type) return reply(`🐾 You have no pet.\nAdopt one with: *pet adopt <type>*\nSee options: *pet list*`);
          const p        = PETS[acc.pet.type];
          const petLvl   = acc.pet.level || 1;
          const petXp    = acc.pet.xp    || 0;
          const xpNeeded = petXpToLevel(petLvl);
          const curPower = petLevelPower(p?.power || 0, petLvl);
          const hungry   = (now() - (acc.pet.lastFed || 0)) > 12 * 60 * 60 * 1000;
          const starving = (now() - (acc.pet.lastFed || 0)) > 24 * 60 * 60 * 1000;
          const mood     = starving ? '💀 Starving — won\'t fight!' : hungry ? '😢 Hungry — feed me!' : '😊 Happy & ready to fight';
          const nickname = acc.pet.nickname;
          const xpBar    = (() => {
              const filled = Math.floor((petXp / xpNeeded) * 10);
              return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${petXp}/${xpNeeded}`;
          })();
          return reply([
              `${p?.icon || '🐾'} *${nickname ? `${nickname} the ${acc.pet.type}` : acc.pet.type.toUpperCase()} — Level ${petLvl}*`,
              nickname ? `_"${nickname}"_ 🏷️` : `Tip: name your pet with *pet name <n>*`,
              ``,
              `Mood: ${mood}`,
              `Last fed: ${acc.pet.lastFed ? msToTime(now() - acc.pet.lastFed) + ' ago' : 'Never!'}`,
              ``,
              `⚔️ Combat Power: *${curPower} dmg/round*`,
              `📊 Stats: ${Object.entries(petLevelBonus(p?.bonus || {}, petLvl)).map(([k,v]) => `+${v} ${k.replace('Bonus','')}`).join(', ')}`,
              ``,
              `📈 XP: ${xpBar}`,
              petLvl > 1 ? `🔺 Power: base ${p?.power} → *${curPower}* at Lv${petLvl}` : `Train: *pettrain attack | defense | speed*`,
              ``,
              hungry ? `⚠️ Feed: *pet feed*` : `Next training: *pettrain attack | defense | speed*`
          ].join('\n'));
      }

      if (sub === 'feed') {
          if (!acc.pet?.type) return reply(`You don't have a pet to feed.`);
          const FEED_COST = iC(500);
          if (acc.money < FEED_COST) return reply(`Feeding your pet costs ${fmtMoney(FEED_COST)}.`);
          acc.money -= FEED_COST;
          acc.pet.lastFed = now();
          await saveAccount(acc);
          const p = PETS[acc.pet.type];
          return reply(`${p?.icon || '🐾'} You fed your *${acc.pet.type}* for ${fmtMoney(FEED_COST)}. It's happy and well-fed!`);
      }

      if (sub === 'release') {
          if (!acc.pet?.type) return reply(`You don't have a pet.`);
          const displayName = acc.pet.nickname || acc.pet.type;
          acc.pet = null;
          await saveAccount(acc);
          return reply(`🐾 You released *${displayName}* into the wild. Goodbye!`);
      }

      if (sub === 'name') {
          if (!acc.pet?.type) return reply(`You don't have a pet to name.`);
          const newName = args.slice(1).join(' ').trim();
          if (!newName) return reply(`Usage: pet name <name>\nExample: pet name Max`);
          if (newName.length > 20) return reply(`Pet name too long. Max 20 characters.`);
          if (!/^[a-zA-Z0-9 _'\-]+$/.test(newName)) return reply(`Pet name can only contain letters, numbers, spaces, and basic punctuation.`);
          const oldName = acc.pet.nickname || acc.pet.type;
          acc.pet.nickname = newName;
          await saveAccount(acc);
          const p = PETS[acc.pet.type];
          return reply(`${p?.icon || '🐾'} Your ${acc.pet.type} has been named *${newName}*! They seem happy about it.`);
      }

      if (sub === 'adopt') {
          if (acc.pet?.type) return reply(`You already have *${acc.pet.nickname || acc.pet.type}*. Release it first with: *pet release*`);
          const type = (args[1] || '').toLowerCase();
          const petDef = PETS[type];
          if (!petDef) return reply(`Unknown pet type. See *pet list* for options.`);
          if (acc.money < petDef.price) return reply(`${petDef.icon} *${petDef.name}* costs ${fmtMoney(petDef.price)}. You have ${fmtMoney(acc.money)}.`);
          acc.money -= petDef.price;
          acc.moneySpent = (acc.moneySpent || 0) + petDef.price;
          logFinancial(acc, `🐾 Adopted pet: ${petDef.name}`, -petDef.price);
          const nickname = args.slice(2).join(' ').trim() || null;
          acc.pet = {
              type:        type,
              nickname:    nickname,
              level:       1,
              xp:          0,
              adoptedAt:   now(),
              lastFed:     now(),
              lastTrained: 0,
              injured:     false,
          };
          logFinancial(acc, `Adopted pet: ${type}${nickname ? ` (${nickname})` : ''}`, -petDef.price);
          await saveAccount(acc);
          return reply([
              `${petDef.icon} *PET ADOPTED!*`,
              ``,
              `You adopted a *${petDef.name}*!`,
              nickname ? `Name: *${nickname}*` : `Tip: give it a name with *pet name <name>*`,
              `Cost: ${fmtMoney(petDef.price)}`,
              ``,
              `${petDef.desc}`,
              ``,
              `Feed every 12h or it runs away. Train with: *pettrain attack*`
          ].filter(Boolean).join('\n'));
      }

      return reply(`Usage: pet list | pet adopt <type> [name] | pet name <name> | pet feed | pet status | pet release`);
  } catch(e) { console.error('pet error', e); }
});

// =============================================================================
// PET LEVELLING HELPERS
// =============================================================================
// XP needed to reach next pet level — grows each level
function petXpToLevel(level) { return 100 + (level - 1) * 80; }

// Total combat power for a pet factoring in its current level
// Base power scales × (1 + 0.12 per level above 1) — level 10 pet = 2.08× base
function petLevelPower(basePower, petLevel) {
    return Math.floor(basePower * (1 + (petLevel - 1) * 0.12));
}

// Stat bonuses also scale with pet level (+5% per level above 1)
function petLevelBonus(baseBonus, petLevel) {
    const mult = 1 + (petLevel - 1) * 0.05;
    const result = {};
    for (const [k, v] of Object.entries(baseBonus)) result[k] = Math.floor(v * mult);
    return result;
}

function getPetBonus(acc) {
    if (!acc.pet?.type) return {};
    const p = PETS[acc.pet.type];
    if (!p) return {};
    if ((now() - (acc.pet.lastFed || 0)) > 24 * 60 * 60 * 1000) return {};
    const lvl = acc.pet.level || 1;
    return petLevelBonus(p.bonus || {}, lvl);
}

// =============================================================================
// PET TRAINING — pet train [focus]
// focus: attack | defense | speed  (default: attack)
// 20-min cooldown per training session
// =============================================================================
async function handlePetTrainCmd(conn, mek, m, { args, reply }) {
    try {
        const id  = await getPlayerId(conn, m.sender);
        const acc = await getAccount(id);

        if (!acc.pet?.type) return reply(`🐾 You don't have a pet to train.\nAdopt one with: *pet adopt <type>*`);

        const p       = PETS[acc.pet.type];
        const petLvl  = acc.pet.level || 1;
        const petXp   = acc.pet.xp    || 0;
        const xpNeeded = petXpToLevel(petLvl);
        const petName  = acc.pet.nickname || p.name;

        // Hungry pet can't train
        if ((now() - (acc.pet.lastFed || 0)) > 12 * 60 * 60 * 1000)
            return reply(`${p.icon} *${petName}* is too hungry to train. Feed it first: *pet feed*`);

        const COOLDOWN   = 20 * 60 * 1000;
        const TRAIN_COST = iC(2000);
        const last       = acc.pet.lastTrained || 0;
        if (now() - last < COOLDOWN)
            return reply(`⏳ Your pet is resting. Next session in ${msToTime(COOLDOWN - (now() - last))}.`);

        if (!args[0]) {
            const curPower = petLevelPower(p.power, petLvl);
            return reply([
                `${p.icon} *${petName.toUpperCase()} — TRAINING DOJO*`,
                ``,
                `Level: *${petLvl}* | XP: ${petXp}/${xpNeeded}`,
                `⚔️ Current Power: *${curPower}* dmg`,
                ``,
                `Training sessions cost ${fmtMoney(TRAIN_COST)} each.`,
                `Each session grants 15–35 XP. Level up = +12% combat power.`,
                ``,
                `*Focuses:*`,
                `• *pettrain attack*  — more XP, slight health risk`,
                `• *pettrain defense* — balanced XP, toughens up`,
                `• *pettrain speed*   — moderate XP, improves dodge`,
                ``,
                `Run: *pettrain attack* (or defense / speed)`
            ].join('\n'));
        }

        const focus = (args[0] || 'attack').toLowerCase();
        if (!['attack','defense','speed'].includes(focus))
            return reply(`Invalid focus. Choose: attack | defense | speed`);

        if (acc.money < TRAIN_COST)
            return reply(`Training costs ${fmtMoney(TRAIN_COST)}. You have ${fmtMoney(acc.money)}.`);

        acc.money -= TRAIN_COST;
        acc.moneySpent = (acc.moneySpent || 0) + TRAIN_COST;

        // XP gain varies by focus
        const XP_RANGES = { attack: [25, 40], defense: [20, 35], speed: [18, 32] };
        const [xpMin, xpMax] = XP_RANGES[focus];
        const gainedXp = xpMin + Math.floor(Math.random() * (xpMax - xpMin + 1));

        // Attack training has a small injury chance
        let injuryLine = '';
        if (focus === 'attack' && Math.random() < 0.15) {
            injuryLine = `\n⚠️ Pushed too hard — ${petName} is a little sore. Feed it to recover.`;
        }

        // Rebuild pet as a fresh plain object — avoids BSON subdocument mutation issues
        let newLevel = acc.pet.level || 1;
        let newXp    = (acc.pet.xp || 0) + gainedXp;

        // Level up loop
        let levelUps = 0;
        while (newXp >= petXpToLevel(newLevel)) {
            newXp -= petXpToLevel(newLevel);
            newLevel += 1;
            levelUps++;
        }

        // Reconstruct entire pet object — guarantees $set saves every field
        acc.pet = {
            type:        acc.pet.type,
            nickname:    acc.pet.nickname    || null,
            level:       newLevel,
            xp:          newXp,
            adoptedAt:   acc.pet.adoptedAt   || now(),
            lastFed:     acc.pet.lastFed     || 0,
            lastTrained: now(),
            injured:     focus === 'attack' && Math.random() < 0.15,
        };

        logFinancial(acc, `Pet training: ${p.name} (${focus})`, -TRAIN_COST);
        await saveAccount(acc);

        const newPower    = petLevelPower(p.power, newLevel);
        const newXpNeeded = petXpToLevel(newLevel);

        const focusFlavour = {
            attack:  ['sparred against a training dummy', 'drilled strike combos for an hour', 'practised takedowns relentlessly'],
            defense: ['trained blocking drills', 'hardened up against padded attacks', 'practised dodging and counter-stancing'],
            speed:   ['sprinted laps around the dojo', 'practised quick-reaction exercises', 'worked on agility and footwork'],
        };
        const flavour = focusFlavour[focus][Math.floor(Math.random() * 3)];

        let out = [
            `${p.icon} *PET TRAINING COMPLETE!*`,
            ``,
            `*${petName}* ${flavour}.`,
            `💰 Cost: ${fmtMoney(TRAIN_COST)} | 📈 XP gained: +${gainedXp}`,
            ``,
        ];

        if (levelUps > 0) {
            out.push(`🎉 *LEVEL UP!* ${petName} reached *Level ${newLevel}*!`);
            out.push(`⚔️ Combat Power: *${newPower} dmg* per round (+${Math.floor(p.power * 0.12 * levelUps)} from level up)`);
        } else {
            out.push(`Level: ${newLevel} | XP: ${newXp}/${newXpNeeded}`);
            out.push(`⚔️ Power: *${newPower} dmg* | Next level in ${newXpNeeded - newXp} XP`);
        }

        if (injuryLine) out.push(injuryLine);

        return reply(out.join('\n'));
    } catch(e) { console.error('pettrain error', e); }
}
cast({ pattern: 'pettrain',  desc: 'Train your pet to make it stronger', category: 'rpg', filename: __filename }, handlePetTrainCmd);
cast({ pattern: 'trainpet',  desc: 'Train your pet (alias: pettrain)',   category: 'rpg', filename: __filename }, handlePetTrainCmd);

// ── OBBY (Obstacle Course) ────────────────────────────────────────────────────
// A timed obstacle course. Run it and get a cash reward based on your speed stat.
// 30-min cooldown. Harder difficulties cost energy but pay more.
const OBBY_TIERS = [
  { name: 'Beginner',   energy: 15, speedReq: 0,   failChance: 0.20, endGain: 1, labGain: 1 },
  { name: 'Normal',     energy: 25, speedReq: 20,  failChance: 0.25, endGain: 2, labGain: 1 },
  { name: 'Hard',       energy: 40, speedReq: 50,  failChance: 0.35, endGain: 3, labGain: 2 },
  { name: 'Insane',     energy: 60, speedReq: 100, failChance: 0.45, endGain: 5, labGain: 3 },
  { name: 'Impossible', energy: 80, speedReq: 200, failChance: 0.55, endGain: 8, labGain: 5 },
];

cast({ pattern: "course", desc: "course [difficulty] — stat training obstacle course (beginner/normal/hard/insane/impossible)", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 Can't run an obby from jail.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped. Escape first.`);

      const COOLDOWN = 45 * 60 * 1000; // 45min cooldown
      const last = acc.cooldowns?.obby || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ You're exhausted. Obby available in ${msToTime(COOLDOWN - (now()-last))}.`);

      const spd = (acc.speed || 3) + (getEconGearBonus(acc).spdBonus || 0) + (getPetBonus(acc).spdBonus || 0);
      const diffArg = (args[0] || '').toLowerCase();
      const available = OBBY_TIERS.filter(t => spd >= t.speedReq);

      if (!diffArg) {
          let list = OBBY_TIERS.map(t => {
              const lock = spd < t.speedReq ? `🔒 Need ${t.speedReq} Spd` : `✅ Available`;
              return `• *${t.name}* — Endurance +${t.endGain} | Labor +${t.labGain} | ${t.energy} energy | ${lock} (stats only, no cash)`;
          }).join('\n');
          return reply([`🏃 *COURSE — OBSTACLE COURSE*`, ``, `Your Speed: ${spd}`, ``, list, ``, `Run with: *course <difficulty>* (e.g. course hard)`].join('\n'));
      }

      const tier = OBBY_TIERS.find(t => t.name.toLowerCase() === diffArg);
      if (!tier) return reply(`Unknown difficulty. Try: beginner, normal, hard, insane, impossible`);
      if (spd < tier.speedReq) return reply(`🔒 *${tier.name}* requires ${tier.speedReq} Speed. You have ${spd}.`);
      if ((acc.energy || 0) < tier.energy) return reply(`⚡ Not enough energy. Need ${tier.energy}, have ${acc.energy || 0}.`);

      acc.energy -= tier.energy;
      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.obby = now();

      // No cash reward — stats only

      const FAIL_CHANCE = tier.failChance || 0.20;
      if (Math.random() < FAIL_CHANCE) {
          const dmg = 10 + Math.floor(Math.random() * 20);
          acc.health = Math.max(1, (acc.health || 100) - dmg);
          // Failed: full 45min cooldown still applies — no free retry
          acc.cooldowns.obby = now();
          await saveAccount(acc);
          return reply([
              `💥 *OBBY FAILED!*`,
              ``,
              `You wiped out on the *${tier.name}* course!`,
              `❤️ Took ${dmg} fall damage. HP: ${acc.health}`,
              ``,
              `⏳ Cooldown still applies — next attempt in *45 minutes*.`
          ].join('\n'));
      }

      // OBBY GIVES STATS ONLY — no money reward
      acc.endurance   = (acc.endurance||0) + tier.endGain;
      acc.labor       = (acc.labor||0) + tier.labGain;
      acc.manualLabor = (acc.manualLabor||0) + 2;
      // Every 5 endurance = +1 Max HP (capped at 500)
      const oldHpBonus = Math.floor(((acc.endurance||0) - tier.endGain) / 5);
      const newHpBonus = Math.floor((acc.endurance||0) / 5);
      if (newHpBonus > oldHpBonus) acc.maxHealth = (acc.maxHealth||100) + (newHpBonus - oldHpBonus); // no cap
      await saveAccount(acc);
      return reply([
          `🏆 *OBBY COMPLETE!*`,
          ``,
          `Course: *${tier.name}*`,
          `Speed: ${spd} | Energy used: ${tier.energy}`,
          ``,
          `_Obby trains STATS only — no cash reward._`,
          `💪 Endurance +${tier.endGain} → *${acc.endurance}*`,
          `⚒️ Labor +${tier.labGain} → *${acc.labor}*`,
          newHpBonus > oldHpBonus ? `❤️ Max HP increased to *${acc.maxHealth}*!` : `_(Every 5 endurance = +1 Max HP)_`,
      ].filter(Boolean).join('\n'));
  } catch(e) { console.error('obby error', e); }
});

// ── TYCOON — Passive business empire ─────────────────────────────────────────
// Buy tycoon upgrades. Each one increases your passive income per claim tick.
// tycoon buy <upgrade> | tycoon claim | tycoon status
const TYCOON_UPGRADES = [
  { id: 'droppers',   name: 'Droppers',       price: iC(50000),    incomePerMin: 8,    desc: 'Basic dropper. Very slow income.' },
  { id: 'conveyor',   name: 'Conveyor Belt',  price: iC(250000),   incomePerMin: 30,   desc: 'Speeds up production a little.' },
  { id: 'factory',    name: 'Factory Floor',  price: iC(1000000),  incomePerMin: 100,  desc: 'Mass production. Costly investment.' },
  { id: 'vault',      name: 'Money Vault',    price: iC(5000000),  incomePerMin: 350,  desc: 'Secure vault. Strong returns.' },
  { id: 'launcher',   name: 'Cash Launcher',  price: iC(20000000), incomePerMin: 1000, desc: 'High-end setup. Serious business.' },
  { id: 'megafactory',name: 'Mega Factory',   price: iC(100000000),incomePerMin: 3500, desc: 'Top tier. Very expensive. Max yield.' },
];

cast({ pattern: "tycoon", desc: "tycoon status | tycoon buy <upgrade> | tycoon claim", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const sub = (args[0] || 'status').toLowerCase();

      // Calculate total tycoon income per minute
      function tycoonIncome(t) {
          let total = 0;
          for (const u of TYCOON_UPGRADES) {
              if (t?.[u.id]) total += u.incomePerMin;
          }
          return total;
      }

      const tycoon = acc.tycoon || {};

      if (sub === 'status') {
          const perMin = tycoonIncome(tycoon);
          const owned  = TYCOON_UPGRADES.filter(u => tycoon[u.id]);
          const lastClaim = tycoon.lastClaim || 0;
          const unclaimed = Math.floor((now() - lastClaim) / 60000) * perMin;

          let upgradeList = TYCOON_UPGRADES.map(u => {
              return `${tycoon[u.id] ? '✅' : '⬜'} *${u.name}* — ${fmtMoney(u.price)} | +${fmtMoney(u.incomePerMin)}/min`;
          }).join('\n');

          return reply([
              `🏭 *YOUR TYCOON*`,
              ``,
              owned.length === 0 ? `No upgrades yet.` : `Owned: ${owned.map(u => u.name).join(', ')}`,
              `💰 Income: *${fmtMoney(perMin)}/min*`,
              `📦 Unclaimed: *${fmtMoney(unclaimed)}*`,
              ``,
              `*UPGRADES:*`,
              upgradeList,
              ``,
              `Buy: *tycoon buy <upgrade>*`,
              `Collect: *tycoon claim*`
          ].join('\n'));
      }

      if (sub === 'claim') {
          const perMin = tycoonIncome(tycoon);
          if (perMin === 0) return reply(`🏭 Your tycoon earns nothing yet. Buy upgrades with: *tycoon buy <upgrade>*`);
          const lastClaim = tycoon.lastClaim || now();
          const minElapsed = Math.floor((now() - lastClaim) / 60000);
          if (minElapsed < 1) return reply(`⏳ Nothing to claim yet. Tycoon pays out every minute.`);
          const earned = Math.min(minElapsed * perMin, perMin * 360); // cap at 6h — collect regularly or lose it
          const { net, vat } = applyVAT(earned);
          acc.money = capBalance((acc.money||0) + net);
          acc.totalEarned = (acc.totalEarned||0) + net;
          logFinancial(acc, `🏭 Tycoon claim (${minElapsed} min)`, net);
          const tycLoanMsg = tryDeductLoan(acc, net, 'Tycoon payout');
          addTaxableIncome(acc, net);
          acc.tycoon = { ...tycoon, lastClaim: now() };
          logFinancial(acc, `Tycoon claim (${minElapsed} min)`, net);
          await saveAccount(acc);
          return reply([
              `🏭 *TYCOON PAYOUT!*`,
              ``,
              `Time since last claim: ${minElapsed} minutes`,
              `Rate: ${fmtMoney(perMin)}/min`,
              `Gross: ${fmtMoney(earned)} — VAT: -${fmtMoney(vat)} = *${fmtMoney(net)} net*`,
              tycLoanMsg,
          ].filter(Boolean).join('\n'));
      }

      if (sub === 'buy') {
          const upgradeId = (args[1] || '').toLowerCase();
          const upgrade   = TYCOON_UPGRADES.find(u => u.id === upgradeId);
          if (!upgrade) return reply(`Unknown upgrade. Options: ${TYCOON_UPGRADES.map(u => u.id).join(', ')}`);
          if (tycoon[upgradeId]) return reply(`✅ You already own *${upgrade.name}*.`);
          if (acc.money < upgrade.price) return reply(`💸 *${upgrade.name}* costs ${fmtMoney(upgrade.price)}. You have ${fmtMoney(acc.money)}.`);
          acc.money -= upgrade.price;
          acc.moneySpent = (acc.moneySpent || 0) + upgrade.price;
          logFinancial(acc, `🏭 Tycoon: bought ${upgrade.name}`, -upgrade.price);
          acc.tycoon = { ...tycoon, [upgradeId]: true, lastClaim: tycoon.lastClaim || now() };
          logFinancial(acc, `Tycoon upgrade: ${upgrade.name}`, -upgrade.price);
          await saveAccount(acc);
          const newIncome = tycoonIncome(acc.tycoon);
          return reply([
              `🏭 *UPGRADE PURCHASED!*`,
              ``,
              `*${upgrade.name}* installed!`,
              `${upgrade.desc}`,
              ``,
              `New income rate: *${fmtMoney(newIncome)}/min*`,
              `Collect earnings with: *tycoon claim*`
          ].join('\n'));
      }

      return reply(`Usage: tycoon status | tycoon buy <upgrade> | tycoon claim`);
  } catch(e) { console.error('tycoon error', e); }
});

// ── SWORD FIGHT (Roblox classic) ─────────────────────────────────────────────
// Quick 1v1 duel with swords — no stats needed, pure RNG with skill element.
// Win streaks give multiplier bonuses. 5-min cooldown.
cast({ pattern: "swordfight", desc: "swordfight @player — classic Roblox-style sword duel", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id       = await getPlayerId(conn, m.sender);
      const targetId = await getTargetId(conn, mek, args, 0);
      if (!targetId) return reply(`Usage: swordfight @player\n\n⚔️ A classic sword fight. No weapons or stats required.\nWin streaks build a multiplier for bigger rewards.`);
      if (targetId === id) return reply(`You can't sword fight yourself.`);

      const acc    = await getAccount(id);
      const target = await getAccount(targetId);

      if (isHospitalized(acc)) return reply(`🚨 You're in hospital.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const myCity  = normLoc(acc.location);
      const vicCity = normLoc(target.location);
      if (myCity !== vicCity) return reply(`🌍 Must be in the same city to sword fight.`);

      const COOLDOWN = 5 * 60 * 1000;
      const last = acc.cooldowns?.swordfight || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Cooldown: ${msToTime(COOLDOWN - (now()-last))}`);

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.swordfight = now();

      // Speed + dex lightly influence outcome but it's mostly even
      const myScore  = Math.random() * 100 + ((acc.speed || 3) + (acc.dexterity || 3)) * 0.5;
      const vicScore = Math.random() * 100 + ((target.speed || 3) + (target.dexterity || 3)) * 0.5;

      const wonStreak = (acc.swordStreak || 0);
      const mult = 1 + Math.min(wonStreak * 0.25, 2.0); // up to 3× at 8 wins

      const BASE_REWARD = iC(3000);

      if (myScore > vicScore) {
          const reward = Math.floor(BASE_REWARD * mult);
          acc.money += reward;
          addTaxableIncome(acc, reward);
          acc.swordStreak = wonStreak + 1;
          target.swordStreak = 0;
          // loser takes small HP hit
          target.health = Math.max(1, (target.health || 100) - 5);
          logFinancial(acc, `Sword fight win vs @${targetId}`, reward);
          await saveAccount(acc);
          await saveAccount(target);
          return conn.sendMessage(m.chat, {
              text: [
                  `⚔️ *SWORD FIGHT!*`,
                  ``,
                  `@${id} vs @${targetId}`,
                  ``,
                  `🏆 *@${id} wins!*`,
                  `💰 Reward: *${fmtMoney(reward)}* (${mult.toFixed(2)}× streak multiplier)`,
                  `🔥 Win streak: *${acc.swordStreak}*`,
                  ``,
                  acc.swordStreak >= 3 ? `🎯 You're on fire! Keep it up.` : ``,
              ].filter(Boolean).join('\n'),
              mentions: [toJid(id), toJid(targetId)]
          }, { quoted: mek });
      } else {
          acc.swordStreak = 0;
          acc.health = Math.max(1, (acc.health || 100) - 5);
          await saveAccount(acc);
          await saveAccount(target);
          return conn.sendMessage(m.chat, {
              text: [
                  `⚔️ *SWORD FIGHT!*`,
                  ``,
                  `@${id} vs @${targetId}`,
                  ``,
                  `💀 *@${id} got eliminated!* @${targetId} wins.`,
                  `Win streak reset to 0.`
              ].join('\n'),
              mentions: [toJid(id), toJid(targetId)]
          }, { quoted: mek });
      }
  } catch(e) { console.error('swordfight error', e); }
});

// ── WORK AT A PIZZA PLACE (Roblox tribute) ────────────────────────────────────
// Mini jobs with flavour text. Different roles each time, animated-style output.
// 15-min cooldown, separate from regular shift.
const PIZZA_ROLES = [
  { role: 'Cashier',         lines: ['You smiled at customers aggressively.', 'Two people asked for refunds. You denied both.'], pay: [800, 1500] },
  { role: 'Delivery Driver', lines: ['You drove 90mph on a scooter.', 'The pizza was upside down but still warm.'], pay: [1200, 2500] },
  { role: 'Cook',            lines: ['You burned three pizzas.', 'The fourth one was *incredible*.'], pay: [1000, 2000] },
  { role: 'Manager',         lines: ['You fired two people then rehired them.', 'Revenue up 4%. You took all the credit.'], pay: [2000, 4000] },
  { role: 'Toppings Expert', lines: ['You put pineapple on everything.', 'Half the staff quit. Productivity improved.'], pay: [900, 1800] },
  { role: 'Box Folder',      lines: ['You folded 800 boxes.', 'Your thumbs now operate at a professional level.'], pay: [600, 1200] },
];

async function handlePizzaJobCmd(conn, mek, m, { reply }) {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      if (isHospitalized(acc)) return reply(`🚨 Can't deliver pizza from hospital.`);
      if (isKidnapped(acc))    return reply(`🔒 You're kidnapped.`);

      const COOLDOWN = 15 * 60 * 1000;
      const last = acc.cooldowns?.pizzajob || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Your shift starts in ${msToTime(COOLDOWN - (now()-last))}.`);

      const job = PIZZA_ROLES[Math.floor(Math.random() * PIZZA_ROLES.length)];
      const gross = job.pay[0] + Math.floor(Math.random() * (job.pay[1] - job.pay[0]));
      const { net, vat } = applyVAT(gross);

      acc.money = capBalance((acc.money||0) + net);
      addTaxableIncome(acc, net);
      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.pizzajob = now();
      logFinancial(acc, `Pizza Place: ${job.role}`, net);
      await saveAccount(acc);

      return reply([
          `🍕 *WORK AT A PIZZA PLACE*`,
          ``,
          `Role: *${job.role}*`,
          ``,
          `📋 Shift Report:`,
          ...job.lines.map(l => `   • ${l}`),
          ``,
          `Gross: ${fmtMoney(gross)} — VAT: -${fmtMoney(vat)} = *${fmtMoney(net)}*`,
          `Next shift in 15 minutes.`
      ].join('\n'));
  } catch(e) { console.error('pizzajob error', e); }
}
cast({ pattern: 'pizzajob',    desc: 'Work at a pizza place (Roblox)', category: 'rpg', filename: __filename }, handlePizzaJobCmd);
cast({ pattern: 'workatpizza', desc: 'Pizza job (alias: pizzajob)',    category: 'rpg', filename: __filename }, handlePizzaJobCmd);

// ── JAILBREAK (Roblox tribute) ────────────────────────────────────────────────
// If you're in jail, attempt a Roblox-style jailbreak. Riskier than bailout
// but free if it works. Others can help break you out.
cast({ pattern: "jailbreak", desc: "Attempt a Roblox-style jailbreak from prison", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);

      // Can also jailbreak someone else
      const targetId = await getTargetId(conn, mek, args, 0).catch(() => null);
      const isExternal = targetId && targetId !== id;
      const prisoner   = isExternal ? await getAccount(targetId) : acc;
      const prisonerId = isExternal ? targetId : id;

      if (isExternal && !isHospitalized(prisoner)) return reply(`@${targetId} isn't in jail.`);
      if (!isExternal && !isHospitalized(acc))     return reply(`You're not in jail. Nothing to break out of.`);
      if (!isExternal && isKidnapped(acc))         return reply(`🔒 You're kidnapped, not jailed. Use escape instead.`);

      const COOLDOWN = 45 * 60 * 1000; // 45min cooldown — jailbreaks are hard
      const last = acc.cooldowns?.jailbreak || 0;
      if (now() - last < COOLDOWN) return reply(`⏳ Last attempt failed. Guards are watching. Lay low for ${msToTime(COOLDOWN - (now()-last))}.`);

      acc.cooldowns = acc.cooldowns || {};
      acc.cooldowns.jailbreak = now();

      const spd    = (acc.speed || 3) + (getEconGearBonus(acc).spdBonus || 0);
      // Much lower chance: max 35% even with high speed
      const chance = Math.min(0.35, 0.08 + (spd / 500));

      if (Math.random() < chance) {
          prisoner.jailedUntil = 0;
          prisoner.health      = Math.max(prisoner.health || 1, 20);
          await saveAccount(prisoner);
          if (isExternal) await saveAccount(acc);
          else await saveAccount(acc);

          const flavour = [
              'You hot-wired a police car and drove through the front gate.',
              'You used a rubber duck as a distraction. It worked.',
              'You dug a tunnel in 45 seconds using a plastic spoon.',
              'You told the guard you were the warden\'s nephew. He believed you.',
          ][Math.floor(Math.random() * 4)];

          return conn.sendMessage(m.chat, {
              text: [
                  `🚨 *JAILBREAK SUCCESSFUL!*`,
                  ``,
                  isExternal ? `@${id} broke @${prisonerId} out of jail!` : `You broke out of jail!`,
                  ``,
                  `📖 *${flavour}*`,
                  ``,
                  isExternal ? `@${prisonerId} is free!` : `You're free! Don't get caught again.`
              ].join('\n'),
              mentions: isExternal ? [toJid(id), toJid(prisonerId)] : [toJid(id)]
          }, { quoted: mek });
      } else {
          // Failed — guards add significant time + raise crime level
          const extra = 30 * 60 * 1000; // 30 min added, not 5
          if (!isExternal) {
              acc.jailedUntil = (acc.jailedUntil || now()) + extra;
              acc.crimeLevel  = Math.min(100, (acc.crimeLevel || 0) + 15);
          }
          await saveAccount(acc);
          const failFlavour = [
              'You slipped on a wet floor in the hallway.',
              'The guard dog was unimpressed by your disguise.',
              'You forgot which way was out.',
              'Security spotted you immediately. You were wearing a striped shirt.',
          ][Math.floor(Math.random() * 4)];
          return reply([
              `🚨 *JAILBREAK FAILED!*`,
              ``,
              `📖 *${failFlavour}*`,
              ``,
              isExternal ? `@${prisonerId} is still locked up.` : `+5 minutes added to your sentence.`,
          ].join('\n'));
      }
  } catch(e) { console.error('jailbreak error', e); }
});

// =============================================================================
// MESSAGE EXP ENGINE
const msgExpThrottle = new Map();
function canAwardMsgExp(group, user) {
  const k = `${group}|${user}`;
  const last = msgExpThrottle.get(k) || 0;
  if (now() - last < 60*1000) return false;
  msgExpThrottle.set(k, now());
  return true;
}

function registerEconomy(conn) {
  try {
    conn.ev.on("messages.upsert", async (up) => {
      try {
        const mek = up.messages[0];
        if (!mek || !mek.message) return;
        const from = mek.key.remoteJid;
        if (!from || !from.endsWith("@g.us")) return;

        const sender = mek.key.participant || mek.key.remoteJid;
        if (!sender) return;
        if (!canAwardMsgExp(from, sender)) return;

        const id = await getPlayerId(conn, sender);
        const acc = await getAccount(id);

        if (isHospitalized(acc)) return;
        if (isKidnapped(acc)) return;

        const leveled = await addExp(acc, 1);
        if (leveled) {
            // Level-up through chatting is silent — XP/level still awarded, no announcement
        }
      } catch (e) { }
    });
    console.log("✅ Economy/RPG: registered message EXP listener.");
  } catch (e) {
    console.error("Economy/RPG: failed to register listener", e);
  }
}

// exports
module.exports = {
  getAccount,
  saveAccount,
  registerEconomy
};

cast({ pattern: "workingstats", desc: "View your working stats (Manual Labor, Intelligence, Endurance)", category: "rpg", filename: __filename }, async (conn, mek, m, { reply }) => {
  try {
      const id  = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const manualLabor = acc.manualLabor || 0;
      const intelligence = acc.intelligence || 1;
      const endurance   = acc.endurance || 0;
      const nerve       = acc.nerve ?? 60;
      const maxNerve    = acc.maxNerve || (60 + Math.floor((acc.level||1)/5));
      const total       = manualLabor + intelligence + endurance;
      return reply([
          `📊 *WORKING STATS — ${acc.username || id}*`, ``,
          `💪 Manual Labor: *${manualLabor.toLocaleString()}*`,
          `   Grows from: shifts, obby, physical work`,
          `🧠 Intelligence: *${intelligence.toLocaleString()}*`,
          `   Grows from: education, crimes, studying`,
          `🏃 Endurance: *${endurance.toLocaleString()}*`,
          `   Grows from: training, obby courses, fights`,
          `😤 Nerve: *${nerve}/${maxNerve}*`,
          `   Used for: crimes | Regens 1 per 5 minutes`,
          ``,
          `📈 Total Working Stats: *${total.toLocaleString()}*`
      ].join('\n'));
  } catch(e) { console.error('workingstats error', e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND: pay — Alias for wire (friendlier name)
// ─────────────────────────────────────────────────────────────────────────────
cast({ pattern: "pay", desc: "pay @player <amount> — Alias for wire", category: "rpg", filename: __filename }, async (conn, mek, m, { args, reply }) => {
  try {
      // Just forward to wire logic
      const id = await getPlayerId(conn, m.sender);
      const acc = await getAccount(id);
      const targetId = await getTargetId(conn, mek, args, 0);
      const amount = parseInt(args[1]);
      if (!targetId || !amount || amount <= 0) return reply(`Usage: pay @player <amount>\nThis is an alias for *wire* — 10% transfer fee applies.`);
      if ((acc.money||0) < -100000) return reply(`🔴 Your wallet is ${fmtMoney(acc.money)}. Clear your debts first.`);
      const rec = await getAccount(targetId);
      const wireFee = Math.ceil(amount * 0.10);
      const totalCost = amount + wireFee;
      if (acc.money < totalCost) return reply(`Not enough funds. Need ${fmtMoney(totalCost)} (amount + 10% fee). Have ${fmtMoney(acc.money)}.`);
      acc.money -= totalCost;
      rec.money = Math.min(999000000000, (rec.money||0) + amount);
      const loanMsg = tryDeductLoan(rec, amount, `Payment from @${id}`);
      logFinancial(acc, `Pay → @${targetId}`, -totalCost);
      logFinancial(rec, `Pay ← @${id}`, amount);
      await saveAccount(acc); await saveAccount(rec);
      return conn.sendMessage(m.chat, { text: `💸 Sent *${fmtMoney(amount)}* to @${targetId}\n🏛️ Fee (10%): -${fmtMoney(wireFee)}${loanMsg}`, mentions: [toJid(targetId)] }, { quoted: mek });
  } catch(e) { console.error('pay error', e); }
});
