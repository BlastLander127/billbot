const express = require("express");
const fs = require("fs");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const BOT_ID = "b7fa0f75efa4469fad8594ac70";

let data = {
  daily: {},
  weekly: {},
  monthly: {},
  lastReset: new Date().toDateString()
};

// Load existing data if exists
if (fs.existsSync("data.json")) {
  data = JSON.parse(fs.readFileSync("data.json"));
}

function saveData() {
  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
}

function incrementCount(user) {
  if (!data.daily[user]) data.daily[user] = 0;
  if (!data.weekly[user]) data.weekly[user] = 0;
  if (!data.monthly[user]) data.monthly[user] = 0;

  data.daily[user]++;
  data.weekly[user]++;
  data.monthly[user]++;

  saveData();
}

function getTopThree(obj) {
  return Object.entries(obj)
    .sort((a,b) => b[1] - a[1])
    .slice(0,3);
}

async function postMessage(text) {
  await axios.post("https://api.groupme.com/v3/bots/post", {
    bot_id: BOT_ID,
    text
  });
}

app.post("/", (req, res) => {
  const message = req.body.text;
  const user = req.body.name;

  if (message === "bill") {
    incrementCount(user);
  }

  res.sendStatus(200);
});

// 8PM EST cron
cron.schedule("0 20 * * *", async () => {
  const dailyTop = getTopThree(data.daily);
  const weeklyTop = getTopThree(data.weekly);
  const monthlyTop = getTopThree(data.monthly);

  let message = "📊 BILL LEADERBOARD\n\n";

  message += "🔥 Today:\n";
  dailyTop.forEach((u,i) => {
    message += `${i+1}. ${u[0]} - ${u[1]}\n`;
  });

  message += "\n📅 This Week:\n";
  weeklyTop.forEach((u,i) => {
    message += `${i+1}. ${u[0]} - ${u[1]}\n`;
  });

  message += "\n🗓 This Month:\n";
  monthlyTop.forEach((u,i) => {
    message += `${i+1}. ${u[0]} - ${u[1]}\n`;
  });

  await postMessage(message);

  // Reset daily
  data.daily = {};
  saveData();

}, {
  timezone: "America/New_York"
});

// Weekly reset (Sunday midnight)
cron.schedule("0 0 * * 0", () => {
  data.weekly = {};
  saveData();
}, {
  timezone: "America/New_York"
});

// Monthly reset
cron.schedule("0 0 1 * *", () => {
  data.monthly = {};
  saveData();
}, {
  timezone: "America/New_York"
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Bill bot running");
});
