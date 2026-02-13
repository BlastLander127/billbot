// index.js

const express = require("express");
const fs = require("fs");
const axios = require("axios");
const cron = require("node-cron");
const { GoogleSpreadsheet } = require("google-spreadsheet"); // ✅ NEW

const app = express();
app.use(express.json());

const BOT_ID = "e64c9e04afde46600d609063d3";

// ✅ Google Sheets env vars (set these in Render)
const GSHEET_ID = process.env.GSHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

let sheetEvents = null;

// ✅ DEFAULTS so data.daily/weekly/monthly always exist even if data.json is {}
const DEFAULT_DATA = {
  daily: {},
  weekly: {},
  monthly: {},
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
      monthly: raw.monthly || {}
    };
  } catch (e) {
    console.error("Failed to read data.json, using defaults:", e);
    data = { ...DEFAULT_DATA };
  }
}

function saveData() {
  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
}

// ✅ Bulletproof increment (won't crash if structures missing)
function incrementCount(user) {
  data.daily ||= {};
  data.weekly ||= {};
  data.monthly ||= {};

  data.daily[user] = (data.daily[user] || 0) + 1;
  data.weekly[user] = (data.weekly[user] || 0) + 1;
  data.monthly[user] = (data.monthly[user] || 0) + 1;

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
  if (entries.length === 0) return out + "No bills yet today.\n";

  entries.forEach(([name, count], i) => {
    out += `${i + 1}. ${name} - ${count}\n`;
  });

  return out;
}

// ✅ Google Sheets init + logger
async function initSheets() {
  if (!GSHEET_ID || !SA_JSON) {
    console.log("Sheets not configured (missing GSHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON)");
    return;
  }

  const creds = JSON.parse(SA_JSON);
  const doc = new GoogleSpreadsheet(GSHEET_ID);

  await doc.useServiceAccountAuth({
    client_email: creds.client_email,
    private_key: creds.private_key
  });

  await doc.loadInfo();

  sheetEvents = doc.sheetsByTitle["events"];
  if (!sheetEvents) throw new Error('Sheet tab "events" not found');

  console.log("Google Sheets connected:", doc.title);
}

async function logBillEvent({ groupId, user }) {
  if (!sheetEvents) return; // If not configured, just skip

  await sheetEvents.addRow({
    timestamp: new Date().toISOString(),
    group_id: groupId,
    user,
    word: "bill"
  });
}

// ✅ Build the exact "8PM" leaderboard text in one place
function build8pmLeaderboardText() {
  const dailyTop = getTopThree(data.daily);
  const weeklyTop = getTopThree(data.weekly);
  const monthlyTop = getTopThree(data.monthly);

  let message = "📊 BILL LEADERBOARD\n\n";

  message += "🔥 Today:\n";
  dailyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  message += "\n📅 This Week:\n";
  weeklyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

  message += "\n🗓 This Month:\n";
  monthlyTop.forEach((u, i) => (message += `${i + 1}. ${u[0]} - ${u[1]}\n`));

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

      // ✅ NEW: persist every event to Google Sheets
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

// Weekly reset (Sunday midnight)
cron.schedule(
  "0 0 * * 0",
  () => {
    data.weekly = {};
    saveData();
  },
  { timezone: "America/New_York" }
);

// Monthly reset
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

// ✅ NEW: connect to Sheets on startup
initSheets().catch(console.error);

app.listen(process.env.PORT || 3000, () => {
  console.log("Bill bot running");
});
