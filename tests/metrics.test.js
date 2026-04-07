/* global describe, test, expect, jest, beforeEach, afterEach */
const { EventEmitter } = require("events");

// 1. Mock dependencies before any imports
jest.mock("../src/config", () => ({
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
    metrics = require("../src/metrics");

    // Silence console logs during tests
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore real timers
    jest.useRealTimers();
  });

  test("requestTracker should increment endpoint count and call next", () => {
    const req = { method: "GET", path: "/api/test" };
    const res = new EventEmitter();
    const next = jest.fn();

    metrics.requestTracker(req, res, next);
    res.emit("finish");
    metrics.requestTracker(req, res, next);
    res.emit("finish");

    // The internal `requests` object is not exported, so we verify its state
    // by calling the function that uses it: buildAndSendMetrics.
    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const requestMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "http.requests.count",
      );

    expect(requestMetric.sum.dataPoints[0].asInt).toBe(3);
    expect(
      requestMetric.sum.dataPoints[0].attributes.find(
        (a) => a.key === "endpoint",
      ).value.stringValue,
    ).toBe("[GET] /api/test");
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("requestTracker should record endpoint latency", () => {
    const req = { method: "GET", path: "/api/latency-test" };
    const next = jest.fn();
    const hrtimeSpy = jest.spyOn(process, "hrtime");

    // Simulate two requests, one taking 50ms, the other 100ms
    const res1 = new EventEmitter();
    hrtimeSpy.mockReturnValueOnce([0, 0]);
    hrtimeSpy.mockReturnValueOnce([0, 50000000]);
    metrics.requestTracker(req, res1, next);
    res1.emit("finish");

    const res2 = new EventEmitter();
    hrtimeSpy.mockReturnValueOnce([0, 0]);
    hrtimeSpy.mockReturnValueOnce([0, 100000000]);
    metrics.requestTracker(req, res2, next);
    res2.emit("finish");

    metrics.buildAndSendMetrics();
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);

    // Look for the new aggregated metric names
    const avgMetric = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "http.requests.latency.avg",
    );
    const maxMetric = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "http.requests.latency.max",
    );

    expect(avgMetric.gauge.dataPoints[0].asDouble).toBe(75); // (50 + 100) / 2
    expect(maxMetric.gauge.dataPoints[0].asDouble).toBe(100);
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

  test("trackUserActivity should count unique active users", () => {
    metrics.trackUserActivity(10);
    metrics.trackUserActivity(20);
    metrics.trackUserActivity(10); // This is a duplicate and should be ignored

    metrics.buildAndSendMetrics();

    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const activeUsersMetric =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "users.active",
      );

    expect(activeUsersMetric.gauge.dataPoints[0].asInt).toBe(2);
  });

  test("trackPizzaCreationLatency should record individual latencies", () => {
    metrics.trackPizzaCreationLatency(150);
    metrics.trackPizzaCreationLatency(250);

    metrics.buildAndSendMetrics();

    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);

    // Look for the new aggregated metric names
    const avgMetric = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "pizza.creation.latency.avg",
    );
    const maxMetric = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m) => m.name === "pizza.creation.latency.max",
    );

    expect(avgMetric.gauge.dataPoints[0].asDouble).toBe(200); // (150 + 250) / 2
    expect(maxMetric.gauge.dataPoints[0].asDouble).toBe(250);
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
