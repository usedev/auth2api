# 手动查询与兑换 Claude 重置卡

查询与兑换接口由 auth2api 服务提供。下列地址均为示例，请替换为你的服务地址；cc-switch 的用量查询地址可独立配置，避免误改模型请求地址。粘贴 `cc-switch-usage.js` 后，将自动查询间隔设为 0 可关闭定时查询。

在你的终端准备变量（替换占位符，API_KEY 使用现有 auth2api key）：

```bash
BASE_URL='https://your-auth2api.example'
API_KEY='你的auth2api API key'
ACCOUNT_EMAIL='你的Claude账号邮箱'
```

## 一个 curl 自动查询并兑换

本版本新增一键兑换接口；现有两步接口仍可使用。

不需要手动查询或传 `confirmationToken`。下面一个请求由服务器查询上游指定的下一张可用卡，自动生成、保存确认凭据并兑换一次。**调用会真实消耗一张卡，仅在你决定重置时手动执行。**

```bash
curl --fail-with-body --max-time 120 \
  'https://your-auth2api.example/admin/reset-credits/redeem-next' \
  -H 'Authorization: Bearer 你的auth2api_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: reset-20261114-001' \
  --data '{"provider":"anthropic","email":"你的Claude账号邮箱","confirm":true}'
```

`Idempotency-Key` 是你本次兑换的操作编号，允许 16–128 个英文字母、数字、下划线或连字符。**同一次操作重试必须保持相同编号；确认需要新一次兑换时才更换编号。**不需要将任何查询结果复制进 curl，也不要在每次网络重试时生成新编号。

同编号重复请求只返回原结果，不会选择新卡。没有可用卡也会记住拒绝结果，不会在卡片之后出现时自动兑换。并发/中断操作返回 `operation_unresolved`；超时或 HTTP 202 `unknown` 必须先核实，禁止换编号盲目重试。一个编号不可用于不同账号或 API key。

## 保留的两步接口

只读查询：

```bash
curl --fail-with-body --get "$BASE_URL/admin/reset-credits" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode 'provider=anthropic' \
  --data-urlencode "email=$ACCOUNT_EMAIL"
```

先核对 credits 中的卡片名称、账号、clears、有效期和 redeemable。只有可用卡才有 confirmationToken，有效期 5 分钟。无可用卡时不能兑换，不要编造 token。新查询不会使旧卡消耗；确认绑定当时的卡片，不会自动切换为其他卡。

以下请求会真实消耗一张卡，只有你决定兑换时才手动运行：

```bash
CONFIRMATION_TOKEN='粘贴查询返回的confirmationToken'
python3 -c 'import json,sys; print(json.dumps({"provider":"anthropic","email":sys.argv[1],"confirm":True,"confirmationToken":sys.argv[2]}))' \
  "$ACCOUNT_EMAIL" "$CONFIRMATION_TOKEN" |
  curl --fail-with-body "$BASE_URL/admin/reset-credits/redeem" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @-
```

`outcome=reset` 才确认成功；HTTP 202 / `unknown` 表示结果未知，不能盲目再换 token 重试。服务将锁住该组织的后续兑换，需管理员核实上游结果后处理。不要将兑换请求放入 cc-switch 提取器或自动任务。

兑换后的用量查询可使用 `/admin/usage?provider=anthropic&refresh=true&includeResetCredits=true`。主服务沿用原有账号刷新机制；重置卡查询和兑换不会额外启动刷新任务。
