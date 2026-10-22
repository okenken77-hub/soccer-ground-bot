// 広島市・廿日市市 サッカー可能グラウンド 空き状況チェッカー
//
// 使い方: node check_availability.js
// 前回実行時の状態を state.json に保存し、今回との差分から
// 「新しく空きが出た」日を検出して標準出力に日本語サマリーを出す。
// 差分が無ければ "NO_CHANGES" のみを出力する。
// 初回実行時は比較対象が無いため、基準状態を保存するだけで通知はしない。

const fs = require("fs");
const path = require("path");
const { HIROSHIMA, HATSUKAICHI, KANON, DAYS_AHEAD, NIGHT_START, SYNC_DIR } = require("./config");
const { parseKanonPdf } = require("./kanon_pdf");

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

// 当日分は(時間が過ぎていたり前日までの受付だったりで)意味が薄いので、明日から数える
const FIRST_DAY_OFFSET = 1;
// 夜間枠の文字列の書式の版。変えたときは1回だけ差分通知を抑える
const NIGHT_FORMAT = 2;
// これより短い空き枠(例: 30分)は通知・一覧から除く
const MIN_SLOT_MINUTES = 60;

// 一時的な接続エラー(接続タイムアウトなど)で全体が失敗しないよう、最大4回まで再試行する
async function fetchRetry(url, options) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

function dateRangeList(days) {
  const list = [];
  for (let i = FIRST_DAY_OFFSET; i < days; i++) list.push(todayStr(i));
  return list;
}

// "17:00-21:30" や "半B 17:00-19:00" の枠の長さ(分)
function slotMinutes(r) {
  const m = String(r).match(/(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  return m ? timeToMinutes(m[2]) - timeToMinutes(m[1]) : 0;
}
function keepLong(ranges) {
  return ranges.filter((r) => slotMinutes(r) >= MIN_SLOT_MINUTES);
}

// 日付単位ステータス: "A"始まり(A01=ネット予約可 / A02=電話・窓口受付など)を空きとして扱う
function isAvailableStatus(st) {
  return typeof st === "string" && st.startsWith("A");
}

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

const NIGHT_START_MIN = timeToMinutes(NIGHT_START);
const HOLIDAYS = new Set(); // yoyacool のカレンダーAPIが返す祝日(YYYY-MM-DD)

// ---------- 広島市 (yoyacool) ----------

async function getYoyacoolCookie() {
  const res = await fetchRetry(
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
  const res = await fetchRetry(url, {
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
  for (const h of data.holidays || []) HOLIDAYS.add(h.holidayDate.slice(0, 10));
  const byDate = {};
  for (const db of data.dayBooks || []) {
    const date = db.usageDate.slice(0, 10);
    byDate[date] = db.statusType; // "A01"=利用可能 / "R03"=空きなし / それ以外=対象外(過去など)
  }
  return byDate;
}

// 1日分の時間枠別空き状況(GetDay)を取得し、18:00以降で「A」始まりのステータス
// (A01=利用可能/A02=電話・窓口受付など、いずれも予約可能な空き)が連続する区間を
// 文字列("18:00-19:30"など)のリストにして返す。
async function fetchHiroshimaNightSlotsForDate(cookie, facility, date) {
  const body = {
    startDate: date,
    endDate: date,
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
  };
  const url = `https://yoyacool.e-harp.jp/facility/FacilityAvailability/GetDay/${HIROSHIMA.lgc}/${facility.fc}`;
  const res = await fetchRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GetDay ${facility.name} ${date}: HTTP ${res.status}`);
  const data = await res.json();

  const frameDefs = {};
  for (const tf of data.timeFrames || []) {
    for (const f of tf.usageTimeFrames || []) {
      frameDefs[f.usageTimeFrameId] = {
        from: timeToMinutes(f.usageStartTime.slice(0, 5)),
        to: timeToMinutes(f.usageEndTime.slice(0, 5)),
      };
    }
  }

  const allCourts = data.rooms?.[0]?.courts || [];
  const courts = facility.multiCourt ? allCourts : allCourts.slice(0, 1);

  // 1区画分: 夜間枠のうち空き(A始まり)が連続する区間を {from,to} で返す
  const nightRanges = (court) => {
    const dayBook = court?.dayBooks?.find((db) => db.usageDate.slice(0, 10) === date);
    if (!dayBook) return [];
    const nightFrames = (dayBook.usageTimes || [])
      .map((ut) => ({ ...frameDefs[ut.usageTimeFrameId], status: ut.statusType }))
      .filter((f) => f.from !== undefined && f.from >= NIGHT_START_MIN)
      .sort((a, b) => a.from - b.from);
    const merged = [];
    for (const f of nightFrames) {
      if (!isAvailableStatus(f.status)) continue;
      const last = merged[merged.length - 1];
      if (last && f.from <= last.to) last.to = Math.max(last.to, f.to);
      else merged.push({ from: f.from, to: f.to });
    }
    return merged;
  };
  const fmt = (iv) => `${minutesToTime(iv.from)}-${minutesToTime(iv.to)}`;

  if (!facility.multiCourt) return keepLong(nightRanges(courts[0]).map(fmt));

  // 複数区画: 「全面」「半A」のように区画名を付ける。全面が空いている時間帯に含まれる半面は省く
  const shortName = (n) => String(n).normalize("NFKC").replace("1/2", "半").replace(/^運動広場/, "");
  const perCourt = courts.map((court) => ({ name: shortName(court.courtName), ranges: nightRanges(court) }));
  const full = perCourt.find((p) => p.name === "全面");
  const covered = (iv) => full && full.ranges.some((f) => f.from <= iv.from && iv.to <= f.to);
  const out = [];
  for (const p of perCourt) {
    for (const iv of p.ranges) {
      if (p !== full && covered(iv)) continue;
      out.push((p === full ? "" : p.name + " ") + fmt(iv));
    }
  }
  return keepLong(out);
}

async function fetchHiroshimaNightSlots(facility, dates, dayStatus) {
  // 他施設の問い合わせで使い回したクッキーだと、施設によってはサーバー側で
  // 500エラーになることがあるため、この施設専用に新しいセッションを取得する。
  let cookie = await getYoyacoolCookie();
  const byDate = {};
  for (const date of dates) {
    if (dayStatus) {
      const st = dayStatus[date];
      if (typeof st !== "string") continue; // 未取得
      if (st.startsWith("R")) { byDate[date] = []; continue; } // 満室
      if (!st.startsWith("A")) continue; // 受付前など
    }
    try {
      byDate[date] = await fetchHiroshimaNightSlotsForDate(cookie, facility, date);
    } catch (err) {
      // 1回だけクッキーを再取得してリトライする
      try {
        cookie = await getYoyacoolCookie();
        byDate[date] = await fetchHiroshimaNightSlotsForDate(cookie, facility, date);
      } catch (err2) {
        console.error(`[warn] ${facility.name} ${date} の夜間取得に失敗: ${err2.message}`);
        byDate[date] = undefined; // 取得失敗は未追跡として扱う
      }
    }
  }
  return byDate;
}

async function collectHiroshima() {
  const cookie = await getYoyacoolCookie();
  const start = todayStr(FIRST_DAY_OFFSET);
  const end = todayStr(DAYS_AHEAD);
  const dates = dateRangeList(DAYS_AHEAD);
  const result = {};
  for (const facility of HIROSHIMA.facilities) {
    let day = null;
    try {
      day = await fetchHiroshimaFacility(cookie, facility, start, end);
    } catch (err) {
      console.error(`[warn] ${facility.name} の取得に失敗: ${err.message}`);
    }
    let night = null;
    if (facility.hasNightFrames) {
      night = await fetchHiroshimaNightSlots(facility, dates, day);
    }
    result[facility.fc] = { day, night };
  }
  return result;
}

// ---------- 廿日市市 (hatsukaichi-sports.net) ----------

function isFirstWednesday(dateStr) {
  // dateStr ("YYYY-MM-DD") は JST 上の暦日。タイムゾーン変換によるズレを避けるため
  // UTC 深夜として解釈し、UTC getter でその暦日自体の曜日を取り出す。
  const d = new Date(dateStr + "T00:00:00Z");
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
  const res = await fetchRetry(HATSUKAICHI.scheduleUrl);
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

// ---------- 観音新町運動広場 (shinko-sports.jp) ----------

// 公開されている資料(月間予定表PDFなど)の一覧を取得する。失敗時は null を返し、全体は止めない。
async function collectKanon(prevSchedule) {
  try {
    const res = await fetchRetry(KANON.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: KANON.query }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const nodes = json?.data?.kanonGSche?.nodes || [];
    const docs = nodes
      .map((n) => ({
        title: n.title,
        url: n.files?.file?.node?.filePath ? KANON.baseUrl + encodeURI(n.files.file.node.filePath) : null,
      }))
      .filter((d) => d.url);
    const schedule = await collectKanonSchedule(docs, prevSchedule);
    return { docs, schedule };
  } catch (err) {
    console.error("[warn] 観音新町の資料一覧の取得に失敗: " + err.message);
    return null;
  }
}

// 月間予定表PDFを読み取って日付×面ごとの空き時間帯にする。失敗しても全体は止めない。
// 同じPDFなら前回の結果を使い回す。
async function collectKanonSchedule(docs, prevSchedule) {
  const doc = docs.find((d) => /\.pdf$/i.test(d.url) && /予約状況|予定表/.test(d.title));
  if (!doc) return prevSchedule || null;
  if (prevSchedule && prevSchedule.url === doc.url && prevSchedule.byDate) return prevSchedule;
  try {
    const m = doc.title.match(/(\d{4})年(\d{1,2})月/);
    if (!m) throw new Error("タイトルから年月を読み取れません: " + doc.title);
    const res = await fetchRetry(doc.url);
    if (!res.ok) throw new Error("PDF HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const byDate = await parseKanonPdf(buf, Number(m[1]), Number(m[2]));
    if (Object.keys(byDate).length < 28) throw new Error("読み取れた日数が少なすぎます: " + Object.keys(byDate).length);
    return { url: doc.url, title: doc.title, byDate };
  } catch (err) {
    console.error("[warn] 観音新町PDFの自動読み取りに失敗(リンクのみ表示): " + err.message);
    return prevSchedule && prevSchedule.url === doc.url ? prevSchedule : null;
  }
}

// 狙い目(平日=夜間18:00以降 / 土日祝=全日)に該当する空きを「日付 → ["A 18:00-21:00", ...]」にする。
function kanonTargetSlots(schedule, holidaySet = HOLIDAYS) {
  const out = {};
  if (!schedule || !schedule.byDate) return out;
  const today = todayStr(FIRST_DAY_OFFSET);
  for (const date of Object.keys(schedule.byDate).sort()) {
    if (date < today) continue;
    const off = isOffDay(date, holidaySet);
    const slots = [];
    for (const court of Object.keys(schedule.byDate[date])) {
      const ranges = off ? keepLong(schedule.byDate[date][court]) : clipToNight(schedule.byDate[date][court]);
      for (const r of ranges) slots.push(court + " " + r);
    }
    if (slots.length) out[date] = slots;
  }
  return out;
}

// 通知1行分。日付順に並べ替えるため date を持たせる
function notifyLine(date, venue, city, detail) {
  const label = formatDateJa(date) + (HOLIDAYS.has(date) ? "(祝)" : "");
  return { date, text: label + " " + venue + "〔" + city + "〕 " + detail };
}

function diffKanon(prev, curr, prevSchedule, currSchedule) {
  const lines = [];
  if (Array.isArray(prev) && Array.isArray(curr)) {
    const prevUrls = new Set(prev.map((d) => d.url));
    for (const d of curr.filter((d) => !prevUrls.has(d.url))) {
      lines.push({ date: "9999-12-31", text: KANON.label + "〔広島市〕 新しい予定表・資料が公開されました: " + d.title });
    }
  }
  if (prevSchedule && currSchedule && prevSchedule.url !== currSchedule.url) {
    const prevSlots = kanonTargetSlots(prevSchedule);
    const currSlots = kanonTargetSlots(currSchedule);
    for (const date of Object.keys(currSlots)) {
      const prevSet = new Set(prevSlots[date] || []);
      const added = currSlots[date].filter((x) => !prevSet.has(x));
      if (added.length && (date in prevSlots || prevSchedule.byDate[date])) {
        lines.push(notifyLine(date, KANON.label, "広島市", "空き(予定表の更新) " + added.map(compactRange).join(", ")));
      }
    }
  }
  return lines;
}

// ---------- 差分検出 ----------

function diffHiroshima(prev, curr) {
  const lines = [];
  if (!prev) return lines;
  for (const facility of HIROSHIMA.facilities) {
    const prevEntry = prev[facility.fc];
    const currEntry = curr[facility.fc];
    if (!prevEntry || !currEntry) continue;

    const prevByDate = prevEntry.day;
    const currByDate = currEntry.day;
    if (prevByDate && currByDate) {
      for (const date of Object.keys(currByDate)) {
        const prevStatus = prevByDate[date];
        const currStatus = currByDate[date];
        if (prevStatus === undefined) continue; // 前回未追跡の日は比較対象外
        if (!isAvailableStatus(prevStatus) && isAvailableStatus(currStatus) && isOffDay(date)) {
          lines.push(notifyLine(date, facility.name, facility.city || "広島市", "空きあり(時間帯は予約システムで確認)"));
        }
      }
    }

    const prevNight = prevEntry.night;
    const currNight = currEntry.night;
    if (prevNight && currNight) {
      for (const date of Object.keys(currNight)) {
        const prevIntervals = prevNight[date];
        const currIntervals = currNight[date];
        if (prevIntervals === undefined || currIntervals === undefined) continue;
        const prevSet = new Set(prevIntervals);
        const newIntervals = keepLong(currIntervals.filter((iv) => !prevSet.has(iv)));
        if (newIntervals.length > 0) {
          lines.push(notifyLine(date, facility.name, facility.city || "広島市", "夜間 " + newIntervals.map(compactRange).join(", ")));
        }
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
      let newIntervals = currIntervals.filter((iv) => !prevSet.has(iv));
      newIntervals = isOffDay(date) ? keepLong(newIntervals) : clipToNight(newIntervals);
      if (newIntervals.length > 0) {
        lines.push(notifyLine(date, group.label, "廿日市市", (isOffDay(date) ? "" : "夜間 ") + newIntervals.map(compactRange).join(", ")));
      }
    }
  }
  return lines;
}

// ---------- HTMLレポート生成 ----------

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function formatDateJa(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${md}(${WEEKDAY_JA[d.getUTCDay()]})`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function buildHiroshimaSection(hiroshima) {
  const rows = HIROSHIMA.facilities
    .map((facility) => {
      const byDate = hiroshima[facility.fc]?.day;
      if (!byDate) {
        return `<div class="facility"><h3>${escapeHtml(facility.name)}<span class="area">${escapeHtml(facility.area)}</span></h3><p class="empty">取得失敗(要確認)</p></div>`;
      }
      const availableDates = Object.keys(byDate)
        .filter((d) => isAvailableStatus(byDate[d]))
        .sort();
      const body = availableDates.length
        ? `<ul class="dates">${availableDates.map((d) => `<li>${formatDateJa(d)}</li>`).join("")}</ul>`
        : `<p class="empty">現在、空きなし</p>`;
      return `<div class="facility"><h3>${escapeHtml(facility.name)}<span class="area">${escapeHtml(facility.area)}</span></h3>${body}</div>`;
    })
    .join("\n");
  return rows;
}

// 夜間(18:00以降)の空きに絞ったセクション。広島市は夜間枠を持つ施設のみ、
// 廿日市市は既存の空き時間を18:00以降にクリップして表示する。
function clipToNight(intervals) {
  const result = [];
  for (const iv of intervals) {
    const [fromStr, toStr] = iv.split("-");
    const from = Math.max(timeToMinutes(fromStr), NIGHT_START_MIN);
    const to = timeToMinutes(toStr);
    if (from < to) result.push(`${minutesToTime(from)}-${minutesToTime(to)}`);
  }
  return keepLong(result);
}

// 狙い目: 平日は夜間(18:00以降)のみ、土日・祝日は全日(全時間帯)を対象にする。
function isOffDay(dateStr, holidaySet = HOLIDAYS) {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return dow === 0 || dow === 6 || holidaySet.has(dateStr);
}

function facilityCard(title, area, entries, emptyText) {
  const body = entries.length
    ? `<ul class="dates">${entries.join("")}</ul>`
    : `<p class="empty">${emptyText}</p>`;
  const areaHtml = area ? `<span class="area">${escapeHtml(area)}</span>` : "";
  return `<div class="facility"><h3>${escapeHtml(title)}${areaHtml}</h3>${body}</div>`;
}

function entryHtml(d, text, off) {
  const cls = off ? ' class="off"' : "";
  return `<li${cls}>${formatDateJa(d)} <span class="slots">${text}</span></li>`;
}

function buildTargetSection(state) {
  const { hiroshima, hatsukaichi } = state;
  const holidays = new Set(state.holidays || []);
  const blocks = [];

  for (const facility of HIROSHIMA.facilities) {
    const entry = hiroshima[facility.fc];
    if (!entry || !entry.day) {
      blocks.push(facilityCard(facility.name, facility.area, [], "取得失敗(要確認)"));
      continue;
    }
    const night = entry.night || {};
    const entries = Object.keys(entry.day)
      .sort()
      .map((d) => {
        const off = isOffDay(d, holidays);
        const nightSlots = night[d] || [];
        if (off) {
          if (!isAvailableStatus(entry.day[d])) return null;
          return entryHtml(d, nightSlots.length ? "全日 / 夜 " + nightSlots.join(", ") : "全日", true);
        }
        return nightSlots.length ? entryHtml(d, nightSlots.join(", "), false) : null;
      })
      .filter(Boolean);
    blocks.push(facilityCard(facility.name, facility.area, entries, "現在、該当する空きなし"));
  }

  for (const group of HATSUKAICHI.groups) {
    const byDate = hatsukaichi[group.key];
    if (!byDate) {
      blocks.push(facilityCard(group.label, "", [], "取得失敗(要確認)"));
      continue;
    }
    const entries = Object.keys(byDate)
      .sort()
      .map((d) => {
        const off = isOffDay(d, holidays);
        const slots = off ? keepLong(byDate[d] || []) : clipToNight(byDate[d] || []);
        return slots.length ? entryHtml(d, slots.join(", "), off) : null;
      })
      .filter(Boolean);
    blocks.push(facilityCard(group.label, "", entries, "現在、該当する空きなし"));
  }

  return blocks.join("\n");
}

function buildHatsukaichiSection(hatsukaichi) {
  const rows = HATSUKAICHI.groups
    .map((group) => {
      const byDate = hatsukaichi[group.key];
      if (!byDate) {
        return `<div class="facility"><h3>${escapeHtml(group.label)}</h3><p class="empty">取得失敗(要確認)</p></div>`;
      }
      const entries = Object.keys(byDate)
        .filter((d) => byDate[d] && byDate[d].length > 0)
        .sort()
        .map((d) => `<li>${formatDateJa(d)} <span class="slots">${byDate[d].join(", ")}</span></li>`);
      const body = entries.length
        ? `<ul class="dates">${entries.join("")}</ul>`
        : `<p class="empty">現在、空きなし</p>`;
      return `<div class="facility"><h3>${escapeHtml(group.label)}</h3>${body}</div>`;
    })
    .join("\n");
  return rows;
}

function buildKanonCard(kanon, schedule, holidaySet) {
  const slots = kanonTargetSlots(schedule, holidaySet);
  const entries = Object.keys(slots).map((d) => {
    const off = isOffDay(d, holidaySet);
    return entryHtml(d, slots[d].join(" / "), off);
  });
  const asOf = schedule ? escapeHtml(schedule.title) : "";
  const slotBlock = schedule
    ? `<p class="note" style="margin:8px 0 4px">狙い目の空き(自動読み取り・参考値): ${asOf}</p>
    ${entries.length ? `<ul class="dates">${entries.join("")}</ul>` : '<p class="empty">現在、該当する空きなし</p>'}
    <p class="note">※ 予定表の公開時点の情報です。以降に入った予約は反映されません。A〜Dは4面の区画です。</p>`
    : '<p class="note">予定表の自動読み取りができませんでした。下のPDFを直接ご確認ください。</p>';
  const links = (kanon || [])
    .map((d) => `<li><a href="${escapeHtml(d.url)}" target="_blank">${escapeHtml(d.title)}</a></li>`)
    .join("");
  return `<h2>${escapeHtml(KANON.label)}</h2>
  <div class="facility">
    <p class="note" style="margin:0 0 8px">9:00-21:00・水曜休場。予約状況は管理者が公開する月間予定表PDFで確認します(サッカー利用可否・抽選は電話 ${escapeHtml(KANON.phone)})。</p>
    ${slotBlock}
    <ul class="links">${links || "<li>資料を取得できませんでした</li>"}</ul>
    <p class="note"><a href="${escapeHtml(KANON.pageUrl)}" target="_blank">施設ページ</a></p>
  </div>`;
}

// ---------- 月別 会場×日付 一覧 ----------

// "09:00-10:00" -> "9-10", "18:30-21:30" -> "18:30-21:30"
function compactRange(r) {
  const m = r.match(/^(.*?)(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return r;
  const f = (t) => (t.endsWith(":00") ? String(Number(t.slice(0, -3))) : t.replace(/^0/, ""));
  return m[1] + f(m[2]) + "-" + f(m[3]);
}

// 面ごとの空きを、同じ時間帯の面でまとめる ("ABCD 18-19")
function groupCourts(perCourt, clip) {
  const byKey = {};
  for (const court of Object.keys(perCourt).sort()) {
    const ranges = clip ? clipToNight(perCourt[court]) : keepLong(perCourt[court]);
    if (!ranges.length) continue;
    const key = ranges.map(compactRange).join(", ");
    (byKey[key] = byKey[key] || []).push(court);
  }
  return Object.keys(byKey).map((k) => byKey[k].join("") + " " + k);
}

// 市町ごとの色分け(広島市=h / 廿日市市=t / その他=o)
function cityClass(city) {
  return city === "広島市" ? "h" : city === "廿日市市" ? "t" : "o";
}

// 1マス分の内容。level: target(狙い目) / avail(狙い目外の空き) / none(空きなし) / na(情報なし)
function matrixCell(venue, date, state, holidaySet, nightOnly) {
  const off = isOffDay(date, holidaySet);
  if (nightOnly) return matrixNightCell(venue, date, state);
  if (venue.type === "hiroshima") {
    const e = state.hiroshima[venue.fc];
    const st = e && e.day ? e.day[date] : undefined;
    if (st === undefined) return { text: "–", level: "na" };
    const night = (e.night && e.night[date]) || [];
    if (!isAvailableStatus(st)) return String(st).startsWith("R") ? { text: "×", level: "none" } : { text: "–", level: "na" };
    const parts = ["○"];
    if (night.length) parts.push("夜 " + night.map(compactRange).join(", "));
    const target = off || night.length > 0;
    return { text: parts.join(" "), level: target ? "target" : "avail" };
  }
  if (venue.type === "hatsukaichi") {
    const byDate = state.hatsukaichi[venue.key];
    const free = byDate ? byDate[date] : undefined;
    if (free === undefined) return { text: "–", level: "na" };
    const usable = keepLong(free);
    if (!usable.length) return { text: "×", level: "none" };
    const night = clipToNight(free);
    const target = off || night.length > 0;
    return { text: usable.map(compactRange).join(", "), level: target ? "target" : "avail" };
  }
  if (venue.type === "kanon") {
    const sched = state.kanonSchedule;
    const perCourt = sched && sched.byDate ? sched.byDate[date] : undefined;
    if (!perCourt) return { text: "–", level: "na" };
    const all = groupCourts(perCourt, false);
    if (!all.length) return { text: "×", level: "none" };
    const targetParts = off ? all : groupCourts(perCourt, true);
    return { text: all.join(" / "), level: targetParts.length ? "target" : "avail" };
  }
  return { text: "–", level: "na" };
}

// 夜間(18:00以降)だけのマス
function matrixNightCell(venue, date, state) {
  let slots;
  if (venue.type === "hiroshima") {
    const e = state.hiroshima[venue.fc];
    slots = e && e.night ? e.night[date] : undefined;
    if (slots === undefined) return { text: "–", level: "na" };
    slots = slots.map(compactRange);
  } else if (venue.type === "hatsukaichi") {
    const free = state.hatsukaichi[venue.key] ? state.hatsukaichi[venue.key][date] : undefined;
    if (free === undefined) return { text: "–", level: "na" };
    slots = clipToNight(free).map(compactRange);
  } else {
    const perCourt = state.kanonSchedule && state.kanonSchedule.byDate ? state.kanonSchedule.byDate[date] : undefined;
    if (!perCourt) return { text: "–", level: "na" };
    slots = groupCourts(perCourt, true);
  }
  return slots.length ? { text: slots.join(" / "), level: "target" } : { text: "×", level: "none" };
}

function matrixVenues(nightOnly) {
  const nightCapable = new Set(HIROSHIMA.facilities.filter((f) => f.hasNightFrames).map((f) => f.fc));
  return [
    ...HIROSHIMA.facilities
      .filter((f) => !nightOnly || nightCapable.has(f.fc))
      .map((f) => ({ type: "hiroshima", fc: f.fc, name: f.name, city: f.city || "広島市" })),
    { type: "kanon", name: "観音新町運動広場", city: "広島市" },
    ...HATSUKAICHI.groups.map((g) => ({ type: "hatsukaichi", key: g.key, name: g.label, city: "廿日市市" })),
  ];
}

function buildMonthTable(ym, dates, state, holidaySet, nightOnly) {
  const venues = matrixVenues(nightOnly);
  const head = venues.map((v) => "<th class=\"c-" + cityClass(v.city) + "\">" + escapeHtml(v.name) + "</th>").join("");
  const rows = dates
    .map((d) => {
      const off = isOffDay(d, holidaySet);
      const cells = venues
        .map((v) => {
          const c = matrixCell(v, d, state, holidaySet, nightOnly);
          return "<td class=\"" + c.level + "\">" + escapeHtml(c.text) + "</td>";
        })
        .join("");
      return "<tr class=\"" + (off ? "off" : "") + "\"><th class=\"date\">" + formatDateJa(d) + "</th>" + cells + "</tr>";
    })
    .join("\n");
  return "<div class=\"scroll\"><table><thead><tr><th class=\"date\">日付</th>" + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
}

function generateMatrixReport(state, nightOnly = false) {
  const holidaySet = new Set(state.holidays || []);
  const dates = Object.keys(state.hatsukaichi[HATSUKAICHI.groups[0].key] || {}).sort();
  const months = [];
  for (const d of dates) {
    const ym = d.slice(0, 7);
    let m = months.find((x) => x.ym === ym);
    if (!m) months.push((m = { ym, dates: [] }));
    m.dates.push(d);
  }
  const checkedAtJst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(state.checkedAt));
  const sections = months
    .map((m, i) => {
      const label = Number(m.ym.slice(5)) + "月";
      const table = buildMonthTable(m.ym, m.dates, state, holidaySet, nightOnly);
      void i;
      return "<h2>" + label + "(" + formatDateJa(m.dates[0]) + "〜" + formatDateJa(m.dates[m.dates.length - 1]) + ")</h2>" + table;
    
})
    .join("\n");

  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>' + (nightOnly ? '夜間の空き状況一覧' : '会場別 空き状況一覧') + '</title><style>' +
    'body{font-family:-apple-system,"Segoe UI","Hiragino Sans",sans-serif;margin:0;padding:20px 16px;background:#f7f7f5;color:#222}' +
    'h1{font-size:1.2rem;margin:0 0 4px}h2{font-size:1.05rem;margin:24px 0 8px;border-bottom:2px solid #2e7d32;padding-bottom:4px}' +
    '.updated,.legend{color:#666;font-size:.8rem;margin:0 0 6px}' +
    '.scroll{overflow-x:auto;border:1px solid #ddd;border-radius:8px;background:#fff}' +
    'table{border-collapse:collapse;font-size:.75rem;white-space:nowrap}' +
    'th,td{border:1px solid #e6e6e6;padding:4px 8px;text-align:left}' +
    'thead th{position:sticky;top:0;background:#eef2ee;z-index:1;white-space:normal;min-width:84px;max-width:120px}' +
    'thead th.c-t{background:#eef0f8}thead th.c-o{background:#fbf0e3}' +
    'th.date{position:sticky;left:0;background:#fafafa;z-index:2;min-width:64px}' +
    'thead th.date{z-index:3}' +
    'tr.off th.date{background:#fde8e8;color:#b71c1c}tr.off td{background-color:#fffafa}' +
    'td.target{background:#c8e6c9;color:#1b5e20;font-weight:600}' +
    'td.avail{background:#f1f8e9;color:#33691e}td.none{color:#bbb;text-align:center}td.na{color:#ccc;text-align:center}' +
    '</style></head><body>' +
    '<h1>' + (nightOnly ? '夜間(' + NIGHT_START + '以降)の空き状況一覧' : '会場別 空き状況一覧') + '</h1>' +
    '<p class="updated">最終更新: ' + checkedAtJst + '</p>' +
    (nightOnly ? '<p class="legend">' + NIGHT_START + '以降に空いている時間帯だけを表示(曜日問わず)。×=夜間の空きなし / –=情報なし。赤い日付は土日祝。夜間の時間枠が無い広島市の5施設(西風新都東公園・若葉台中央公園・伴西公園・倉掛公園・畑賀公園)は除外しています。観音新町のA〜Dは4面の区画で、予定表PDF公開時点の情報です。廿日市市は予約が登録されていない先の日付ほど空きに見えます。</p>' : '<p class="legend">濃い緑=狙い目(平日は夜' + NIGHT_START + '以降・土日祝は全日) / 薄い緑=それ以外の空き / ×=空きなし / –=情報なし。赤い日付は土日祝。広島市の「○」は日中の空きあり(時間帯は予約システムで確認)、「夜」は18時以降の空き時間。観音新町のA〜Dは4面の区画で、予定表PDF公開時点の情報です。廿日市市は予約が登録されていない先の日付ほど空きに見えます。</p>') +
    sections + '</body></html>';
  fs.writeFileSync(path.join(__dirname, nightOnly ? "availability_matrix_night.html" : "availability_matrix.html"), html, "utf8");
}

// ---------- 土日の夜間(18:00以降)だけのリスト ----------

function generateWeekendNightList(state) {
  const venues = matrixVenues(true);
  const dates = Object.keys(state.hatsukaichi[HATSUKAICHI.groups[0].key] || {}).sort();
  const holidaySet = new Set(state.holidays || []);
  const byMonth = [];
  let total = 0;
  for (const d of dates) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    const items = [];
    for (const v of venues) {
      const c = matrixNightCell(v, d, state);
      if (c.level === "target") items.push({ v, text: c.text });
    }
    if (!items.length) continue;
    total += items.length;
    const ym = d.slice(0, 7);
    let m = byMonth.find((x) => x.ym === ym);
    if (!m) byMonth.push((m = { ym, days: [] }));
    m.days.push({ d, items });
  }

  const sections = byMonth
    .map((m) => {
      const cards = m.days
        .map(({ d, items }) => {
          const hol = holidaySet.has(d) ? '<span class="hol">祝</span>' : "";
          const lines = items
            .map(({ v, text }) => '<li><span class="city ' + cityClass(v.city) + '">' + escapeHtml(v.city) + '</span><span class="venue">' + escapeHtml(v.name) + '</span><span class="slots">' + escapeHtml(text) + '</span></li>')
            .join("");
          return '<div class="day ' + (new Date(d + "T00:00:00Z").getUTCDay() === 0 ? "sun" : "sat") + '"><h3>' + formatDateJa(d) + hol + '</h3><ul>' + lines + '</ul></div>';
        })
        .join("\n");
      return "<h2>" + Number(m.ym.slice(5)) + "月</h2>" + cards;
    })
    .join("\n");

  const checkedAtJst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(state.checkedAt));
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>土日夜間の空きリスト</title><style>' +
    'body{font-family:-apple-system,"Segoe UI","Hiragino Sans",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;background:#f7f7f5;color:#222}' +
    'h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px;border-bottom:2px solid #2e7d32;padding-bottom:4px}' +
    '.updated,.note{color:#666;font-size:.8rem;margin:0 0 6px}' +
    '.day{background:#fff;border:1px solid #e0e0e0;border-left:5px solid #90a4ae;border-radius:8px;padding:10px 14px;margin:10px 0}' +
    '.day.sat{border-left-color:#42a5f5}.day.sun{border-left-color:#ef5350}' +
    '.day h3{margin:0 0 6px;font-size:1rem}.hol{margin-left:6px;font-size:.7rem;background:#fde8e8;color:#b71c1c;border-radius:3px;padding:1px 5px}' +
    '.day ul{list-style:none;margin:0;padding:0}.day li{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:.88rem;flex-wrap:wrap}' +
    '.city{font-size:.7rem;border-radius:3px;padding:1px 6px;color:#fff}.city.h{background:#2e7d32}.city.t{background:#3949ab}.city.o{background:#ef6c00}' +
    '.venue{font-weight:600}.slots{color:#1b5e20;background:#e8f5e9;border-radius:4px;padding:1px 8px}' +
    '</style></head><body>' +
    '<h1>土日の夜間(' + NIGHT_START + '以降)の空きリスト</h1>' +
    '<p class="updated">最終更新: ' + checkedAtJst + ' / 該当 ' + total + ' 件</p>' +
    '<p class="note">土曜・日曜の夜に空きがある会場だけを日付順に表示。夜間の時間枠が無い広島市の5施設は対象外です。観音新町のA〜Dは4面の区画で、予定表PDF公開時点の情報です。廿日市市は予約が登録されていない先の日付ほど空きに見えます。</p>' +
    (sections || '<p class="note">現在、該当する空きはありません。</p>') +
    '</body></html>';
  fs.writeFileSync(path.join(__dirname, "availability_weekend_night.html"), html, "utf8");
}

// ---------- 文章サマリー(Claudeチャット/スマホ向け)とドライブ同期 ----------

function nightItemsForDate(state, date, nightVenues) {
  const items = [];
  for (const v of nightVenues) {
    const c = matrixNightCell(v, date, state);
    if (c.level === "target") items.push({ v, text: c.text });
  }
  return items;
}

// "17-21:30" "半B 20-21" などの文字列から最長の連続時間(時間)を求める
function longestHours(text) {
  let best = 0;
  for (const m of text.matchAll(/(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?/g)) {
    const a = Number(m[1]) + Number(m[2] || 0) / 60;
    const b = Number(m[3]) + Number(m[4] || 0) / 60;
    best = Math.max(best, b - a);
  }
  return best;
}

// ---------- おすすめ(点数付け) ----------

// 予約・問い合わせ先(分かるもの)。未登録の広島市の施設は予約システム(ネット)で申し込む。
const CONTACTS = {
  "0825": "0829-40-5100",
  "8020": "082-286-3274",
  "8021": "082-286-3274",
  kanon: "082-233-1012",
  greenfield: "0829-31-5980",
  shohoku: "0829-31-5980",
  suncherry_field: "0829-31-5980",
};
const DEFAULT_CONTACT = "広島市の予約システム(ネット)";

function parseSlotText(str) {
  const m = String(str).match(/^(.*?)\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return null;
  return { label: m[1].trim(), from: timeToMinutes(m[2]), to: timeToMinutes(m[3]) };
}

// おすすめ候補になりうる枠を集める(平日=夜間 / 土日祝=全日)
function collectCandidateSlots(state) {
  const holidaySet = new Set(state.holidays || []);
  const dates = Object.keys(state.hatsukaichi[HATSUKAICHI.groups[0].key] || {}).sort();
  const out = [];
  const push = (date, venue, city, contact, source, from, to, label) =>
    out.push({ date, venue, city, contact, source, from, to, label });

  for (const d of dates) {
    const off = isOffDay(d, holidaySet);

    for (const f of HIROSHIMA.facilities) {
      if (!f.hasNightFrames) continue;
      const slots = (state.hiroshima[f.fc] && state.hiroshima[f.fc].night && state.hiroshima[f.fc].night[d]) || [];
      for (const sl of slots) {
        const p = parseSlotText(sl);
        if (p) push(d, f.name, f.city || "広島市", CONTACTS[f.fc] || DEFAULT_CONTACT, "system", p.from, p.to, p.label);
      }
    }

    for (const g of HATSUKAICHI.groups) {
      const free = (state.hatsukaichi[g.key] && state.hatsukaichi[g.key][d]) || [];
      const ranges = off ? keepLong(free) : clipToNight(free);
      for (const r of ranges) {
        const p = parseSlotText(r);
        if (p) push(d, g.label, "廿日市市", CONTACTS[g.key], "hatsukaichi", p.from, p.to, "");
      }
    }

    const perCourt = state.kanonSchedule && state.kanonSchedule.byDate ? state.kanonSchedule.byDate[d] : null;
    if (perCourt) {
      const byRange = {};
      for (const court of Object.keys(perCourt)) {
        const ranges = off ? keepLong(perCourt[court]) : clipToNight(perCourt[court]);
        for (const r of ranges) (byRange[r] = byRange[r] || []).push(court);
      }
      for (const r of Object.keys(byRange)) {
        const p = parseSlotText(r);
        const courts = byRange[r].sort().join("");
        if (p) push(d, KANON.label, "広島市", CONTACTS.kanon, "pdf", p.from, p.to, courts.length >= 4 ? "" : courts + "面のみ");
      }
    }
  }
  return out;
}

// 点数 = 枠の長さ + 曜日 + データの確かさ。2時間未満は対象外。
function scoreSlot(s, holidaySet) {
  const hours = (s.to - s.from) / 60;
  if (hours < 2) return null;
  let score = Math.min(hours, 4) * 10;
  const reasons = [(Number.isInteger(hours) ? hours : hours.toFixed(1)) + "時間"];

  const dow = new Date(s.date + "T00:00:00Z").getUTCDay();
  if (dow === 6) { score += 15; reasons.push("土曜"); }
  else if (dow === 0) { score += 15; reasons.push("日曜"); }
  else if (holidaySet.has(s.date)) { score += 15; reasons.push("祝日"); }
  else if (dow === 5) { score += 8; reasons.push("金曜夜"); }

  const off = dow === 0 || dow === 6 || holidaySet.has(s.date);
  if (off) {
    const eveningOverlap = Math.min(s.to, 21 * 60) - Math.max(s.from, 17 * 60);
    if (eveningOverlap >= 60) { score += 8; reasons.push("夜に使える"); }
  }

  if (s.source === "system") { score += 15; reasons.push("予約システムの実データ"); }
  else if (s.source === "pdf") { score += 6; reasons.push("予定表PDF(公開時点)"); }
  else if (s.source === "hatsukaichi") { score += 6; }

  if (s.label) { score -= 5; reasons.push(s.label); }

  const daysAhead = Math.round((Date.parse(s.date + "T00:00:00Z") - Date.parse(todayStr(0) + "T00:00:00Z")) / 86400000);
  if (s.source === "hatsukaichi" && daysAhead > 35) {
    score -= 8;
    reasons.push("先の日付は予約が未登録の可能性");
  }
  return { score, reasons };
}

// おすすめTOP(同じ会場は最大2件まで)。{ line, ... } の配列を返す。
function computeRecommendations(state, limit = 5) {
  const holidaySet = new Set(state.holidays || []);
  const scored = collectCandidateSlots(state)
    .filter((s) => !(state.hatsukaichiStale && s.source === "hatsukaichi"))
    .map((s) => ({ s, r: scoreSlot(s, holidaySet) }))
    .filter((x) => x.r)
    .sort((a, b) => b.r.score - a.r.score || (a.s.date < b.s.date ? -1 : 1) || a.s.from - b.s.from);

  const perVenue = {};
  const picks = [];
  for (const x of scored) {
    perVenue[x.s.venue] = (perVenue[x.s.venue] || 0) + 1;
    if (perVenue[x.s.venue] > 2) continue;
    picks.push(x);
    if (picks.length >= limit) break;
  }
  return picks.map((x, i) => {
    const s = x.s;
    const date = formatDateJa(s.date) + (holidaySet.has(s.date) ? "(祝)" : "");
    const range = compactRange(minutesToTime(s.from) + "-" + minutesToTime(s.to));
    return (
      (i + 1) + ". " + date + " " + range + " " + s.venue + "〔" + s.city + "〕 — " +
      x.r.reasons.join("・") + " / 予約: " + (s.contact || DEFAULT_CONTACT)
    );
  });
}

function generateTextSummary(state) {
  const nightVenues = matrixVenues(true);
  const holidaySet = new Set(state.holidays || []);
  const dates = Object.keys(state.hatsukaichi[HATSUKAICHI.groups[0].key] || {}).sort();
  const checkedAtJst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(state.checkedAt));
  const line = (d, items) =>
    "- " + formatDateJa(d) + (holidaySet.has(d) ? "(祝)" : "") + ": " + items.map(({ v, text }) => v.name + " " + text).join(" / ");

  const out = [];
  out.push("# サッカーグラウンド空き状況(広島市・廿日市市・府中町)");
  out.push("最終更新: " + checkedAtJst + "(約3時間ごとに自動更新)");
  out.push("夜間 = " + NIGHT_START + "以降。時刻は「17-21:30」= 17:00〜21:30 の意味。");
  if (state.hatsukaichiStale) {
    const at = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(state.hatsukaichiAt));
    out.push("");
    out.push("【注意】廿日市市(グリーンフィールド・昭北グランド・サンチェリー多目的広場)は、公式サイトのメンテナンス等で最新の状況を取得できていません。下の廿日市市の情報は " + at + " 時点のもので、おすすめからも除いています。");
  }
  out.push("");

  const recs = computeRecommendations(state);
  out.push("## おすすめ TOP" + Math.max(recs.length, 1));
  out.push("点数の付け方: 2時間以上続く枠を対象に、長さ・土日祝・データの確かさ(予約システムの実データを優先)で評価。同じ会場は2件まで。");
  out.push("");
  if (recs.length) for (const r of recs) out.push(r);
  else out.push("- 現在、おすすめできる枠(2時間以上)はありません");
  out.push("");
  const recText = recs.length ? recs.join("\n") : "(現在、2時間以上のおすすめ枠はありません)";
  fs.writeFileSync(path.join(__dirname, "availability_recommend.md"), recText + "\n", "utf8");

  out.push("## 土日の夜間(" + NIGHT_START + "以降)の空き");
  let month = "";
  let weekendCount = 0;
  for (const d of dates) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    const items = nightItemsForDate(state, d, nightVenues);
    if (!items.length) continue;
    const ym = Number(d.slice(5, 7)) + "月";
    if (ym !== month) { out.push("", "### " + ym); month = ym; }
    out.push(line(d, items));
    weekendCount++;
  }
  if (!weekendCount) out.push("- 該当なし");

  out.push("", "## 平日の夜(" + NIGHT_START + "以降)で2時間以上続く枠(今後30日)");
  let weekdayCount = 0;
  for (const d of dates.slice(0, 30)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const items = nightItemsForDate(state, d, nightVenues).filter((it) => longestHours(it.text) >= 2);
    if (!items.length) continue;
    out.push(line(d, items));
    weekdayCount++;
  }
  if (!weekdayCount) out.push("- 該当なし");

  out.push("", "## 注意");
  out.push("- 広島市・府中町の施設は予約システムの実データ。廿日市市は予約が登録されていない先の日付ほど「空き」に見えます(12月は特に)。11月分は公式カレンダーと突き合わせ済みです。");
  out.push("- 観音新町運動広場は管理者が公開する月間予定表PDFの読み取り(A〜Dは4面の区画)。公開時点の情報で、以降の予約は反映されません。");
  out.push("- 夜間の時間枠が無い広島市の5施設(西風新都東公園・若葉台中央公園・伴西公園・倉掛公園・畑賀公園)は夜の一覧から除外。");
  out.push("- 府中町の施設(揚倉山・空城山公園)は予約受付が約1か月先まで。先の日付は「情報なし」です。");
  out.push("", "## 問い合わせ先");
  out.push("- 湯来南庭球場・運動広場: 0829-40-5100 / 観音新町運動広場: 082-233-1012");
  out.push("- 揚倉山・空城山公園(府中町教育委員会 社会教育課): 082-286-3274");
  out.push("- サンチェリー多目的広場・グリーンフィールド・昭北グランド: 0829-31-5980");

  const text = out.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "availability_summary.md"), text, "utf8");
}

// 同期フォルダ(Googleドライブ)にレポート一式をコピーする。失敗しても本体の処理は止めない。
function syncToDrive() {
  try {
    const driveRoot = path.dirname(SYNC_DIR);
    if (!fs.existsSync(driveRoot)) return;
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    for (const f of [
      "availability_summary.md",
      "availability_weekend_night.html",
      "availability_matrix_night.html",
      "availability_matrix.html",
      "availability_report.html",
    ]) {
      fs.copyFileSync(path.join(__dirname, f), path.join(SYNC_DIR, f));
    }
  } catch (err) {
    console.error("[warn] ドライブへの書き出しに失敗: " + err.message);
  }
}

function generateHtmlReport(state) {
  const checkedAtJst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(state.checkedAt));

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>サッカーグラウンド空き状況</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Hiragino Sans", sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px; background: #f7f7f5; color: #222; }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  .updated { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  h2 { font-size: 1.05rem; border-bottom: 2px solid #2e7d32; padding-bottom: 4px; margin-top: 32px; }
  h2.night { border-bottom-color: #37474f; }
  .facility { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 16px; margin: 10px 0; }
  .facility h3 { margin: 0 0 8px 0; font-size: 0.95rem; }
  .area { color: #888; font-weight: normal; font-size: 0.8rem; margin-left: 8px; }
  ul.dates { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  ul.dates li { background: #e8f5e9; color: #1b5e20; border-radius: 4px; padding: 3px 8px; font-size: 0.85rem; }
  .night ul.dates li { background: #e3e8fc; color: #1a237e; }
  .night ul.dates li.off { background: #e8f5e9; color: #1b5e20; }
  ul.links { margin: 0; padding-left: 18px; font-size: 0.85rem; }
  .slots { color: #555; font-size: 0.8rem; }
  .empty { color: #999; font-size: 0.85rem; margin: 0; }
  .note { color: #888; font-size: 0.8rem; margin: 8px 0 0; }
  details { margin-top: 32px; }
  summary { cursor: pointer; font-size: 1.05rem; padding: 4px 0; }
</style>
</head>
<body>
  <h1>サッカーグラウンド空き状況(広島市・廿日市市)</h1>
  <div class="updated">最終更新: ${checkedAtJst} (今後${DAYS_AHEAD}日分・自動更新は3時間ごと)</div>

  <h2 class="night">狙い目: 平日の夜(${NIGHT_START}以降)+ 土日祝の全日</h2>
  <p class="note">青=平日夜 / 緑(全日)=土日祝。広島市の一部施設は夜間枠が無いため、土日祝のみ表示されます。</p>
  <div class="night">
  ${buildTargetSection(state)}
  </div>

  ${buildKanonCard(state.kanon, state.kanonSchedule, new Set(state.holidays || []))}

  <details>
    <summary>日中を含む全時間帯の空き状況を見る</summary>
    <h2>広島市</h2>
    ${buildHiroshimaSection(state.hiroshima)}

    <h2>廿日市市</h2>
    ${buildHatsukaichiSection(state.hatsukaichi)}
  </details>
</body>
</html>`;

  fs.writeFileSync(path.join(__dirname, "availability_report.html"), html, "utf8");
}

// ---------- メイン ----------

async function main() {
  const prevState = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : null;

  const [hiroshima, hatsukaichiResult, kanonResult] = await Promise.all([
    collectHiroshima(),
    collectHatsukaichi().then(
      (v) => ({ ok: true, v }),
      (err) => ({ ok: false, err })
    ),
    collectKanon(prevState?.kanonSchedule),
  ]);

  // 廿日市市のデータ元(hatsukaichi-sports.net)がメンテナンス等で取れない間は、
  // 最後に取得できた内容を使い続け、古い旨を一覧に表示する。通知や比較は変化なし扱いになる。
  let hatsukaichi;
  let hatsukaichiStale = false;
  if (hatsukaichiResult.ok) {
    hatsukaichi = hatsukaichiResult.v;
  } else if (prevState && prevState.hatsukaichi) {
    console.error("[warn] 廿日市市の取得に失敗(前回の内容を使用): " + hatsukaichiResult.err.message);
    hatsukaichi = prevState.hatsukaichi;
    hatsukaichiStale = true;
  } else {
    throw hatsukaichiResult.err;
  }
  const nowIso = new Date().toISOString();
  const hatsukaichiAt = hatsukaichiStale ? prevState.hatsukaichiAt || prevState.checkedAt : nowIso;
  const kanon = kanonResult ? kanonResult.docs : null;
  const kanonSchedule = kanonResult ? kanonResult.schedule : prevState?.kanonSchedule || null;

  const newState = {
    checkedAt: new Date().toISOString(),
    nightStart: NIGHT_START,
    nightFormat: NIGHT_FORMAT,
    hatsukaichiStale,
    hatsukaichiAt,
    holidays: [...HOLIDAYS].sort(),
    hiroshima,
    hatsukaichi,
    kanon: kanon || prevState?.kanon || null,
    kanonSchedule,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), "utf8");
  generateHtmlReport(newState);
  generateMatrixReport(newState);
  generateMatrixReport(newState, true);
  generateWeekendNightList(newState);
  generateTextSummary(newState);
  syncToDrive();

  if (!prevState) {
    console.log("BASELINE_INITIALIZED");
    return;
  }

  // 夜間の開始時刻を変えた直後は、前回の夜間データと比べると誤検知になるため比較から外す
  if (prevState.nightStart !== NIGHT_START || prevState.nightFormat !== NIGHT_FORMAT) {
    for (const fc of Object.keys(prevState.hiroshima || {})) {
      if (prevState.hiroshima[fc]) prevState.hiroshima[fc].night = null;
    }
  }

  const lines = [
    ...diffHiroshima(prevState.hiroshima, hiroshima),
    ...diffHatsukaichi(prevState.hatsukaichi, hatsukaichi),
    ...diffKanon(prevState.kanon, kanon, prevState.kanonSchedule, kanonSchedule),
  ]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.text < b.text ? -1 : 1))
    .map((l) => l.text);

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
