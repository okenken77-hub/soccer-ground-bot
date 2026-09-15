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
  facilities: [
    { name: "西風新都東公園", area: "広島市安佐南区", fc: "0582", roomCode: "110", roomName: "グラウンド" },
    { name: "若葉台中央公園", area: "広島市安佐南区", fc: "0583", roomCode: "110", roomName: "グラウンド" },
    { name: "伴西公園", area: "広島市安佐南区", fc: "0584", roomCode: "110", roomName: "グラウンド" },
    { name: "太田川緑地安芸大橋グラウンド", area: "広島市安佐南区", fc: "0591", roomCode: "100", roomName: "グラウンド" },
    { name: "倉掛公園", area: "広島市安佐北区", fc: "0613", roomCode: "101", roomName: "グラウンド" },
    { name: "畑賀公園", area: "広島市安芸区", fc: "0782", roomCode: "100", roomName: "グラウンド" },
    { name: "湯来南庭球場・運動広場", area: "広島市佐伯区", fc: "0825", roomCode: "111", roomName: "運動広場" },
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
      // 毎月第1水曜日は定休日
      closedRule: "first-wednesday",
    },
  ],
};

const DAYS_AHEAD = 30; // 何日先まで確認するか

module.exports = { HIROSHIMA, HATSUKAICHI, DAYS_AHEAD };
