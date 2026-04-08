const config = require("./config");
const os = require("os");

// --- Server Start Time (Required for OTLP Cumulative Metrics) ---
const serverStartTime = Date.now();

// --- Cumulative Metrics (never reset) ---
const requests = {};
let purchaseSuccessCount = 0;
let purchaseFailureCount = 0;
let totalPurchaseValue = 0;
let loginSuccessCount = 0;
let loginFailureCount = 0;
let logoutCount = 0;
let userRegistrationCount = 0;

// --- Interval Gauges (reset every 5 seconds) ---
const activeUsersInInterval = new Set();
const endpointLatencies = {};
const pizzaCreationLatencies = [];

// =================================================================================
// Metric Collection Functions
// =================================================================================

/**
 * Tracks a user as active for the current interval.
 * @param {number} userId
 */
function trackUserActivity(userId) {
  if (userId) {
    activeUsersInInterval.add(userId);
  }
}

/**
 * Tracks the latency of a pizza creation call to the factory.
 * @param {number} duration The duration in milliseconds.
 */
function trackPizzaCreationLatency(duration) {
  pizzaCreationLatencies.push(duration);
}

/**
 * Middleware to track requests for each endpoint.
 */
function requestTracker(req, res, next) {
  const start = process.hrtime();

  res.on("finish", () => {
    if (!req.route) {
      return;
    }
    const routePattern = req.route ? req.route.path : req.path;

    // If your routers are nested (like /api/franchise), req.route.path only
    // gives the last piece (e.g., '/:franchiseId').
    // We combine req.baseUrl with the pattern to get the full picture.
    const fullRoute = req.baseUrl
      ? `${req.baseUrl}${routePattern}`
      : routePattern;
    const endpoint = `[${req.method}] ${fullRoute}`;

    // Track Request Count (Cumulative)
    requests[endpoint] = (requests[endpoint] || 0) + 1;

    // Track Latency (Gauge for this interval)
    const diff = process.hrtime(start);
    const duration = diff[0] * 1e3 + diff[1] * 1e-6; // ms
    if (!endpointLatencies[endpoint]) endpointLatencies[endpoint] = [];
    endpointLatencies[endpoint].push(duration);
  });

  next();
}

/**
 * Tracks successful and failed pizza purchases.
 * @param {boolean} success Whether the purchase was successful.
 * @param {number} price The total price of the purchase.
 */
function pizzaPurchase(success, price) {
  if (success) {
    purchaseSuccessCount++;
    totalPurchaseValue += price;
  } else {
    purchaseFailureCount++;
  }
}

/**
 * Tracks successful and failed user logins.
 * @param {boolean} success
 */
function userLoggedIn(success) {
  if (success) {
    loginSuccessCount++;
  } else {
    loginFailureCount++;
  }
}

/**
 * Tracks user logouts.
 */
function userLoggedOut() {
  logoutCount++;
}

/**
 * Tracks new user registrations.
 */
function userRegistered() {
  userRegistrationCount++;
}

// =================================================================================
// System Metric Helpers
// =================================================================================

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return (cpuUsage * 100).toFixed(2);
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
 * format them, and send them to Grafana. All counters are cumulative.
 */
async function buildAndSendMetrics() {
  try {
    const metrics = [];

    // 1. HTTP Request Metrics
    Object.keys(requests).forEach((endpoint) => {
      metrics.push(
        createMetric(
          "http.requests.count",
          requests[endpoint],
          "1",
          "sum",
          "asInt",
          { endpoint },
        ),
      );
    });

    // 2. User & Auth Metrics
    metrics.push(
      createMetric(
        "user.registrations",
        userRegistrationCount,
        "1",
        "sum",
        "asInt",
      ),
    );
    metrics.push(
      createMetric(
        "auth.logins.success",
        loginSuccessCount,
        "1",
        "sum",
        "asInt",
      ),
    );
    metrics.push(
      createMetric(
        "auth.logins.failure",
        loginFailureCount,
        "1",
        "sum",
        "asInt",
      ),
    );
    metrics.push(
      createMetric("auth.logouts", logoutCount, "1", "sum", "asInt"),
    );

    // 3. Purchase Metrics
    metrics.push(
      createMetric(
        "purchase.count.success",
        purchaseSuccessCount,
        "1",
        "sum",
        "asInt",
      ),
    );
    metrics.push(
      createMetric(
        "purchase.count.failure",
        purchaseFailureCount,
        "1",
        "sum",
        "asInt",
      ),
    );
    metrics.push(
      createMetric(
        "purchase.revenue",
        totalPurchaseValue,
        "USD",
        "sum",
        "asDouble",
      ),
    );

    // 4. System Metrics (Gauges)
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

    // 5. Active Users
    metrics.push(
      createMetric(
        "users.active",
        activeUsersInInterval.size,
        "1",
        "gauge",
        "asInt",
      ),
    );
    activeUsersInInterval.clear(); // Clear gauge for next interval

    // 6. Endpoint Latency Metrics (Aggregated Gauges)
    Object.keys(endpointLatencies).forEach((endpoint) => {
      const latencies = endpointLatencies[endpoint];
      if (latencies.length > 0) {
        const total = latencies.reduce((sum, val) => sum + val, 0);
        const avg = total / latencies.length;
        const max = Math.max(...latencies);

        metrics.push(
          createMetric(
            "http.requests.latency.avg",
            avg,
            "ms",
            "gauge",
            "asDouble",
            { endpoint },
          ),
        );
        metrics.push(
          createMetric(
            "http.requests.latency.max",
            max,
            "ms",
            "gauge",
            "asDouble",
            { endpoint },
          ),
        );
      }
    });

    // 7. Pizza Creation Latency (Aggregated Gauges)
    if (pizzaCreationLatencies.length > 0) {
      const total = pizzaCreationLatencies.reduce((sum, val) => sum + val, 0);
      const avg = total / pizzaCreationLatencies.length;
      const max = Math.max(...pizzaCreationLatencies);

      metrics.push(
        createMetric(
          "pizza.creation.latency.avg",
          avg,
          "ms",
          "gauge",
          "asDouble",
        ),
      );
      metrics.push(
        createMetric(
          "pizza.creation.latency.max",
          max,
          "ms",
          "gauge",
          "asDouble",
        ),
      );
    }

    // --- ONLY CLEAR GAUGES FOR NEXT INTERVAL ---
    // Do NOT reset cumulative counters (purchases, logins, requests, etc.)
    pizzaCreationLatencies.length = 0;
    Object.keys(endpointLatencies).forEach(
      (key) => delete endpointLatencies[key],
    );

    return await sendMetricToGrafana(metrics);
  } catch (error) {
    console.error("Error building or sending metrics:", error);
    return Promise.reject(error);
  }
}

/**
 * Creates a metric object in the OTLP JSON format that Grafana expects.
 */
function createMetric(
  metricName,
  metricValue,
  metricUnit,
  metricType,
  valueType,
  attributes = {},
) {
  attributes = { ...attributes, source: config.metrics.source };

  // Calculate timestamps once for consistency
  const nowMs = Date.now();
  const timeUnixNano = nowMs * 1000000;
  // Use the server start time for cumulative metrics
  const startTimeUnixNano = serverStartTime * 1000000;

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
          timeUnixNano: timeUnixNano,
          startTimeUnixNano: startTimeUnixNano,
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
    // Reverted to CUMULATIVE so Grafana accepts it!
    metric.sum.aggregationTemporality = "AGGREGATION_TEMPORALITY_CUMULATIVE";
    metric.sum.isMonotonic = true;
  }

  return metric;
}

/**
 * Sends the formatted metrics payload to Grafana.
 */
async function sendMetricToGrafana(metrics) {
  if (metrics.length === 0) {
    return Promise.resolve();
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

  try {
    const response = await fetch(`${config.metrics.endpointUrl}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`HTTP status ${response.status}: ${responseBody}`);
    }
    console.log(`Metrics Sent: ${response.status}`);
  } catch (error) {
    console.error("Error pushing metrics:", error);
  }
}

if (process.env.NODE_ENV !== "test") {
  setInterval(async () => {
    await buildAndSendMetrics();
  }, 5000);
  timer.unref();
}

module.exports = {
  trackPizzaCreationLatency,
  trackUserActivity,
  requestTracker,
  pizzaPurchase,
  userLoggedIn,
  userLoggedOut,
  userRegistered,
  buildAndSendMetrics,
};
