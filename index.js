const express = require("express");
const fs = require("fs");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const BOT_ID = "b7fa0f75efa4469fad8594ac70";

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

app.post("/", async (req, res) => {
  console.log("WEBHOOK HIT:", JSON.stringify(req.body));
  try {
    if (req.body.sender_type === "bot") return res.sendStatus(200);

    // ✅ Normalize so Bill / bill / " bill " works, but "utility bill" does NOT
    const normalized = (req.body.text || "").trim().toLowerCase();
    const user = req.body.name;

    if (normalized === "bill") {
      incrementCount(user);

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
    const dailyTop = getTopThree(data.daily);
    const weeklyTop = getTopThree(data.weekly);
    const monthlyTop = getTopThree(data.monthly);

    let message = "📊 BILL LEADERBOARD\n\n";

    message += "🔥 Today:\n";
    dailyTop.forEach((u, i) => {
      message += `${i + 1}. ${u[0]} - ${u[1]}\n`;
    });

    message += "\n📅 This Week:\n";
    weeklyTop.forEach((u, i) => {
      message += `${i + 1}. ${u[0]} - ${u[1]}\n`;
    });

    message += "\n🗓 This Month:\n";
    monthlyTop.forEach((u, i) => {
      message += `${i + 1}. ${u[0]} - ${u[1]}\n`;
    });

    await postMessage(message);

    // Reset daily
    data.daily = {};
    saveData();
  },
  {
    timezone: "America/New_York"
  }
);

// Weekly reset (Sunday midnight)
cron.schedule(
  "0 0 * * 0",
  () => {
    data.weekly = {};
    saveData();
  },
  {
    timezone: "America/New_York"
  }
);

// Monthly reset
cron.schedule(
  "0 0 1 * *",
  () => {
    data.monthly = {};
    saveData();
  },
  {
    timezone: "America/New_York"
  }
);

app.listen(process.env.PORT || 3000, () => {
  console.log("Bill bot running");
});
