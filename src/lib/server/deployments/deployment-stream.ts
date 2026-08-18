// oxlint-disable func-style no-await-in-loop
export interface DeployEventPayload {
  type?: string;
  action?: string;
  service?: string;
  machine?: string;
  image?: string;
  containerId?: string;
  order?: string;
  id?: string;
  parentId?: string;
  phase?: string;
  status?: string;
  statusText?: string;
  current?: number;
  total?: number;
  percent?: number;
  error?: string;
  operations?: DeployEventPayload[];
}

export function formatDeployStreamEvent(
  eventName: string,
  payload: DeployEventPayload,
): { stream: "stdout" | "stderr"; message: string; isError: boolean } {
  if (eventName === "plan") {
    const operations = payload.operations ?? [];
    if (operations.length === 0) {
      return {
        isError: false,
        message: "Deploy plan received with no operations",
        stream: "stdout",
      };
    }

    const details = operations
      .map((operation) =>
        [
          operation.action ?? "unknown-action",
          operation.service ? `service=${operation.service}` : undefined,
          operation.machine ? `machine=${operation.machine}` : undefined,
          operation.image ? `image=${operation.image}` : undefined,
          operation.containerId ? `container=${operation.containerId}` : undefined,
          operation.order ? `order=${operation.order}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join(" | ");

    return {
      isError: false,
      message: `Plan: ${details}`,
      stream: "stdout",
    };
  }

  if (eventName === "progress") {
    const target = payload.id ?? "unknown-target";
    const parent = payload.parentId ? ` parent=${payload.parentId}` : "";
    const phase = payload.phase ?? "unknown";
    const statusText = payload.statusText ?? payload.status ?? "updated";
    const progressMeta = [
      typeof payload.percent === "number" ? `p=${payload.percent}` : undefined,
      typeof payload.current === "number" ? `c=${payload.current}` : undefined,
      typeof payload.total === "number" ? `t=${payload.total}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join("|");
    const metaSuffix = progressMeta.length > 0 ? `|${progressMeta}` : "";

    return {
      isError: false,
      message: `Progress: ${target}${parent} phase=${phase} status=${statusText}${metaSuffix}`,
      stream: "stdout",
    };
  }

  if (eventName === "complete") {
    const status = payload.status ?? "unknown";
    return {
      isError: false,
      message: `Deploy complete: ${status}`,
      stream: "stdout",
    };
  }

  if (eventName === "error") {
    return {
      isError: true,
      message: `Deploy error: ${payload.error ?? "unknown error"}`,
      stream: "stderr",
    };
  }

  return {
    isError: false,
    message: `Deploy event ${eventName}: ${JSON.stringify(payload)}`,
    stream: "stdout",
  };
}

export async function consumeDeployStream(
  response: Response,
  log: (stream: "stdout" | "stderr", message: string) => Promise<void>,
): Promise<void> {
  if (!response.body) {
    throw new Error("Deploy response did not include a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flushEvent = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const payloadText = dataLines.join("\n");
    let payload: DeployEventPayload;
    try {
      payload = JSON.parse(payloadText) as DeployEventPayload;
    } catch {
      await log("stderr", `Malformed deploy event payload: ${payloadText}`);
      eventName = "message";
      dataLines = [];
      return;
    }

    const formatted = formatDeployStreamEvent(eventName, payload);
    await log(formatted.stream, formatted.message);
    if (formatted.isError) {
      throw new TypeError(payload.error ?? "Deployment failed");
    }

    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length === 0) {
        await flushEvent();
        continue;
      }

      if (line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.length > 0 && buffer.startsWith("data:")) {
    dataLines.push(buffer.slice("data:".length).trim());
  }

  if (dataLines.length > 0) {
    await flushEvent();
  }
}
