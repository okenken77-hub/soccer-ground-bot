// 空きグラウンド確認ボット - 対象施設の設定
// 施設や営業時間は変わることがあるため、通知内容がおかしいと感じたら
// このファイルを最新の公式サイト情報と突き合わせて更新してください。

const HIROSHIMA = {
  // ひろしま・やまぐち公共施設予約サービス (https://yoyacool.e-harp.jp/facility/)
  // 「サッカー」目的タグが付く広島市内の全公共グラウンド（2026-09-16時点で確認）
  lgc: "340006", // 広島市の団体コード
  utilizationPurpose: {
    groupId: "utilizationPurpose",
    key: "7",
    utilizationPurposeId: 7,
    utilizationPurposeCategoryName: "スポーツ球技系",
    utilizationPurposeName: "サッカー",
    groupName: "利用目的",
    itemId: "utilizationPurpose7",
  },
  // hasNightFrames: GetDay API で各施設の利用可能時間枠(timeFrames)を確認した結果(2026-10-01時点)。
  // 西風新都東公園/若葉台中央公園/伴西公園は8:00-18:00、倉掛公園/畑賀公園は12:30-17:00までで、
  // いずれも夜間照明の時間枠が存在しない。太田川緑地安芸大橋グラウンドは19:00まで、
  // 湯来南庭球場・運動広場のみ22:00まで時間枠があり、唯一「夜間」に該当する枠を持つ。
  facilities: [
    { name: "西風新都東公園", area: "広島市安佐南区", fc: "0582", roomCode: "110", roomName: "グラウンド", hasNightFrames: false },
    { name: "若葉台中央公園", area: "広島市安佐南区", fc: "0583", roomCode: "110", roomName: "グラウンド", hasNightFrames: false },
    { name: "伴西公園", area: "広島市安佐南区", fc: "0584", roomCode: "110", roomName: "グラウンド", hasNightFrames: false },
    { name: "太田川緑地安芸大橋グラウンド", area: "広島市安佐南区", fc: "0591", roomCode: "100", roomName: "グラウンド", hasNightFrames: true },
    { name: "倉掛公園", area: "広島市安佐北区", fc: "0613", roomCode: "101", roomName: "グラウンド", hasNightFrames: false },
    { name: "畑賀公園", area: "広島市安芸区", fc: "0782", roomCode: "100", roomName: "グラウンド", hasNightFrames: false },
    { name: "湯来南庭球場・運動広場", area: "広島市佐伯区", fc: "0825", roomCode: "111", roomName: "運動広場", hasNightFrames: true, multiCourt: true },
    // 府中町の施設だが同じ「ひろしま・やまぐち公共施設予約サービス」(団体コード340006)に登録されている。
    // 上段多目的広場は7:00-21:00(1時間単位)で、全面・1/2A・1/2Bの3区画。半面だけ空く日があるため
    // multiCourt で全区画を見る。申込・問合せ: 府中町教育委員会 社会教育課 082-286-3274。
    { name: "WACTORYパーク揚倉山(上段多目的広場)", area: "安芸郡府中町", city: "府中町", fc: "8021", roomCode: "100", roomName: "上段多目的広場", hasNightFrames: true, multiCourt: true },
    // 同じく府中町。多目的広場は全面のみ(7:00-21:00・1時間単位)。申込・問合せは府中町教育委員会 社会教育課 082-286-3274。
    { name: "チェリーゴード空城パーク(空城山公園)", area: "安芸郡府中町", city: "府中町", fc: "8020", roomCode: "101", roomName: "多目的広場", hasNightFrames: true },
  ],
};

// 廿日市市: hatsukaichi-sports.net が公開する共通予約済みイベントJSON
// https://hatsukaichi-sports.net/_cmn_js/schedule.json
// 「fac」フィールドに一致するものを対象施設として集計し、
// 営業時間から予約済み時間を差し引いて空き時間を算出する。
const HATSUKAICHI = {
  scheduleUrl: "https://hatsukaichi-sports.net/_cmn_js/schedule.json",
  groups: [
    {
      key: "greenfield",
      label: "グリーンフィールド(サッカー場)",
      facNames: ["全面", "西半面", "東半面", "東Ｂ面(1/4)"],
      openTime: "09:00",
      closeTime: "21:30",
      closedRule: null,
    },
    {
      key: "shohoku",
      label: "昭北グランド",
      facNames: ["昭北グランド 東", "昭北グランド 西"],
      openTime: "07:00",
      closeTime: "21:30",
      closedRule: null,
    },
    {
      key: "suncherry_field",
      label: "サンチェリー多目的広場(峰高公園)",
      facNames: ["広場全面", "広場半面Ａ", "広場半面Ｂ"],
      openTime: "08:30",
      closeTime: "21:00",
      // 本館(サンチェリー)は毎月第1水曜が休館日だが、公式カレンダーでは屋外の多目的広場は
      // 第1水曜も「予定なし(予約可)」と表示される(2026-10-07で確認)ため、休場扱いにはしない。
      closedRule: null,
    },
  ],
};

// 観音新町運動広場(広島市西区・人工芝多目的グラウンド, 9:00-21:00, 水曜休場)
// 予約状況は管理者(shinko-sports.jp)が月間予定表PDFを手作業で公開する方式のため、
// リアルタイムの空き判定はせず、公開されたPDFの一覧を取得してリンク表示・更新通知のみ行う。
const KANON = {
  label: "観音新町運動広場(広島市西区)",
  pageUrl: "https://shinko-sports.jp/kanon-g/",
  apiUrl: "https://shinko-sports.jp/info/JsPnGzqNHa2p",
  baseUrl: "https://shinko-sports.jp",
  phone: "082-233-1012",
  query:
    "query getSchedules { kanonGSche { nodes { title files { file { node { filePath } } } } } }",
};

// 今日から「再来月末」までの日数(JST基準)。例: 10月中なら12月末まで。月が進むと範囲も1か月ずつ先へ進む。
function daysThroughEndOfMonthAfterNext() {
  const todayJst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const [y, m, d] = todayJst.split("-").map(Number);
  const today = Date.UTC(y, m - 1, d);
  const endOfMonthAfterNext = Date.UTC(y, m + 2, 0); // 翌々月の0日 = 再来月末
  return Math.round((endOfMonthAfterNext - today) / 86400000) + 1;
}
// 外出先(スマホ・Claudeチャット)から見られるよう、最新の結果をGoogleドライブ(パソコン版の同期フォルダ)にも書き出す。
// ドライブが無い環境では何もしない。
const SYNC_DIR = "G:/マイドライブ/サッカーグラウンド空き状況";

const DAYS_AHEAD = daysThroughEndOfMonthAfterNext(); // 何日先まで確認するか
const NIGHT_START = "17:00"; // この時刻以降を「夜間」として扱う

module.exports = { HIROSHIMA, HATSUKAICHI, KANON, DAYS_AHEAD, NIGHT_START, SYNC_DIR };
