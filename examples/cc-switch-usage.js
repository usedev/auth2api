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
    function resetLabel(value) {
      var formatted = beijingTime(value);
      if (formatted === "未知") return "重置时间未知";
      var today = beijingTime(new Date(now).toISOString());
      var prefix =
        formatted.slice(0, 10) === today.slice(0, 10)
          ? "今天 "
          : formatted.slice(5, 10) + " ";
      var label = prefix + formatted.slice(11, 16) + " 重置（北京）";
      return Date.parse(value) <= now ? label + "，请刷新确认" : label;
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
      five_hour: "当前会话",
      seven_day: "本周",
      seven_day_sonnet: "Sonnet 每周",
      seven_day_opus: "Opus 每周",
      seven_day_oauth_apps: "OAuth 应用每周",
      seven_day_overage_included: "Fable",
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
        var windowName =
          window.displayName || names[window.name] || window.name;
        var details = [
          windowName,
          "已用 " + percent(window.usedPercent),
          "剩余 " + percent(window.remainingPercent),
          countdown(window.resetsAt),
          "重置时间: " + beijingTime(window.resetsAt),
          "账号: " + label,
        ];
        var weeklyShare =
          typeof window.allowancePercentOfWeekly === "number"
            ? "最多占周额度 " + percent(window.allowancePercentOfWeekly)
            : "";
        if (weeklyShare) details.push(weeklyShare);
        if (typeof window.usedPercentOfWeekly === "number")
          details.push("已占周额度 " + percent(window.usedPercentOfWeekly));
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
                resetLabel(window.resetsAt),
                weeklyShare,
                account.cached ? "缓存" : "",
              ]
                .filter(Boolean)
                .join(" · "),
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
