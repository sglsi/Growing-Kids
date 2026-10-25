#!/usr/bin/env bash
# 资料库 → 百度网盘归档 端到端联调（一次性脚本，跑完可删）
# 流程：上传测试文件(purpose=attach) → 建资料库条目 → 轮询 netdisk_path → 校验网盘实文件
set -u
BASE="http://127.0.0.1:3001/api"
# ⚠️ 用 X-Device-Id（稳定身份：findOrCreateByDeviceId），不要用裸 X-User-Id——
#    不存在的裸 id 会让中间件每次请求新建匿名用户，create/list 落到不同账号。
H=(-H "X-Device-Id: e2e-netdisk-device")
NAME="网盘归档联调-$(date +%H%M%S).txt"
FILE="/d/AI/Growing-Kids/server/logs/e2e-library-src.txt"
ENC() { node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$1"; }
JQ() { node -e "const m=process.argv[2].match(process.argv[1]);process.stdout.write(m&&m[1]?m[1]:'')" "$1" "$2"; }

printf 'GrowingKids 资料库->网盘 端到端联调\n时间：%s\n' "$(date -Iseconds)" > "$FILE"

echo "== 1) 上传（purpose=attach，只拿 key 不建条目）"
UP=$(curl -s --noproxy '*' --max-time 30 "${H[@]}" -F "file=@$FILE" -F "purpose=attach" -F "original_name=$(ENC "$NAME")" "$BASE/upload")
echo "$UP" | head -c 300; echo
KEY=$(JQ '"key":"([^"]+)"' "$UP")
[ -n "$KEY" ] || { echo "FAIL: 拿不到 key"; exit 1; }
echo "key=$KEY"

echo "== 2) 建资料库条目（触发异步网盘同步）"
CREATE=$(curl -s --noproxy '*' --max-time 30 "${H[@]}" -X POST "$BASE/library" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"file_key\":\"$KEY\",\"mime_type\":\"text/plain\",\"source\":\"upload\"}")
echo "$CREATE" | head -c 300; echo
DOC_ID=$(JQ '"id":"([^"]+)"' "$CREATE")
[ -n "$DOC_ID" ] || { echo "FAIL: 建条目失败"; exit 1; }
echo "doc_id=$DOC_ID"

echo "== 3) 轮询 netdisk_path（异步同步，最多等 40s）"
NETDISK_PATH=""
for i in $(seq 1 20); do
  sleep 2
  ROW=$(curl -s --noproxy '*' --max-time 15 "${H[@]}" "$BASE/library?keyword=$(ENC "$NAME")")
  NETDISK_PATH=$(JQ '"netdisk_path":"([^"]+)"' "$ROW")
  [ -n "$NETDISK_PATH" ] && break
  echo "  ...第 ${i} 次轮询，尚未落库"
done
[ -n "$NETDISK_PATH" ] || { echo "FAIL: 40s 内 netdisk_path 未落库（看后端日志 [library] 网盘归档失败）"; exit 1; }
echo "netdisk_path=$NETDISK_PATH"

echo "== 4) 直接查网盘确认文件实体存在"
node --input-type=module -e "
import fs from 'node:fs'
for (const f of ['.env', '.env.secrets']) {
  if (!fs.existsSync(f)) continue
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue
    const i = t.indexOf('='); if (i <= 0) continue
    const k = t.slice(0, i).trim(); if (k && !(k in process.env)) process.env[k] = t.slice(i + 1).trim()
  }
}
const { BaiduNetdiskService } = await import('./dist/storage/baidu-netdisk.service.js')
const svc = new BaiduNetdiskService()
const list = await svc.list(svc.root())
const hit = list.find((f) => f.server_filename === process.argv[1])
if (!hit) { console.error('FAIL: 网盘目录中找不到 ' + process.argv[1] + '（共 ' + list.length + ' 项）'); process.exit(1) }
console.log('OK 网盘实体存在：' + hit.server_filename + '（' + hit.size + 'B, fs_id=' + hit.fs_id + '）')
" "$NAME" 2>&1 || exit 1

echo "== 5) 清理：删资料库条目（网盘副本默认不联动删，保留作归档样本）"
curl -s --noproxy '*' --max-time 15 "${H[@]}" -X POST "$BASE/library/batch-delete" -H 'Content-Type: application/json' -d "{\"ids\":[\"$DOC_ID\"]}" | head -c 200; echo
echo "=== 端到端联调完成 ==="
