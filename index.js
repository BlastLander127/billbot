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

// ✅ DEFAULTS so data.* always exist
const DEFAULT_DATA = {
  daily: {},
  weekly: {},
  monthly: {},
  allTime: {}, // ✅ NEW
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
      allTime: raw.allTime || {} // ✅ NEW
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

// ✅ Google Sheets init + logger (google-spreadsheet v5+)
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

async function logBillEvent({ groupId, user }) {
  if (!sheetEvents) return;

  try {
    await sheetEvents.addRow({
      timestamp: new Date().toISOString(),
      group_id: groupId,
      user,
      word: "bill"
    });
    // console.log("Sheet row added.");
  } catch (e) {
    console.error("Failed to add sheet row:", e);
  }
}

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

async function rebuildCountsFromSheet() {
  if (!sheetEvents) {
    console.log("No sheetEvents yet; skipping rebuild.");
    return;
  }

  console.log("Rebuilding counts from Google Sheet...");

  const now = new Date();
  const nowOrd = nyOrdinalDay(now);
  const nowYM = getNyYMD(now).ym;
  const weekStartOrd = nowOrd - getNyWeekdayIndex(now); // Sunday 00:00 NY

  const daily = {};
  const weekly = {};
  const monthly = {};
  const allTime = {};

  const rows = await sheetEvents.getRows();

  for (const r of rows) {
    const ts = r.timestamp;
    const user = r.user;

    if (!ts || !user) continue;

    const dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) continue;

    const ord = nyOrdinalDay(dt);
    const ym = getNyYMD(dt).ym;

    allTime[user] = (allTime[user] || 0) + 1;

    if (ym === nowYM) {
      monthly[user] = (monthly[user] || 0) + 1;
    }

    if (ord >= weekStartOrd) {
      weekly[user] = (weekly[user] || 0) + 1;
    }

    if (ord === nowOrd) {
      daily[user] = (daily[user] || 0) + 1;
    }
  }

  data.daily = daily;
  data.weekly = weekly;
  data.monthly = monthly;
  data.allTime = allTime;
  data.lastReset = new Date().toISOString();

  saveData();

  console.log("Rebuild complete.", {
    dailyUsers: Object.keys(daily).length,
    weeklyUsers: Object.keys(weekly).length,
    monthlyUsers: Object.keys(monthly).length,
    allTimeUsers: Object.keys(allTime).length,
    rows: rows.length
  });
}

// ✅ Build the "8PM" leaderboard text
function build8pmLeaderboardText() {
  const dailyTop = getTopThree(data.daily);
  const weeklyTop = getTopThree(data.weekly);
  const monthlyTop = getTopThree(data.monthly);
  const allTimeTop = getTopThree(data.allTime); // ✅ NEW

  let message = "📊 BILL LEADERBOARD\n\n";

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

// ✅ Post the 8PM leaderboard (optionally reset daily)
async function post8pmLeaderboard({ resetDaily = false } = {}) {
  const message = build8pmLeaderboardText();
  await postMessage(message);

  if (resetDaily) {
    data.daily = {};
    saveData();
  }
}

app.post("/", async (req, res) => {
  console.log("WEBHOOK HIT:", JSON.stringify(req.body));
  try {
    if (req.body.sender_type === "bot") return res.sendStatus(200);

    const normalized = (req.body.text || "").trim().toLowerCase();
    const user = req.body.name;
    const groupId = req.body.group_id;

    // ✅ Chat command to test the 8PM board from inside the chat
    // Type: !test8
    if (normalized === "!test8") {
      await post8pmLeaderboard({ resetDaily: false });
      return res.sendStatus(200);
    }

    if (normalized === "bill") {
      incrementCount(user);

      // ✅ Persist every event to Google Sheets
      await logBillEvent({ groupId, user });

      const msg =
        "📊 BILL LEADERBOARD (Today so far)\n\n" +
        formatFullLeaderboard("🔥 Today:", data.daily);

      await postMessage(msg);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// 8PM EST cron
cron.schedule(
  "0 20 * * *",
  async () => {
    await post8pmLeaderboard({ resetDaily: true });
  },
  { timezone: "America/New_York" }
);

// Weekly reset (Sunday midnight) — not required for correctness anymore, but OK to keep
cron.schedule(
  "0 0 * * 0",
  () => {
    data.weekly = {};
    saveData();
  },
  { timezone: "America/New_York" }
);

// Monthly reset — not required for correctness anymore, but OK to keep
cron.schedule(
  "0 0 1 * *",
  () => {
    data.monthly = {};
    saveData();
  },
  { timezone: "America/New_York" }
);

// Keep your URL test endpoint too (optional)
app.get("/test-8pm", async (req, res) => {
  try {
    const TEST_KEY = process.env.TEST_KEY || "123";
    if ((req.query.key || "") !== TEST_KEY) return res.status(401).send("no");

    await post8pmLeaderboard({ resetDaily: true });
    res.send("Posted 8PM leaderboard (and reset daily).");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});

// ✅ NEW: connect to Sheets then rebuild counts on startup
(async () => {
  try {
    await initSheets();
    await rebuildCountsFromSheet();
  } catch (e) {
    console.error("Startup init failed:", e);
  }
})();

app.listen(process.env.PORT || 3000, () => {
  console.log("Bill bot running");
});
});
