# 手动查询与兑换 Claude 重置卡

独立查询服务：`http://180.93.164.112:8081`。原模型 API 继续使用 8080，勿修改模型请求地址。cc-switch 仅将「用量查询 → 请求地址」改为新地址，粘贴 `cc-switch-usage.js`，自动查询间隔设为 0。

在你的终端准备变量（替换占位符，API_KEY 使用现有 auth2api key）：

```bash
BASE_URL='http://180.93.164.112:8081'
API_KEY='你的auth2api API key'
ACCOUNT_EMAIL='你的Claude账号邮箱'
```

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

兑换后的用量查询可使用 `/admin/usage?provider=anthropic&refresh=true&includeResetCredits=true`。本独立实例没有后台 token 刷新任务；它在查询前只读加载原服务管理的凭据。
