# 引数: --argjson rates <モデル別単価テーブル>
# 入力: メイン + サブエージェントのトランスクリプト(jsonl)を -s で結合したもの
#
# - モデル名は前方一致で照合するため、日付付きのモデルID
#   （例: サブエージェントのトランスクリプトで使われる claude-haiku-4-5-20251001）も
#   $rates のエイリアスキーに解決できる。
# - 同一のAPIレスポンスがcontent blockごとに複数のトランスクリプト行として
#   記録されるため、集計前に message.id で重複排除する。
# - キャッシュ書込の単価: 1時間キャッシュ=入力単価の2倍、5分キャッシュ=1.25倍、
#   キャッシュ読込=0.1倍（Anthropicの標準的な料金倍率）。
def rate($model):
  ($rates | keys) as $ks
  | ($ks | map(select(. as $k | $model | startswith($k))) | sort_by(length) | last) as $k
  | if $k then $rates[$k] else {in: 3.00, out: 15.00} end;

[ .[] | select(.type == "assistant" and .message.usage != null) ]
| unique_by(.message.id)
| map(
    (.message.model) as $model
    | rate($model) as $r
    | .message.usage as $u
    | ($u.cache_creation.ephemeral_1h_input_tokens // 0) as $write1h
    | ($u.cache_creation.ephemeral_5m_input_tokens // 0) as $write5m
    | ( ($u.input_tokens // 0)            * $r.in          / 1000000 )
    + ( ($u.output_tokens // 0)           * $r.out         / 1000000 )
    + ( $write1h                          * ($r.in * 2)    / 1000000 )
    + ( $write5m                          * ($r.in * 1.25) / 1000000 )
    + ( ($u.cache_read_input_tokens // 0) * ($r.in * 0.1)  / 1000000 )
  )
| add // 0
