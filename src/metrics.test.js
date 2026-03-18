/* global describe, test, expect, jest, beforeEach */

// Mock dependencies that must be mocked before module load
jest.mock("os");
jest.mock("./config", () => ({
  metrics: {
    source: "test-service",
    endpointUrl: "http://test-grafana.com",
    accountId: "12345",
    apiKey: "test-key",
  },
}));
global.fetch = jest.fn();

describe("metrics.js", () => {
  let metrics;
  let os;

  beforeEach(() => {
    // Reset modules to clear internal state (counters) for each test
    jest.resetModules();

    // Re-require modules after reset
    metrics = require("./metrics");
    os = require("os");

    // Clear mocks
    jest.clearAllMocks();

    // Provide default mock implementations
    os.loadavg.mockReturnValue([0.5]);
    os.cpus.mockReturnValue(new Array(4));
    os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024);
    os.freemem.mockReturnValue(8 * 1024 * 1024 * 1024);
    global.fetch.mockResolvedValue({ ok: true });
  });

  test("requestTracker should increment endpoint counts", () => {
    const next = jest.fn();
    const req = { method: "GET", path: "/api/test" };

    metrics.requestTracker(req, {}, next);
    metrics.requestTracker(req, {}, next);

    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const httpMetrics =
      fetchBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "http.requests.count",
      );

    expect(httpMetrics).toBeDefined();
    expect(httpMetrics.sum.dataPoints[0].asInt).toBe(2);
    expect(
      httpMetrics.sum.dataPoints[0].attributes.find((a) => a.key === "endpoint")
        .value.stringValue,
    ).toBe("[GET] /api/test");
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("pizzaPurchase should collect success and failure metrics", () => {
    metrics.pizzaPurchase(true, 150, 25.5);
    metrics.pizzaPurchase(false, 200, 0);
    metrics.pizzaPurchase(false, 210, 0);

    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const sentMetrics = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics;

    const successCount = sentMetrics.find(
      (m) =>
        m.name === "purchase.count" &&
        m.sum.dataPoints[0].attributes.some(
          (a) => a.value.stringValue === "success",
        ),
    );
    const failureCount = sentMetrics.find(
      (m) =>
        m.name === "purchase.count" &&
        m.sum.dataPoints[0].attributes.some(
          (a) => a.value.stringValue === "failure",
        ),
    );
    const revenue = sentMetrics.find((m) => m.name === "purchase.revenue");
    const latency = sentMetrics.find((m) => m.name === "purchase.latency");

    expect(successCount.sum.dataPoints[0].asInt).toBe(1);
    expect(failureCount.sum.dataPoints[0].asInt).toBe(2);
    expect(revenue.sum.dataPoints[0].asDouble).toBe(25.5);
    expect(latency.gauge.dataPoints[0].asDouble).toBe(186.67);
  });

  test("auth metrics should be collected and reset", () => {
    metrics.userRegistered();
    metrics.userLoggedIn(true);
    metrics.userLoggedIn(false);
    metrics.userLoggedOut();

    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const sentMetrics = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics;

    expect(
      sentMetrics.find((m) => m.name === "user.registrations").sum.dataPoints[0]
        .asInt,
    ).toBe(1);
    expect(
      sentMetrics.find((m) => m.name === "auth.logouts").sum.dataPoints[0]
        .asInt,
    ).toBe(1);

    // Call again and ensure resettable counters are gone
    global.fetch.mockClear();
    metrics.buildAndSendMetrics();
    // After being reset, there should be no new metrics to send.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("system metrics should be calculated correctly", () => {
    os.loadavg.mockReturnValue([0.5]);
    os.cpus.mockReturnValue(new Array(4)); // 0.5 / 4 = 0.125 -> 12.5%
    os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    os.freemem.mockReturnValue(12 * 1024 * 1024 * 1024); // 12 GB free -> 4 GB used -> 25%

    // Add a single event to ensure metrics are sent
    metrics.greetingChanged();

    metrics.buildAndSendMetrics();

    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const sentMetrics = fetchBody.resourceMetrics[0].scopeMetrics[0].metrics;

    const cpu = sentMetrics.find((m) => m.name === "system.cpu.utilization");
    const memory = sentMetrics.find(
      (m) => m.name === "system.memory.utilization",
    );

    expect(cpu.gauge.dataPoints[0].asDouble).toBe(12.5);
    expect(memory.gauge.dataPoints[0].asDouble).toBe(25);
  });

  test("cumulative counters (greeting, requests) should not be reset", () => {
    metrics.greetingChanged();
    metrics.buildAndSendMetrics();

    metrics.greetingChanged();
    metrics.buildAndSendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const firstCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const secondCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);

    const firstGreeting =
      firstCallBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "greeting.change.count",
      );
    const secondGreeting =
      secondCallBody.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m) => m.name === "greeting.change.count",
      );

    expect(firstGreeting.sum.dataPoints[0].asInt).toBe(1);
    expect(secondGreeting.sum.dataPoints[0].asInt).toBe(2);
  });

  test("sendMetricToGrafana should handle fetch errors", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    global.fetch.mockRejectedValue(new Error("Network failure"));

    metrics.pizzaPurchase(true, 100, 10);
    metrics.buildAndSendMetrics();

    await new Promise(process.nextTick);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Error pushing metrics:",
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  test("should not send metrics if only cumulative counters are zero", () => {
    metrics.buildAndSendMetrics();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
