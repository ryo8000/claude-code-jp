#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

// モデル別のコンテキストウィンドウ（トークン数）。未知のモデルは1Mにフォールバック。
// (参照: platform.claude.com/docs/en/about-claude/models/overview)
const CONTEXT_WINDOWS = {
  'claude-fable-5': 1000000,
  'claude-mythos-5': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-haiku-4-5': 200000,
};
const DEFAULT_WINDOW = 1000000;

function suppress() {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
  process.exit(0);
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
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

// コストはメインのトランスクリプトと全サブエージェントのトランスクリプトを合算する。
// 同一のAPIレスポンスがcontent blockごとに複数のトランスクリプト行として記録されるため、
// message.idで重複排除する。
// キャッシュ書込の単価: 1時間キャッシュ=入力単価の2倍、5分キャッシュ=1.25倍、
// キャッシュ読込=0.1倍（Anthropicの標準的な料金倍率）。
function calcCostUsd(files) {
  const seenIds = new Set();
  let total = 0;

  for (const file of files) {
    for (const entry of readJsonl(file)) {
      if (entry.type !== 'assistant' || !entry.message?.usage) continue;
      if (seenIds.has(entry.message.id)) continue;
      seenIds.add(entry.message.id);

      const r = lookupByPrefix(MODEL_RATES, entry.message.model, DEFAULT_RATE);
      const u = entry.message.usage;
      const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;

      total +=
        ((u.input_tokens ?? 0) * r.in) / 1000000 +
        ((u.output_tokens ?? 0) * r.out) / 1000000 +
        (write1h * (r.in * 2)) / 1000000 +
        (write5m * (r.in * 1.25)) / 1000000 +
        ((u.cache_read_input_tokens ?? 0) * (r.in * 0.1)) / 1000000;
    }
  }

  return total;
}

// コンテキスト使用率はメイン会話のみを対象とする
// （サブエージェントはそれぞれ別のコンテキストウィンドウを持つため）。
// 直近ターンのusageを基準に算出する。
function calcContextPct(transcriptPath) {
  const messages = readJsonl(transcriptPath).filter(
    (e) => e.type === 'assistant' && e.message?.usage
  );
  const latest = messages[messages.length - 1];
  if (!latest) return 0;

  const u = latest.message.usage;
  const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const win = lookupByPrefix(CONTEXT_WINDOWS, latest.message.model, DEFAULT_WINDOW);
  return (used / win) * 100;
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const tp = input.transcript_path;
  const sid = input.session_id;

  if (!tp || !fs.existsSync(tp) || !sid) {
    suppress();
    return;
  }

  const stateDir = path.join(os.homedir(), '.claude', 'cost-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${sid}.usd`);

  // 30日以上更新のない古いセッションの状態ファイルを掃除する。
  // 他セッションの同時実行によるレース（ファイルが既に削除済み等）は無視して続行する。
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.endsWith('.usd')) continue;
    const filePath = path.join(stateDir, name);
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > THIRTY_DAYS_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // no-op
    }
  }

  // トランスクリプトの不完全な行やファイルシステムエラー(競合書き込み・権限エラー等)で
  // 例外が出た場合も、状態ファイルを破損させたりクラッシュしたりせず終了する。
  let costUsd;
  let contextPctFmt;
  try {
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

    costUsd = calcCostUsd([tp, ...subagentFiles]);
    contextPctFmt = calcContextPct(tp).toFixed(1);
  } catch {
    suppress();
    return;
  }

  if (!Number.isFinite(costUsd)) {
    suppress();
    return;
  }

  // 前回累計との差分 = 今回ターンの増分
  // （compactionで累積が減る場合に備え0未満は0に丸める）
  let prev = 0;
  try {
    const parsed = parseFloat(fs.readFileSync(stateFile, 'utf8'));
    if (Number.isFinite(parsed)) prev = parsed;
  } catch {
    // 状態ファイルが存在しない場合は0として扱う
  }
  fs.writeFileSync(stateFile, String(costUsd));
  const deltaUsd = Math.max(costUsd - prev, 0);

  // ⚡ = 今回分, 💰 = 累計コスト, 📊 = コンテキスト使用率
  const msg = SHOW_JPY
    ? `⚡¥${Math.round(deltaUsd * RATE)} 💰¥${Math.round(costUsd * RATE)} 📊${contextPctFmt}%`
    : `⚡$${deltaUsd.toFixed(2)} 💰$${costUsd.toFixed(2)} 📊${contextPctFmt}%`;

  const notifBody = `タスクが完了しました。\n${msg}`;
  const osa = spawn('osascript', ['-e', `display notification "${notifBody}" with title "Claude Code"`], {
    detached: true,
    stdio: 'ignore',
  });
  osa.on('error', () => {});
  osa.unref();

  process.stdout.write(JSON.stringify({ systemMessage: msg, suppressOutput: true }));
}

main();
