#!/bin/bash
input=$(cat)
TP=$(echo "$input" | jq -r '.transcript_path // empty')
SID=$(echo "$input" | jq -r '.session_id')

if [ -z "$TP" ] || [ ! -f "$TP" ] || [ -z "$SID" ]; then
  jq -n '{suppressOutput:true}'
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 設定 ----
SHOW_JPY=true  # false にするとドル表示のみ（為替レート更新が不要になる）
RATE=160       # 1ドルあたりの円。SHOW_JPY=true のときのみ使用。為替レートは変動するので必要に応じて更新してください

# モデル別の1Mトークンあたりドル単価。新モデル追加時はここに追記してください
# (参照: platform.claude.com/docs/en/about-claude/pricing)
# Sonnet 5 は2026-08-31まで導入価格($2/$10)が適用され、2026-09-01以降は$3/$15になる。
MODEL_RATES='
{
  "claude-fable-5":   {"in": 10.00, "out": 50.00},
  "claude-mythos-5":  {"in": 10.00, "out": 50.00},
  "claude-sonnet-5":  {"in": 2.00, "out": 10.00},
  "claude-opus-4-8":  {"in": 5.00, "out": 25.00},
  "claude-haiku-4-5": {"in": 1.00, "out": 5.00}
}
'

# モデル別のコンテキストウィンドウ（トークン数）。未知のモデルは1Mにフォールバック。
# (参照: platform.claude.com/docs/en/about-claude/models/overview)
CONTEXT_WINDOWS='
{
  "claude-fable-5":   1000000,
  "claude-mythos-5":  1000000,
  "claude-sonnet-5":  1000000,
  "claude-opus-4-8":  1000000,
  "claude-haiku-4-5": 200000
}
'

STATE_DIR="$HOME/.claude/cost-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/$SID.usd"
# 30日以上更新のない古いセッションの状態ファイルを掃除する。
find "$STATE_DIR" -name '*.usd' -mtime +30 -delete 2>/dev/null

# サブエージェント(Task tool)の呼び出しは、メインと同じ形式で
# <transcript_pathから.jsonlを除いたパス>/subagents/agent-*.jsonl に
# 独自のトランスクリプトを書き込む。委譲した分のコストも含めるため合算する。
SUBAGENTS_DIR="${TP%.jsonl}/subagents"
shopt -s nullglob
SUBAGENT_FILES=("$SUBAGENTS_DIR"/agent-*.jsonl)
shopt -u nullglob
ALL_FILES=("$TP" "${SUBAGENT_FILES[@]}")

# コストはメインのトランスクリプトと全サブエージェントのトランスクリプトを合算する。
COST_USD=$(jq -s -f "$HOOK_DIR/cost-report-cost.jq" --argjson rates "$MODEL_RATES" "${ALL_FILES[@]}")

# コンテキスト使用率はメイン会話のみを対象とする
# （サブエージェントはそれぞれ別のコンテキストウィンドウを持つため）。
CONTEXT_PCT=$(jq -s -f "$HOOK_DIR/cost-report-context.jq" --argjson windows "$CONTEXT_WINDOWS" "$TP")
CONTEXT_PCT_FMT=$(awk -v p="$CONTEXT_PCT" 'BEGIN{printf "%.1f", p}')

# jqの計算失敗などでCOST_USDが数値でない場合、状態ファイルを破損させずに終了する。
if [ -z "$COST_USD" ] || ! [[ "$COST_USD" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
  jq -n '{suppressOutput:true}'
  exit 0
fi

# 前回累計との差分 = 今回ターンの増分
# （compactionで累積が減る場合に備え0未満は0に丸める）
PREV=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
echo "$COST_USD" > "$STATE_FILE"
DELTA_USD=$(awk -v a="$COST_USD" -v b="$PREV" 'BEGIN{d=a-b; if (d<0) d=0; printf "%.6f", d}')

# ⚡ = 今回分, 💰 = 累計コスト, 📊 = コンテキスト使用率
if [ "$SHOW_JPY" = true ]; then
  TOTAL_JPY=$(awk -v u="$COST_USD"  -v r="$RATE" 'BEGIN{printf "%.0f", u*r}')
  DELTA_JPY=$(awk -v u="$DELTA_USD" -v r="$RATE" 'BEGIN{printf "%.0f", u*r}')
  MSG="⚡¥${DELTA_JPY} 💰¥${TOTAL_JPY} 📊${CONTEXT_PCT_FMT}%"
else
  DELTA_USD_FMT=$(printf '%.2f' "$DELTA_USD")
  TOTAL_USD_FMT=$(printf '%.2f' "$COST_USD")
  MSG="⚡\$${DELTA_USD_FMT} 💰\$${TOTAL_USD_FMT} 📊${CONTEXT_PCT_FMT}%"
fi

NOTIF_BODY=$'タスクが完了しました。\n'"${MSG}"
osascript -e "display notification \"$NOTIF_BODY\" with title \"Claude Code\"" >/dev/null 2>&1 &

jq -n --arg m "$MSG" '{systemMessage:$m, suppressOutput:true}'
exit 0
