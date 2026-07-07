#!/bin/bash
input=$(cat)
TP=$(echo "$input" | jq -r '.transcript_path')
SID=$(echo "$input" | jq -r '.session_id')

# ---- 設定 ----
SHOW_JPY=true  # false にするとドル表示のみ（為替レート更新が不要になる）
RATE=160       # 1ドルあたりの円。SHOW_JPY=true のときのみ使用。為替レートは変動するので必要に応じて更新してください

# モデル別の1Mトークンあたりドル単価。新モデル追加時はここに追記してください
# (参照: platform.claude.com/docs/en/about-claude/pricing)
MODEL_RATES='
{
  "claude-fable-5":   {"in": 10.00, "out": 50.00},
  "claude-mythos-5":  {"in": 10.00, "out": 50.00},
  "claude-sonnet-5":  {"in": 3.00, "out": 15.00},
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

# サブエージェント(Task tool)の呼び出しは、メインと同じ形式で
# <transcript_pathから.jsonlを除いたパス>/subagents/agent-*.jsonl に
# 独自のトランスクリプトを書き込む。委譲した分のコストも含めるため合算する。
SUBAGENTS_DIR="${TP%.jsonl}/subagents"
shopt -s nullglob
SUBAGENT_FILES=("$SUBAGENTS_DIR"/agent-*.jsonl)
shopt -u nullglob
ALL_FILES=("$TP" "${SUBAGENT_FILES[@]}")

# 以下2つのjq処理で共有するフィルタ関数。
# - rate()/window() は前方一致で照合するため、日付付きのモデルID
#   （例: サブエージェントのトランスクリプトで使われる claude-haiku-4-5-20251001）も
#   上記のエイリアスキーに解決できる。
# - 同一のAPIレスポンスがcontent blockごとに複数のトランスクリプト行として
#   記録されるため、集計前に message.id で重複排除する。
# - キャッシュ書込の単価: 1時間キャッシュ=入力単価の2倍、5分キャッシュ=1.25倍、
#   キャッシュ読込=0.1倍（Anthropicの標準的な料金倍率）。
JQ_COMMON='
  def rate($model):
    ($rates | keys) as $ks
    | ($ks | map(select(. as $k | $model | startswith($k))) | sort_by(length) | last) as $k
    | if $k then $rates[$k] else {in: 3.00, out: 15.00} end;
  def window($model):
    ($windows | keys) as $ks
    | ($ks | map(select(. as $k | $model | startswith($k))) | sort_by(length) | last) as $k
    | if $k then $windows[$k] else 1000000 end;
'

# コストはメインのトランスクリプトと全サブエージェントのトランスクリプトを合算する。
COST_USD=$(jq -s --argjson rates "$MODEL_RATES" --argjson windows "$CONTEXT_WINDOWS" "
  $JQ_COMMON
  [ .[] | select(.type == \"assistant\" and .message.usage != null) ]
  | unique_by(.message.id)
  | map(
      (.message.model) as \$model
      | rate(\$model) as \$r
      | .message.usage as \$u
      | (\$u.cache_creation.ephemeral_1h_input_tokens // 0) as \$write1h
      | (\$u.cache_creation.ephemeral_5m_input_tokens // 0) as \$write5m
      | ( (\$u.input_tokens // 0)            * \$r.in          / 1000000 )
      + ( (\$u.output_tokens // 0)           * \$r.out         / 1000000 )
      + ( \$write1h                          * (\$r.in * 2)    / 1000000 )
      + ( \$write5m                          * (\$r.in * 1.25) / 1000000 )
      + ( (\$u.cache_read_input_tokens // 0) * (\$r.in * 0.1)  / 1000000 )
    )
  | add // 0
" "${ALL_FILES[@]}")

# コンテキスト使用率はメイン会話のみを対象とする
# （サブエージェントはそれぞれ別のコンテキストウィンドウを持つため）。
# 直近ターンのusageを基準に算出する。
CONTEXT_PCT=$(jq -s --argjson rates "$MODEL_RATES" --argjson windows "$CONTEXT_WINDOWS" "
  $JQ_COMMON
  ([ .[] | select(.type == \"assistant\" and .message.usage != null) ] | last) as \$latest
  | if \$latest == null then 0
    else
      \$latest.message.usage as \$u
      | ((\$u.input_tokens // 0) + (\$u.cache_read_input_tokens // 0) + (\$u.cache_creation_input_tokens // 0)) as \$used
      | window(\$latest.message.model) as \$win
      | (\$used / \$win * 100)
    end
" "$TP")
CONTEXT_PCT_FMT=$(awk -v p="$CONTEXT_PCT" 'BEGIN{printf "%.1f", p}')

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

NOTIF_BODY="Task completed!\n${MSG}"
osascript -e "display notification \"$NOTIF_BODY\" with title \"Claude Code\"" >/dev/null 2>&1

jq -n --arg m "$MSG" '{systemMessage:$m, suppressOutput:true}'
exit 0
