({
  request: {
    url:
      "{{baseUrl}}".replace(/\/+$/, "").replace(/\/v1$/, "") +
      "/admin/usage?provider=codex",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      "User-Agent": "cc-switch/1.0",
    },
  },
  extractor: function (response) {
    if (!response || !Array.isArray(response.accounts)) {
      return { isValid: false, invalidMessage: "用量接口返回格式错误" };
    }
    if (response.accounts.length === 0) {
      return { isValid: false, invalidMessage: "没有匹配的上游账号" };
    }
    var names = {
      five_hour: "5 小时",
      seven_day: "每周",
      seven_day_sonnet: "Sonnet 每周",
      seven_day_opus: "Opus 每周",
    };
    var results = [];
    response.accounts.forEach(function (account) {
      var label = account.provider + " / " + account.email;
      if (account.error || !account.supported) {
        results.push({
          planName: label,
          isValid: false,
          invalidMessage: account.error
            ? account.error.message
            : "暂不支持该提供商",
        });
        return;
      }
      if (!account.windows || account.windows.length === 0) {
        results.push({
          planName: label,
          isValid: false,
          invalidMessage: "上游未提供额度窗口数据",
        });
        return;
      }
      account.windows.forEach(function (window) {
        var result = {
          planName: label + " · " + (names[window.name] || window.name),
          isValid: typeof window.remainingPercent === "number",
          unit: "%",
          extra:
            "重置时间: " +
            (window.resetsAt || "未知") +
            "；查询时间: " +
            account.fetchedAt +
            (account.cached ? "（缓存）" : ""),
        };
        if (result.isValid) {
          result.total = 100;
          result.used = window.usedPercent;
          result.remaining = window.remainingPercent;
        } else {
          result.invalidMessage = "上游未提供已用比例";
        }
        results.push(result);
      });
    });
    return results;
  },
});
