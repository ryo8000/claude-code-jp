# 引数: --argjson windows <モデル別コンテキストウィンドウ(トークン数)テーブル>
# 入力: メインのトランスクリプト(jsonl)を -s で結合したもの（サブエージェントは含めない。
#       それぞれ別のコンテキストウィンドウを持つため）
#
# 直近ターンのusage(input+cache_read+cache_creation)を、そのモデルの
# コンテキストウィンドウ上限で割って使用率を算出する。
def window($model):
  ($windows | keys) as $ks
  | ($ks | map(select(. as $k | $model | startswith($k))) | sort_by(length) | last) as $k
  | if $k then $windows[$k] else 1000000 end;

([ .[] | select(.type == "assistant" and .message.usage != null) ] | last) as $latest
| if $latest == null then 0
  else
    $latest.message.usage as $u
    | (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0)) as $used
    | window($latest.message.model) as $win
    | ($used / $win * 100)
  end
