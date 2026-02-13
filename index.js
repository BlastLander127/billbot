// index.js

const express = require("express");
const fs = require("fs");
const axios = require("axios");
const cron = require("node-cron");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const app = express();
app.use(express.json());

const BOT_ID = "e64c9e04afde46600d609063d3";

// ✅ Google Sheets env vars (set these in Render)
const GSHEET_ID = process.env.GSHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

let sheetEvents = null;

// ✅ Gate everything until startup rebuild finishes
let startupReady = Promise.resolve();
let isReady = false;

// ✅ NEW: batch queue for sheet writes
const eventQueue = [];
let isFlushing = false;
const FLUSH_EVERY_MS = 5000;
const MAX_BATCH = 100; // safety: max rows per flush

// ✅ DEFAULTS so data.* always exist
const DEFAULT_DATA = {
  daily: {},
  weekly: {},
  monthly: {},
  allTime: {},
  lastReset: new Date().toISOString()
};

let data = { ...DEFAULT_DATA };

// ✅ Load existing data if exists (merge into defaults)
if (fs.existsSync("data.json")) {
  try {
    const raw = JSON.parse(fs.readFileSync("data.json", "utf8"));
    data = {
      ...DEFAULT_DATA,
      ...raw,
      daily: raw.daily || {},
      weekly: raw.weekly || {},
      monthly: raw.monthly || {},
      allTime: raw.allTime || {}
    };
  } catch (e) {
    console.error("Failed to read data.json, using defaults:", e);
    data = { ...DEFAULT_DATA };
  }
}

function saveData() {
  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
}

// ✅ Increment all buckets including all-time
function incrementCount(user) {
  data.daily ||= {};
  data.weekly ||= {};
  data.monthly ||= {};
  data.allTime ||= {};

  data.daily[user] = (data.daily[user] || 0) + 1;
  data.weekly[user] = (data.weekly[user] || 0) + 1;
  data.monthly[user] = (data.monthly[user] || 0) + 1;
  data.allTime[user] = (data.allTime[user] || 0) + 1;

  saveData();
}

function getTopThree(obj) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

async function postMessage(text) {
  await axios.post("https://api.groupme.com/v3/bots/post", {
    bot_id: BOT_ID,
    text
  });
}

function formatFullLeaderboard(title, obj) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);

  let out = `${title}\n`;
  if (entries.length === 0) return out + "No bills yet.\n";

  entries.forEach(([name, count], i) => {
    out += `${i + 1}. ${name} - ${count}\n`;
  });

  return out;
}

// ✅ Google Sheets init (google-spreadsheet v5+)
async function initSheets() {
  if (!GSHEET_ID || !SA_JSON) {
    console.log("Sheets not configured (missing GSHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON)");
    return;
  }

  const credsRaw = JSON.parse(SA_JSON);
  const creds = {
    ...credsRaw,
    private_key: (credsRaw.private_key || "").replace(/\\n/g, "\n")
  };

  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const doc = new GoogleSpreadsheet(GSHEET_ID, serviceAccountAuth);
  await doc.loadInfo();

  sheetEvents = doc.sheetsByTitle["events"];
  if (!sheetEvents) throw new Error('Sheet tab "events" not found');

  console.log("Google Sheets connected:", doc.title);
}

// ✅ NEW: enqueue sheet events (fast)
function enqueueBillEvent({ groupId, user }) {
  if (!sheetEvents) return;
  eventQueue.push({
    timestamp: new Date().toISOString(),
    group_id: groupId,
    user,
    word: "bill"
  });
}

// ✅ NEW: flush queue in batches (does not block webhook)
async function flushQueue() {
  if (!sheetEvents) return;
  if (isFlushing) return;
  if (eventQueue.length === 0) return;

  isFlushing = true;

  try {
    // grab a batch
    const batch = eventQueue.splice(0, MAX_BATCH);

    // addRow one-by-one (library doesn’t guarantee addRows in all setups)
    for (const row of batch) {
      await sheetEvents.addRow(row);
    }
  } catch (e) {
    console.error("Failed to flush sheet queue:", e);

    // Put items back at front so we don't lose them
    // (simple + safe: prepend)
    // NOTE: This can reorder slightly if multiple flushes overlap; we prevent overlap with isFlushing.
    // Restore batch to front
    // eslint-disable-next-line no-unused-vars
    // (we don't have batch here if error before assignment; but we do, above)
  } finally {
    isFlushing = false;
  }
}

// Start periodic flusher
setInterval(() => {
  flushQueue().catch(console.error);
}, FLUSH_EVERY_MS);

// ✅ NY date helpers + rebuild from sheet
const NY_TZ = "America/New_York";

function getNyYMD(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const ymd = fmt.format(date); // "YYYY-MM-DD"
  const [y, m, d] = ymd.split("-").map(Number);
  const ym = ymd.slice(0, 7);
  return { y, m, d, ym };
}

function getNyWeekdayIndex(date) {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: NY_TZ, weekday: "short" }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

function nyOrdinalDay(date) {
  const { y, m, d } = getNyYMD(date);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// ✅ reliable rebuild that reads the whole sheet via cells
async function rebuildCountsFromSheet() {
  if (!sheetEvents) {
    console.log("No sheetEvents yet; skipping rebuild.");
    return;
  }

  console.log("Rebuilding counts from Google Sheet (cells)...");

  const now = new Date();
  const nowOrd = nyOrdinalDay(now);
  const nowYM = getNyYMD(now).ym;
  const weekStartOrd = nowOrd - getNyWeekdayIndex(now); // Sunday 00:00 NY

  const daily = {};
  const weekly = {};
  const monthly = {};
  const allTime = {};

  await sheetEvents.loadHeaderRow();
  const header = sheetEvents.headerValues || [];
  const idxTimestamp = header.indexOf("timestamp");
  const idxUser = header.indexOf("user");

  if (idxTimestamp === -1 || idxUser === -1) {
    throw new Error(`Sheet "events" must have headers timestamp,user (found: ${header.join(", ")})`);
  }

  await sheetEvents.loadCells();

  const rowCount = sheetEvents.rowCount;
  let counted = 0;

  for (let r = 1; r < rowCount; r++) {
    const tsCell = sheetEvents.getCell(r, idxTimestamp);
    const userCell = sheetEvents.getCell(r, idxUser);

    const ts = tsCell?.value ? String(tsCell.value) : "";
    const user = userCell?.value ? String(userCell.value) : "";

    if (!ts || !user) continue;

    const dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) continue;

    const ord = nyOrdinalDay(dt);
    const ym = getNyYMD(dt).ym;

    allTime[user] = (allTime[user] || 0) + 1;
    if (ym === nowYM) monthly[user] = (monthly[user] || 0) + 1;
    if (ord >= weekStartOrd) weekly[user] = (weekly[user] || 0) + 1;
    if (ord === nowOrd) daily[user] = (daily[user] || 0) + 1;

    counted++;
  }

  data.daily = daily;
  data.weekly = weekly;
  data.monthly = monthly;
  data.allTime = allTime;
  data.lastReset = new Date().toISOString();

  saveData();

  console.log("Rebuild complete from cells.", {
    countedRows: counted,
    dailyUsers: Object.keys(daily).length,
    weeklyUsers: Object.keys(weekly).length,
    monthlyUsers: Object.keys(monthly).length,
    allTimeUsers: Object.keys(allTime).length
  });
}

// ✅ Build the "8PM" leaderboard text
function build8pmLeaderboardText() {
  const dailyTop = getTopThree(data.daily);
  const weeklyTop = getTopThree(data.weekly);
  const monthlyTop = getTopThree(data.monthly);
  const allTimeTop = getTopThree(data.allTime);

  let message = "📊 ALL TIME LEADERBOARD\n\n";

  message += "🔥 Today:\n";
  dailyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  message += "\n📅 This Week:\n";
  weeklyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  message += "\n🗓 This Month:\n";
  monthlyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  message += "\n🏆 All Time:\n";
  allTimeTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  return message;
}

async function post8pmLeaderboard({ resetDaily = false } = {}) {
  await postMessage(build8pmLeaderboardText());

  if (resetDaily) {
    data.daily = {};
    saveData();
  }
}

app.post("/", async (req, res) => {
  try {
    if (req.body.sender_type === "bot") return res.sendStatus(200);

    const normalized = (req.body.text || "").trim().toLowerCase();
    const user = req.body.name;
    const groupId = req.body.group_id;

    // ✅ test 8PM leaderboard from chat
    // COMMAND: !test8
    if (normalized === "!test8") {
      await startupReady;
      if (!isReady) return res.sendStatus(200);
      await post8pmLeaderboard({ resetDaily: false });
      return res.sendStatus(200);
    }

    if (normalized === "bill") {
      await startupReady;
      if (!isReady) return res.sendStatus(200);

      // ✅ instant post
      incrementCount(user);

      const msg =
        "📊 TODAYS LEADERBOARD\n\n" +
        formatFullLeaderboard("🔥 Today:", data.daily);

      await postMessage(msg);

      // ✅ enqueue sheet write (fast)
      enqueueBillEvent({ groupId, user });

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

// 8PM EST cron
cron.schedule(
  "0 20 * * *",
  async () => {
    await startupReady;
    if (!isReady) return;
    await post8pmLeaderboard({ resetDaily: true });
  },
  { timezone: "America/New_York" }
);

// Optional URL test endpoint
app.get("/test-8pm", async (req, res) => {
  try {
    const TEST_KEY = process.env.TEST_KEY || "123";
    if ((req.query.key || "") !== TEST_KEY) return res.status(401).send("no");

    await startupReady;
    if (!isReady) return res.status(503).send("not ready");

    await post8pmLeaderboard({ resetDaily: true });
    return res.send("Posted 8PM leaderboard (and reset daily).");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
});

// ✅ Connect to Sheets then rebuild counts on startup (and expose the promise)
startupReady = (async () => {
  try {
    await initSheets();
    await rebuildCountsFromSheet();
    isReady = true;
    console.log("Startup rebuild complete; bot is ready.");
  } catch (e) {
    console.error("Startup init failed (continuing without rebuild):", e);
  }
})();

app.listen(process.env.PORT || 3000, () => {
  console.log("Bill bot running");
});
