import { expect, it } from "vite-plus/test";
import { classifyLog, logActivity, logBucketIndex, selectedLogServices, type DisplayLog } from "./resource-logs";

it("preserves name-based log selections across replacement, disappearance and rediscovery", () => {
    const original = [{ id: "old-web", name: "web" }, { id: "worker", name: "worker" }];
    const selection = ["web"];
    expect(selectedLogServices(original, selection)).toEqual([original[0]]);
    expect(selectedLogServices([original[1]!], selection)).toEqual([]);
    const replacement = { id: "new-web", name: "web" };
    expect(selectedLogServices([replacement, original[1]!], selection)).toEqual([replacement]);
    expect(selectedLogServices(original, [])).toEqual([]);
    expect(selectedLogServices(original, ["unknown"])).toEqual([]);
    expect(selection).toEqual(["web"]);
    expect(original[0]?.id).toBe("old-web");

    const many = Array.from({ length: 25 }, (_, index) => ({ id: String(index), name: `service-${index}` }));
    expect(selectedLogServices(many, null)).toEqual(many.slice(0, 20));
    expect(selectedLogServices(many, ["service-24"])).toEqual([many[24]]);
});

it("classifies explicit levels and HTTP outcomes without inventing successes", () => {
    for (const message of [
        '{"level":"error"}',
        '{"level":50}',
        "[2026-09-20 12:10:00] ERROR: failed",
        "FATAL: failed",
        '{"res":{"statusCode":503}}',
    ])
        expect(classifyLog(message)).toBe("error");

    for (const message of ['{"level":40}', '{"severity":"WARNING"}', "WARN: low memory"])
        expect(classifyLog(message)).toBe("warning");

    for (const message of [
        '{"status":"success"}',
        '{"http":{"response":{"status_code":201}}}',
        "SUCCESS: connected",
    ])
        expect(classifyLog(message)).toBe("success");

    for (const message of [
        '{"level":"info"}',
        "server started",
        "0 errors detected",
        "GET / 302",
        '{"message":"error"}',
        "[stderr] hello",
        '{"statusCode":200.5}',
    ])
        expect(classifyLog(message)).toBe("other");
    expect(classifyLog('{"level":"error","statusCode":200}')).toBe("error");
    expect(classifyLog('{"level":"error","status":{},"http":"/health"}')).toBe("error");
    expect(classifyLog('{"level":"success","statusCode":500}')).toBe("error");
    expect(classifyLog("2026-09-20 17:52:27 14270 [Warning] Aborted connection")).toBe("warning");
    expect(classifyLog("2026-09-20 17:52:27 14270 [ERROR] Connection failed")).toBe("error");
    expect(classifyLog("Message contains [Warning] in its body")).toBe("other");
});

it("buckets loaded lines, including exact boundaries, and handles empty output", () => {
    const entries: DisplayLog[] = [0, 500, 1000, 24_000, 25_000].map((time, id) => ({
        id,
        time,
        level: id === 0 ? "error" : "success",
        timestamp: new Date(time).toISOString(),
        serviceId: "web",
        serviceName: "web",
        message: "ok",
        machine: null,
        container: null,
        stream: null,
    }));

    const result = logActivity(entries, 0, 24_000);
    expect(result.buckets[0]?.total).toBe(2);
    expect(result.buckets[1]?.total).toBe(1);
    expect(result.buckets[23]?.total).toBe(1);
    expect(result.counts).toEqual({ error: 1, warning: 0, success: 3, other: 0 });
    expect(result.maximum).toBe(2);
    expect(logActivity([], 0, 0).maximum).toBe(1);
});

it("uses the same fixed bucket boundaries for chart counts and selected logs", () => {
    const start = Date.parse("2026-09-21T08:00:00Z");
    const end = start + 24_000;

    const entries: DisplayLog[] = [-1, 0, 999, 1000, 1000, 1999, 23_000, 24_000, 24_001].map((offset, id) => ({
        id, time: start + offset, level: "other", timestamp: new Date(start + offset).toISOString(),
        serviceId: "web", serviceName: "web", message: "line", machine: null, container: null, stream: null,
    }));

    const activity = logActivity(entries, start, end);

    for (const [index, bucket] of activity.buckets.entries())
        expect(entries.filter((log) => logBucketIndex(log.time, start, end) === index)).toHaveLength(bucket.total);

    expect(logBucketIndex(start + 1000, start, end)).toBe(1);
    expect(logBucketIndex(end, start, end)).toBe(23);
    expect(logBucketIndex(end + 1, start, end)).toBe(-1);
    expect(logBucketIndex(Number.NaN, start, end)).toBe(-1);
    expect(logBucketIndex(start, start, start)).toBe(0);
    // New live output outside the captured domain cannot move the selected interval.
    expect(logBucketIndex(start + 1000, start, end + 24_000)).toBe(0);
    expect(logBucketIndex(start + 1000, start, end)).toBe(1);
});
