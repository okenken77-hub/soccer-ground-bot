// 広島市・廿日市市 サッカー可能グラウンド 空き状況チェッカー
//
// 使い方: node check_availability.js
// 前回実行時の状態を state.json に保存し、今回との差分から
// 「新しく空きが出た」日を検出して標準出力に日本語サマリーを出す。
// 差分が無ければ "NO_CHANGES" のみを出力する。
// 初回実行時は比較対象が無いため、基準状態を保存するだけで通知はしない。

const fs = require("fs");
const path = require("path");
const { HIROSHIMA, HATSUKAICHI, DAYS_AHEAD } = require("./config");

const STATE_FILE = path.join(__dirname, "state.json");

// このスクリプトはクラウド上(UTC等)で実行される想定のため、
// 日付は必ず日本時間(JST)基準で計算する。
const JST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayStr(offsetDays = 0) {
  const now = new Date();
  const jstNowStr = JST_FORMATTER.format(now); // "YYYY-MM-DD" (JST)
  const jstMidnightUTC = new Date(jstNowStr + "T00:00:00Z");
  jstMidnightUTC.setUTCDate(jstMidnightUTC.getUTCDate() + offsetDays);
  return jstMidnightUTC.toISOString().slice(0, 10);
}

function dateRangeList(days) {
  const list = [];
  for (let i = 0; i < days; i++) list.push(todayStr(i));
  return list;
}

// ---------- 広島市 (yoyacool) ----------

async function getYoyacoolCookie() {
  const res = await fetch(
    "https://yoyacool.e-harp.jp/facility/FacilitySearch/Index",
    { redirect: "manual" }
  );
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

async function fetchHiroshimaFacility(cookie, facility, startDate, endDate) {
  const body = {
    startDate,
    endDate,
    roomCode: null,
    courtSize: null,
    utilizationPurpose: [HIROSHIMA.utilizationPurpose],
    usePeople: null,
    room: { roomCode: facility.roomCode, roomName: facility.roomName },
    toggleTimeType: false,
    usageTimes: null,
    usagePeriodOfTime: null,
    allowInternetRequest: null,
    requestId: null,
    period: 35,
  };
  const url = `https://yoyacool.e-harp.jp/facility/FacilityAvailability/GetCalendar/${HIROSHIMA.lgc}/${facility.fc}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`yoyacool ${facility.name}: HTTP ${res.status}`);
  }
  const data = await res.json();
  const byDate = {};
  for (const db of data.dayBooks || []) {
    const date = db.usageDate.slice(0, 10);
    byDate[date] = db.statusType; // "A01"=利用可能 / "R03"=空きなし / それ以外=対象外(過去など)
  }
  return byDate;
}

async function collectHiroshima() {
  const cookie = await getYoyacoolCookie();
  const start = todayStr(0);
  const end = todayStr(DAYS_AHEAD);
  const result = {};
  for (const facility of HIROSHIMA.facilities) {
    try {
      result[facility.fc] = await fetchHiroshimaFacility(
        cookie,
        facility,
        start,
        end
      );
    } catch (err) {
      console.error(`[warn] ${facility.name} の取得に失敗: ${err.message}`);
      result[facility.fc] = null; // 失敗は状態未取得として扱う（誤通知を避ける）
    }
  }
  return result;
}

// ---------- 廿日市市 (hatsukaichi-sports.net) ----------

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  const h = Math.floor(min / 60)
    .toString()
    .padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function isFirstWednesday(dateStr) {
  // dateStr は JST 上の日付。実行環境のタイムゾーンに依存しないよう UTC getter を使う。
  const d = new Date(dateStr + "T00:00:00+09:00");
  if (d.getUTCDay() !== 3) return false; // 0=Sun ... 3=Wed
  return d.getUTCDate() <= 7;
}

// 予約済み区間を差し引いた空き時間帯（分単位）のリストを返す
function computeFreeIntervals(openMin, closeMin, bookedIntervals) {
  const sorted = bookedIntervals
    .slice()
    .sort((a, b) => a.from - b.from)
    .map((iv) => ({
      from: Math.max(iv.from, openMin),
      to: Math.min(iv.to, closeMin),
    }))
    .filter((iv) => iv.from < iv.to);

  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= last.to) {
      last.to = Math.max(last.to, iv.to);
    } else {
      merged.push({ ...iv });
    }
  }

  const free = [];
  let cursor = openMin;
  for (const iv of merged) {
    if (iv.from > cursor) free.push({ from: cursor, to: iv.from });
    cursor = Math.max(cursor, iv.to);
  }
  if (cursor < closeMin) free.push({ from: cursor, to: closeMin });
  return free;
}

async function collectHatsukaichi() {
  const res = await fetch(HATSUKAICHI.scheduleUrl);
  if (!res.ok) throw new Error(`hatsukaichi schedule.json: HTTP ${res.status}`);
  const events = await res.json();

  const dates = dateRangeList(DAYS_AHEAD);
  const result = {};

  for (const group of HATSUKAICHI.groups) {
    const byDate = {};
    const openMin = timeToMinutes(group.openTime);
    const closeMin = timeToMinutes(group.closeTime);

    for (const date of dates) {
      if (group.closedRule === "first-wednesday" && isFirstWednesday(date)) {
        byDate[date] = []; // 休場日：空きなし扱い
        continue;
      }
      const dateSlash = date.replace(/-/g, "/");
      const booked = events
        .filter((e) => group.facNames.includes(e.fac) && e.date === dateSlash)
        .map((e) => ({ from: e.time.from, to: e.time.to }));
      const free = computeFreeIntervals(openMin, closeMin, booked);
      byDate[date] = free.map((iv) => `${minutesToTime(iv.from)}-${minutesToTime(iv.to)}`);
    }
    result[group.key] = byDate;
  }
  return result;
}

// ---------- 差分検出 ----------

function diffHiroshima(prev, curr) {
  const lines = [];
  if (!prev) return lines;
  for (const facility of HIROSHIMA.facilities) {
    const prevByDate = prev[facility.fc];
    const currByDate = curr[facility.fc];
    if (!prevByDate || !currByDate) continue;
    for (const date of Object.keys(currByDate)) {
      const prevStatus = prevByDate[date];
      const currStatus = currByDate[date];
      if (prevStatus === undefined) continue; // 前回未追跡の日は比較対象外
      if (prevStatus !== "A01" && currStatus === "A01") {
        lines.push(`[広島市] ${facility.name}(${facility.area}) ${date} に空きが出ました`);
      }
    }
  }
  return lines;
}

function diffHatsukaichi(prev, curr) {
  const lines = [];
  if (!prev) return lines;
  for (const group of HATSUKAICHI.groups) {
    const prevByDate = prev[group.key];
    const currByDate = curr[group.key];
    if (!prevByDate || !currByDate) continue;
    for (const date of Object.keys(currByDate)) {
      const prevIntervals = prevByDate[date];
      const currIntervals = currByDate[date];
      if (prevIntervals === undefined) continue;
      const prevSet = new Set(prevIntervals);
      const newIntervals = currIntervals.filter((iv) => !prevSet.has(iv));
      if (newIntervals.length > 0) {
        lines.push(
          `[廿日市市] ${group.label} ${date} に空き時間が発生: ${newIntervals.join(", ")}`
        );
      }
    }
  }
  return lines;
}

// ---------- メイン ----------

async function main() {
  const prevState = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : null;

  const [hiroshima, hatsukaichi] = await Promise.all([
    collectHiroshima(),
    collectHatsukaichi(),
  ]);

  const newState = { checkedAt: new Date().toISOString(), hiroshima, hatsukaichi };
  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), "utf8");

  if (!prevState) {
    console.log("BASELINE_INITIALIZED");
    return;
  }

  const lines = [
    ...diffHiroshima(prevState.hiroshima, hiroshima),
    ...diffHatsukaichi(prevState.hatsukaichi, hatsukaichi),
  ];

  if (lines.length === 0) {
    console.log("NO_CHANGES");
  } else {
    console.log("NEW_OPENINGS_FOUND");
    for (const line of lines) console.log(line);
  }
}

main().catch((err) => {
  console.error("FATAL_ERROR", err);
  process.exit(1);
});
