/* global describe, test, expect, jest, beforeEach, afterEach */

// 1. Mock dependencies before any imports
jest.mock("./config", () => ({
  metrics: {
    source: "test-service",
    endpointUrl: "http://test-grafana.com",
    apiKey: "test-api-key",
    accountId: "test-account-id",
  },
}));

jest.mock("os", () => ({
  loadavg: jest.fn(),
  cpus: jest.fn(),
  totalmem: jest.fn(),
  freemem: jest.fn(),
}));

// Mock global fetch
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    text: () => Promise.resolve(""),
  }),
);

describe("metrics", () => {
  let metrics;

  beforeEach(() => {
    // Reset modules to clear internal state (like cumulative counters)
    jest.resetModules();

    // Clear all mocks
    jest.clearAllMocks();

    // Re-import 'os' after reset and configure mocks
    const os = require("os");
    os.loadavg.mockReturnValue([0.5]);
    os.cpus.mockReturnValue([{}, {}]); // 2 cpus
    os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16GB
    os.freemem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8GB

    // Re-require the module to get a fresh instance for each test
    metrics = require("./metrics");
  });

  afterEach(() => {
    // Restore real timers
    jest.useRealTimers();
  });

  test("requestTracker should increment endpoint count and call next", () => {
    const req = { method: "GET", path: "/api/test" };
    const next = jest.fn();

    metrics.requestTracker(req, {}, next);
    metrics.requestTracker(req, {}, next);

    // The internal `requests` object is not exported, so we verify its state
    // by calling the function that uses it: buildAndSendMetrics.
    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const requestMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "http.requests.count",
      );

    expect(requestMetric.sum.dataPoints[0].asInt).toBe(2);
    expect(
      requestMetric.sum.dataPoints[0].attributes.find(
        (a) => a.key === "endpoint",
      ).value.stringValue,
    ).toBe("[GET] /api/test");
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("pizzaPurchase should increment success and revenue on success", () => {
    metrics.pizzaPurchase(true, 15.99);
    metrics.pizzaPurchase(true, 10.01);

    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const successMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "purchase.count.success",
      );
    const revenueMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "purchase.revenue",
      );

    expect(successMetric.sum.dataPoints[0].asInt).toBe(2);
    expect(revenueMetric.sum.dataPoints[0].asDouble).toBe(26.0);
  });

  test("pizzaPurchase should increment failure on failure", () => {
    metrics.pizzaPurchase(false, 20); // price is ignored on failure

    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const failureMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "purchase.count.failure",
      );
    const revenueMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "purchase.revenue",
      );

    expect(failureMetric.sum.dataPoints[0].asInt).toBe(1);
    expect(revenueMetric.sum.dataPoints[0].asDouble).toBe(0);
  });

  test("userLoggedIn should increment success and failure counters", () => {
    metrics.userLoggedIn(true);
    metrics.userLoggedIn(true);
    metrics.userLoggedIn(false);

    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const successMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "auth.logins.success",
      );
    const failureMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "auth.logins.failure",
      );

    expect(successMetric.sum.dataPoints[0].asInt).toBe(2);
    expect(failureMetric.sum.dataPoints[0].asInt).toBe(1);
  });

  test("userLoggedOut should increment logout counter", () => {
    metrics.userLoggedOut();
    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const logoutMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "auth.logouts",
      );
    expect(logoutMetric.sum.dataPoints[0].asInt).toBe(1);
  });

  test("userRegistered should increment registration counter", () => {
    metrics.userRegistered();
    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const regMetric = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "user.registrations",
    );
    expect(regMetric.sum.dataPoints[0].asInt).toBe(1);
  });

  test("buildAndSendMetrics should construct and send a full payload", () => {
    // Freeze time to get a deterministic timestamp for the snapshot
    const FAKE_TIME = 1678886400000;
    jest.useFakeTimers().setSystemTime(FAKE_TIME);

    // 1. Collect a variety of metrics
    metrics.requestTracker({ method: "GET", path: "/api/menu" }, {}, () => {});
    metrics.userRegistered();
    metrics.userLoggedIn(true);
    metrics.userLoggedIn(false);
    metrics.pizzaPurchase(true, 25.5);
    metrics.pizzaPurchase(false, 0);
    metrics.userLoggedOut();

    // 2. Call the function that builds and sends the payload
    metrics.buildAndSendMetrics();

    // 3. Assert fetch was called with the correct parameters
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("http://test-grafana.com", {
      method: "POST",
      body: expect.any(String),
      headers: {
        Authorization: "Bearer test-account-id:test-api-key",
        "Content-Type": "application/json",
      },
    });

    // 4. Assert the payload is correct using a snapshot
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const allMetrics = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(allMetrics).toMatchSnapshot();

    // 5. Specific checks for calculated system metrics
    const cpuMetric = allMetrics.find(
      (m) => m.name === "system.cpu.utilization",
    );
    const memMetric = allMetrics.find(
      (m) => m.name === "system.memory.utilization",
    );

    // (0.5 load avg / 2 cpus) * 100 = 25.00
    expect(cpuMetric.gauge.dataPoints[0].asDouble).toBe(25.0);
    // ((16GB total - 8GB free) / 16GB total) * 100 = 50.00
    expect(memMetric.gauge.dataPoints[0].asDouble).toBe(50.0);
  });

  test("should handle fetch errors gracefully", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    global.fetch.mockRejectedValueOnce(new Error("Network failure"));

    metrics.pizzaPurchase(true, 10); // Generate a metric to ensure fetch is called
    await metrics.buildAndSendMetrics();

    // The promise rejection is handled inside sendMetricToGrafana, so the promise
    // returned by buildAndSendMetrics resolves. We just need to wait for the next
    // tick of the event loop to allow the .catch() block's console.error to execute.
    await new Promise(process.nextTick);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Error pushing metrics:",
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });
});
