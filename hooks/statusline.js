#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- 設定 ----
const SHOW_JPY = true; // false にするとドル表示のみ（為替レート更新が不要になる）
const RATE = 160; // 1ドルあたりの円。SHOW_JPY=true のときのみ使用。為替レートは変動するので必要に応じて更新してください

// モデル別の1Mトークンあたりドル単価。新モデル追加時はここに追記してください
// (参照: platform.claude.com/docs/en/about-claude/pricing)
// Sonnet 5 は2026-08-31まで導入価格($2/$10)が適用され、2026-09-01以降は$3/$15になる。
const MODEL_RATES = {
  'claude-fable-5': { in: 10.0, out: 50.0 },
  'claude-mythos-5': { in: 10.0, out: 50.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 },
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
};
const DEFAULT_RATE = { in: 3.0, out: 15.0 };

// 燃焼率(🔥)算出に必要な最低経過時間。セッション開始直後は分母が小さすぎて
// 燃焼率が異常値になるため、1分未満は算出しない。
const MIN_BURN_RATE_ELAPSED_HOURS = 1 / 60;

// トランスクリプト書き込み中に読まれた場合など、末尾行が不完全なことがあるため、
// 行単位でパース失敗を許容し、解析できた行だけを対象にする。
function readJsonl(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

// モデル名は前方一致で照合するため、日付付きのモデルID
// （例: サブエージェントのトランスクリプトで使われる claude-haiku-4-5-20251001）も
// テーブルのエイリアスキーに解決できる。複数マッチ時は最長一致を優先する。
function lookupByPrefix(table, model, fallback) {
  const matched = Object.keys(table)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => a.length - b.length)
    .pop();
  return matched ? table[matched] : fallback;
}

// キャッシュ書込の単価: 1時間キャッシュ=入力単価の2倍、5分キャッシュ=1.25倍、
// キャッシュ読込=0.1倍（Anthropicの標準的な料金倍率）。
function costForEntry(entry) {
  const r = lookupByPrefix(MODEL_RATES, entry.message.model, DEFAULT_RATE);
  const u = entry.message.usage;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;

  return (
    ((u.input_tokens ?? 0) * r.in) / 1000000 +
    ((u.output_tokens ?? 0) * r.out) / 1000000 +
    (write1h * (r.in * 2)) / 1000000 +
    (write5m * (r.in * 1.25)) / 1000000 +
    ((u.cache_read_input_tokens ?? 0) * (r.in * 0.1)) / 1000000
  );
}

// コストはメインのトランスクリプトと全サブエージェントのトランスクリプトを合算する。
// 同一のAPIレスポンスがcontent blockごとに複数のトランスクリプト行として記録されるため、
// message.idで重複排除する。
function calcCostUsd(files) {
  const seenIds = new Set();
  let total = 0;

  for (const file of files) {
    for (const entry of readJsonl(file)) {
      if (entry.type !== 'assistant' || !entry.message?.usage) continue;
      if (seenIds.has(entry.message.id)) continue;
      seenIds.add(entry.message.id);
      total += costForEntry(entry);
    }
  }

  return total;
}

// ~/.claude/projects/ 配下の全プロジェクト・全セッションのトランスクリプトを対象に、
// 当日分のコストを合算する。JSONLは追記専用のため、mtimeが今日より前のファイルは
// 当日分のエントリを含みえないと判定して事前に除外する（フルスキャンを避けるため）。
function findTodayCandidateFiles(now = new Date()) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  return fs
    .readdirSync(projectsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).mtimeMs >= startOfToday;
      } catch {
        return false;
      }
    });
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// today集計はファイル単位ではなくエントリ単位でtimestampを見て当日分のみを合算する
// （日をまたいだセッションでは同一ファイルに前日分のエントリも混在するため）。
function calcTodayCostUsd(files, now = new Date()) {
  const seenIds = new Set();
  let total = 0;

  for (const file of files) {
    for (const entry of readJsonl(file)) {
      if (entry.type !== 'assistant' || !entry.message?.usage || !entry.timestamp) continue;
      const ts = new Date(entry.timestamp);
      if (Number.isNaN(ts.getTime()) || !isSameLocalDay(ts, now)) continue;
      if (seenIds.has(entry.message.id)) continue;
      seenIds.add(entry.message.id);
      total += costForEntry(entry);
    }
  }

  return total;
}

function filterAssistantMessages(transcriptPath) {
  return readJsonl(transcriptPath).filter((e) => e.type === 'assistant' && e.message?.usage);
}

// 燃焼率 = セッション合計コスト ÷ メイン会話の経過時間（先頭〜直近ターンのtimestamp差）。
// メッセージが1件だけ、またはtimestampが欠落/不正な場合はnullを返す。
function calcBurnRateUsdPerHour(messages, costUsd) {
  if (messages.length < 2) return null;

  const first = Date.parse(messages[0].timestamp);
  const last = Date.parse(messages[messages.length - 1].timestamp);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

  const elapsedHours = (last - first) / 3600000;
  if (elapsedHours < MIN_BURN_RATE_ELAPSED_HOURS) return null;

  return costUsd / elapsedHours;
}

function formatUsd(amountUsd) {
  return SHOW_JPY ? `¥${Math.round(amountUsd * RATE)}` : `$${amountUsd.toFixed(2)}`;
}

// cost.total_lines_added / total_lines_removed はClaude Code側で集計済みの値をそのまま使う。
// 古いバージョンではcostフィールド自体が無いため、その場合はセグメントを出さない。
function formatLinesChanged(cost) {
  if (!cost || (cost.total_lines_added === undefined && cost.total_lines_removed === undefined)) return null;
  return `📝+${cost.total_lines_added ?? 0} -${cost.total_lines_removed ?? 0}`;
}

function formatDuration(ms) {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// 5時間のレート制限ウィンドウの消費率と残り時間。Claude.aiのPro/Maxプランでのみ
// rate_limits.five_hourが存在するため、無い場合はセグメントを出さない。
function formatBlockLabel(rateLimits) {
  const fiveHour = rateLimits?.five_hour;
  if (fiveHour?.used_percentage === undefined || fiveHour?.used_percentage === null) return null;

  const pct = Math.round(fiveHour.used_percentage);
  if (typeof fiveHour.resets_at !== 'number') return `⏳${pct}%`;

  const msLeft = fiveHour.resets_at * 1000 - Date.now();
  return `⏳${pct}% (${formatDuration(msLeft)} left)`;
}

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const tp = input.transcript_path;

    if (!tp || !fs.existsSync(tp)) {
      process.stdout.write('');
      return;
    }

    // サブエージェント(Task tool)の呼び出しは、メインと同じ形式で
    // <transcript_pathから.jsonlを除いたパス>/subagents/agent-*.jsonl に
    // 独自のトランスクリプトを書き込む。委譲した分のコストも含めるため合算する。
    const subagentsDir = `${tp.replace(/\.jsonl$/, '')}/subagents`;
    const subagentFiles = fs.existsSync(subagentsDir)
      ? fs
          .readdirSync(subagentsDir)
          .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
          .map((name) => path.join(subagentsDir, name))
      : [];

    const costUsd = calcCostUsd([tp, ...subagentFiles]);
    if (!Number.isFinite(costUsd)) {
      process.stdout.write('');
      return;
    }

    const mainMessages = filterAssistantMessages(tp);
    // context_window は初回API呼び出し前・/compact直後・古いバージョンで欠けることがある。
    // その場合は 0% と誤表示せず 📊- とする（🔥 と同じく一時的な「値なし」を明示）。
    const contextPct = input.context_window?.used_percentage;
    const burnRateUsd = calcBurnRateUsdPerHour(mainMessages, costUsd);
    const burnFmt = burnRateUsd === null ? '-' : `${formatUsd(burnRateUsd)}/h`;
    const todayCostUsd = calcTodayCostUsd(findTodayCandidateFiles());

    const parts = [];

    const modelName = input.model?.display_name;
    if (modelName) parts.push(`🤖 ${modelName}`);

    parts.push(`💰${formatUsd(costUsd)}`);
    parts.push(`📅${formatUsd(todayCostUsd)}`);
    parts.push(typeof contextPct === 'number' ? `📊${contextPct.toFixed(1)}%` : '📊-');

    const blockLabel = formatBlockLabel(input.rate_limits);
    if (blockLabel) parts.push(blockLabel);

    parts.push(`🔥${burnFmt}`);

    const linesLabel = formatLinesChanged(input.cost);
    if (linesLabel) parts.push(linesLabel);

    process.stdout.write(parts.join(' | '));
  } catch {
    process.stdout.write('');
  }
}

main();
