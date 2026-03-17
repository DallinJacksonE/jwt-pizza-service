const config = require("./config");
const os = require("os");

// Metrics stored in memory

// --- Cumulative Metrics (never reset) ---
const requests = {};
let greetingChangedCount = 0;

// --- Interval-based Metrics (reset after each send) ---
let purchaseSuccessCount = 0;
let purchaseFailureCount = 0;
let totalPurchaseValue = 0;
let purchaseLatencySum = 0;
let purchaseCount = 0;
let loginSuccessCount = 0;
let loginFailureCount = 0;
let logoutCount = 0;
let userRegistrationCount = 0;

// =================================================================================
// Metric Collection Functions
// =================================================================================

function requestTracker(req, res, next) {
  const endpoint = `[${req.method}] ${req.path}`;
  requests[endpoint] = (requests[endpoint] || 0) + 1;
  next();
}

function greetingChanged() {
  greetingChangedCount++;
}

function pizzaPurchase(success, latency, price) {
  purchaseCount++;
  purchaseLatencySum += latency;
  if (success) {
    purchaseSuccessCount++;
    totalPurchaseValue += price;
  } else {
    purchaseFailureCount++;
  }
}

function userLoggedIn(success) {
  if (success) {
    loginSuccessCount++;
  } else {
    loginFailureCount++;
  }
}

function userLoggedOut() {
  logoutCount++;
}

function userRegistered() {
  userRegistrationCount++;
}

// =================================================================================
// System Metric Helpers
// =================================================================================

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return cpuUsage.toFixed(2) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return memoryUsage.toFixed(2);
}

// =================================================================================
// Metric Sending Logic
// =================================================================================

/**
 * This function runs periodically to gather all collected metrics,
 * format them, and send them to Grafana.
 */
setInterval(() => {
  try {
    const metrics = [];

    // 1. HTTP Metrics (from middleware)
    Object.keys(requests).forEach((endpoint) => {
      metrics.push(
        createMetric(
          "http.requests.count",
          requests[endpoint],
          "1",
          "sum",
          "asInt",
          {
            endpoint,
          },
        ),
      );
    });

    // 2. System Metrics
    metrics.push(
      createMetric(
        "system.cpu.utilization",
        getCpuUsagePercentage(),
        "%",
        "gauge",
        "asDouble",
        {},
      ),
    );
    metrics.push(
      createMetric(
        "system.memory.utilization",
        getMemoryUsagePercentage(),
        "%",
        "gauge",
        "asDouble",
        {},
      ),
    );

    // 3. User & Auth Metrics
    if (userRegistrationCount > 0) {
      metrics.push(
        createMetric(
          "user.registrations",
          userRegistrationCount,
          "1",
          "sum",
          "asInt",
          {},
        ),
      );
    }
    if (loginSuccessCount > 0) {
      metrics.push(
        createMetric("auth.logins", loginSuccessCount, "1", "sum", "asInt", {
          result: "success",
        }),
      );
    }
    if (loginFailureCount > 0) {
      metrics.push(
        createMetric("auth.logins", loginFailureCount, "1", "sum", "asInt", {
          result: "failure",
        }),
      );
    }
    if (logoutCount > 0) {
      metrics.push(
        createMetric("auth.logouts", logoutCount, "1", "sum", "asInt", {}),
      );
    }

    // 4. Purchase Metrics
    if (purchaseCount > 0) {
      metrics.push(
        createMetric(
          "purchase.count",
          purchaseSuccessCount,
          "1",
          "sum",
          "asInt",
          { result: "success" },
        ),
      );
      metrics.push(
        createMetric(
          "purchase.count",
          purchaseFailureCount,
          "1",
          "sum",
          "asInt",
          { result: "failure" },
        ),
      );
      metrics.push(
        createMetric(
          "purchase.revenue",
          totalPurchaseValue,
          "USD",
          "sum",
          "asDouble",
          {},
        ),
      );

      const avgLatency = purchaseLatencySum / purchaseCount;
      metrics.push(
        createMetric(
          "purchase.latency",
          avgLatency.toFixed(2),
          "ms",
          "gauge",
          "asDouble",
          {},
        ),
      );
    }

    // 5. Other custom metrics
    metrics.push(
      createMetric(
        "greeting.change.count",
        greetingChangedCount,
        "1",
        "sum",
        "asInt",
        {},
      ),
    );

    sendMetricToGrafana(metrics);

    // --- Reset interval-based counters ---
    purchaseSuccessCount = 0;
    purchaseFailureCount = 0;
    totalPurchaseValue = 0;
    purchaseLatencySum = 0;
    purchaseCount = 0;
    loginSuccessCount = 0;
    loginFailureCount = 0;
    logoutCount = 0;
    userRegistrationCount = 0;
  } catch (error) {
    console.error("Error sending metrics", error);
  }
}, 10000);

/**
 * Creates a metric object in the OTLP JSON format that Grafana expects.
 * @param {string} metricName The name of the metric.
 * @param {number|string} metricValue The value of the metric.
 * @param {string} metricUnit The unit of the metric (e.g., 'ms', '1' for count).
 * @param {'sum'|'gauge'} metricType The type of metric.
 * @param {'asInt'|'asDouble'} valueType The data type of the value.
 * @param {object} attributes A key-value object for metric attributes.
 * @returns {object} The formatted metric object.
 */
function createMetric(
  metricName,
  metricValue,
  metricUnit,
  metricType,
  valueType,
  attributes,
) {
  attributes = { ...attributes, source: config.metrics.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]:
            valueType === "asInt"
              ? parseInt(metricValue, 10)
              : parseFloat(metricValue),
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: String(attributes[key]) },
    });
  });

  if (metricType === "sum") {
    metric.sum.aggregationTemporality = "AGGREGATION_TEMPORALITY_CUMULATIVE";
    metric.sum.isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  if (metrics.length === 0) {
    return;
  }
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.metrics.endpointUrl}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      "Content-Type": "application/json",
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`HTTP status ${response.status}: ${responseBody}`);
      }
    })
    .catch((error) => {
      console.error("Error pushing metrics:", error);
    });
}

module.exports = {
  requestTracker,
  greetingChanged,
  pizzaPurchase,
  userLoggedIn,
  userLoggedOut,
  userRegistered,
};
