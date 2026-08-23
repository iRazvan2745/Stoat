import { setImmediate as waitImmediate } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { consumeSseJsonStream } from "#lib/server/shared/sse";
import {
  composeServiceName,
  filterContainerLogs,
  insertLogSorted,
  parseContainerLogEvent,
  resolveContainerLabel,
  trimContainerLogs,
} from "#lib/service/container-logs";
import type { ContainerLogRecord } from "#lib/service/container-logs";

const log = (
  partial: Partial<ContainerLogRecord> & Pick<ContainerLogRecord, "id" | "timestamp">,
): ContainerLogRecord => ({
  containerId: "abc",
  containerLabel: "nginx",
  machineName: "node-1",
  message: "hello",
  stream: "stdout",
  ...partial,
});

describe("composeServiceName", () => {
  it("strips the stoat service slug prefix", () => {
    expect(composeServiceName("nginx-f7gzq-nginx", "nginx-f7gzq")).toBe("nginx");
  });

  it("returns the uncloud name when prefixing is off", () => {
    expect(composeServiceName("nginx")).toBe("nginx");
  });
});

describe("resolveContainerLabel", () => {
  it("uses the compose service name when it is unique", () => {
    const container = {
      id: "aaaaaaaaaaaa",
      machineName: "node-1",
      name: "nginx-f7gzq-nginx",
      serviceName: "nginx-f7gzq-nginx",
      shortId: "aaaaaaaaaaaa",
    };

    expect(resolveContainerLabel(container, [container], "nginx-f7gzq")).toBe("nginx");
  });

  it("disambiguates replicas with the machine name", () => {
    const web1 = {
      id: "aaaaaaaaaaaa",
      machineName: "node-1",
      name: "app-web-1",
      serviceName: "app-abc12-web",
      shortId: "aaaaaaaaaaaa",
    };
    const web2 = {
      id: "bbbbbbbbbbbb",
      machineName: "node-2",
      name: "app-web-2",
      serviceName: "app-abc12-web",
      shortId: "bbbbbbbbbbbb",
    };

    expect(resolveContainerLabel(web1, [web1, web2], "app-abc12")).toBe("web@node-1");
    expect(resolveContainerLabel(web2, [web1, web2], "app-abc12")).toBe("web@node-2");
  });
});

describe("parseContainerLogEvent", () => {
  it("parses a stdout log event", () => {
    expect(
      parseContainerLogEvent({
        message: "ready",
        metadata: {
          containerId: "abc123",
          machineName: "node-1",
          serviceName: "web",
        },
        stream: "stdout",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      containerId: "abc123",
      machineName: "node-1",
      message: "ready",
      serviceName: "web",
      stream: "stdout",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("skips heartbeat events", () => {
    expect(
      parseContainerLogEvent({
        stream: "heartbeat",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("uses the error field when message is missing", () => {
    expect(
      parseContainerLogEvent({
        error: "container died",
        stream: "unknown",
      }),
    ).toMatchObject({
      message: "container died",
      stream: "stdout",
    });
  });
});

describe("filterContainerLogs", () => {
  const logs = [
    log({ containerId: "web", id: 1, timestamp: "1" }),
    log({ containerId: "db", id: 2, timestamp: "2" }),
  ];

  it("returns every log when no containers are selected", () => {
    expect(filterContainerLogs(logs, [])).toEqual(logs);
  });

  it("returns only selected containers", () => {
    expect(filterContainerLogs(logs, ["db"])).toEqual([logs[1]]);
  });
});

describe("insertLogSorted", () => {
  it("inserts out-of-order historical lines by timestamp", () => {
    const logs: ContainerLogRecord[] = [];

    insertLogSorted(logs, log({ id: 2, message: "second", timestamp: "2" }));
    insertLogSorted(logs, log({ id: 1, message: "first", timestamp: "1" }));
    insertLogSorted(logs, log({ id: 3, message: "third", timestamp: "3" }));

    expect(logs.map((entry) => entry.message)).toEqual(["first", "second", "third"]);
  });
});

describe("trimContainerLogs", () => {
  it("keeps the newest lines", () => {
    const logs = [
      log({ id: 1, timestamp: "1" }),
      log({ id: 2, timestamp: "2" }),
      log({ id: 3, timestamp: "3" }),
    ];

    trimContainerLogs(logs, 2);

    expect(logs.map((entry) => entry.id)).toEqual([2, 3]);
  });
});

describe("consumeSseJsonStream", () => {
  it("parses named events and ignores comments", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `: ping\n\nevent: log\ndata: {"message":"hello","stream":"stdout"}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const events: { eventName: string; payload: unknown }[] = [];

    await consumeSseJsonStream(body, (eventName, payload) => {
      events.push({ eventName, payload });
      return Promise.resolve();
    });

    expect(events).toEqual([
      {
        eventName: "log",
        payload: { message: "hello", stream: "stdout" },
      },
    ]);
  });

  it("resolves without unhandled rejections when aborted", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("This operation was aborted", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(abortError);
      },
      start() {
        // Keep the stream open until abort cancels it.
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      const consume = consumeSseJsonStream(body, () => Promise.resolve(), controller.signal);

      controller.abort();
      await consume;
      await waitImmediate();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
