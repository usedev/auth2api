({
  request: {
    url:
      "{{baseUrl}}".replace(/\/+$/, "").replace(/\/v1$/, "") +
      "/admin/usage?provider=anthropic",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      "User-Agent": "cc-switch/1.0",
    },
  },
  extractor: function (response) {
    // Use UTC methods with a fixed UTC+8 offset: cc-switch's JS runtime
    // may not provide Intl/timeZone support or use the desktop's timezone.
    function beijingTime(value) {
      if (typeof value !== "string" || !value) return "未知";
      var timestamp = Date.parse(value);
      if (!isFinite(timestamp)) return "未知";
      var date = new Date(timestamp + 8 * 60 * 60 * 1000);
      if (!isFinite(date.getTime())) return "未知";
      return date.toISOString().slice(0, 19).replace("T", " ") + "（北京时间）";
    }
    // Set true only when full account/plan/credit details are needed.
    var showDetails = false;
    function shortTime(value) {
      var formatted = beijingTime(value);
      return formatted === "未知" ? "未知" : formatted.slice(5, 16);
    }
    var now = Date.now();
    function percent(value) {
      return typeof value === "number" && isFinite(value)
        ? value.toFixed(2) + "%"
        : "未知";
    }
    function countdown(value) {
      var reset = typeof value === "string" ? Date.parse(value) : NaN;
      if (!isFinite(reset)) return "重置倒计时未知";
      if (reset <= now) return "已到重置时间，请刷新确认";
      var minutes = Math.ceil((reset - now) / 60000);
      var days = Math.floor(minutes / 1440);
      var hours = Math.floor((minutes % 1440) / 60);
      var rest = minutes % 60;
      return (
        (days ? days + " 天 " : "") +
        (hours ? hours + " 小时 " : "") +
        (rest ? rest + " 分钟" : "") +
        "后重置（查询时估算）"
      );
    }
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
      seven_day_oauth_apps: "OAuth 应用每周",
      seven_day_overage_included: "额外每周窗口",
    };
    var results = [];
    response.accounts.forEach(function (account, accountIndex) {
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
        var windowName = names[window.name] || window.name;
        var details = [
          windowName,
          "已用 " + percent(window.usedPercent),
          "剩余 " + percent(window.remainingPercent),
          countdown(window.resetsAt),
          "重置时间: " + beijingTime(window.resetsAt),
          "账号: " + label,
        ];
        if (account.planType) details.push("订阅: " + account.planType);
        if (account.credits) {
          if (account.credits.unlimited === true) details.push("积分: 不限量");
          else if (typeof account.credits.balance === "string")
            details.push(
              "积分余额: " + account.credits.balance + "（上游原值）",
            );
        }
        details.push(
          "查询时间: " +
            beijingTime(account.fetchedAt) +
            (account.cached ? "（缓存）" : "（本次获取）"),
        );
        var result = {
          planName:
            windowName +
            (response.accounts.length > 1 ? " #" + (accountIndex + 1) : ""),
          isValid:
            typeof window.remainingPercent === "number" &&
            isFinite(window.remainingPercent),
          unit: "%",
          extra: showDetails
            ? details.join("；")
            : [
                "已用 " + percent(window.usedPercent),
                countdown(window.resetsAt)
                  .replace("后重置（查询时估算）", "后重置")
                  .replace(/ 天 /g, "天")
                  .replace(/ 小时 /g, "时")
                  .replace(/ 分钟/g, "分"),
                shortTime(window.resetsAt) + " 北京",
                "更新 " +
                  (beijingTime(account.fetchedAt) === "未知"
                    ? "未知"
                    : beijingTime(account.fetchedAt).slice(11, 16)) +
                  (account.cached ? " 缓存" : ""),
              ].join(" · "),
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
