const config = require("./config.js");

class Logger {
  httpLogger = (req, res, next) => {
    let send = res.send;
    res.send = (resBody) => {
      const logData = {
        authorized: !!req.headers.authorization,
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        reqBody: JSON.stringify(req.body),
        resBody: String(resBody),
      };
      const level = this.statusToLogLevel(res.statusCode);
      this.log(level, "http", logData);
      res.send = send;
      return res.send(resBody);
    };
    next();
  };

  dbLogger = (query) => {
    this.log("info", "db", { query: query }); // Wrap it in an object!
  };

  factoryLogger = (reqBody, resBody) => {
    this.log("info", "factory", { reqBody, resBody });
  };

  unhandledErrorLogger = (err) => {
    this.log("error", "unhandledException", {
      message: err.message,
      stack: err.stack,
    });
  };

  log = (level, type, logData) => {
    const labels = {
      component: config.logging?.source,
      level: level,
      type: type,
    };
    const values = [this.nowString(), this.sanitize(JSON.stringify(logData))];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  };

  statusToLogLevel = (statusCode) => {
    if (statusCode >= 500) return "error";
    if (statusCode >= 400) return "warn";
    return "info";
  };

  nowString = () => {
    return (Math.floor(Date.now()) * 1000000).toString();
  };

  sanitize = (logData) => {
    logData = logData.replace(
      /\\"password\\":\s*\\"[^"]*\\"/g,
      '\\"password\\":\\"*****\\"',
    );
    logData = logData.replace(
      /\\"token\\":\s*\\"[^"]*\\"/g,
      '\\"token\\":\\"*****\\"',
    );
    return logData;
  };

  sendLogToGrafana = (event) => {
    if (!config.logging) return; // Prevent crashing if config is missing
    const body = JSON.stringify(event);
    fetch(`${config.logging.endpointUrl}`, {
      method: "post",
      body: body,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.logging.accountId}:${config.logging.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log("Failed to send log to Grafana");
      })
      .catch((err) => {
        console.error("Error sending log to Grafana", err);
      });
  };
}

module.exports = new Logger();
