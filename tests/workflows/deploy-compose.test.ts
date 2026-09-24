import { ucClient } from "@stoat/uncloud";
import { expect, it } from "vite-plus/test";
import { deployCompose } from "../../packages/workflows/src/deploy-compose";

it("keeps diagnostics while masking merged, list, multiline, URL and overlapping credentials", async () => {
    const secrets = [
        "merge-secret",
        "list-secret",
        "line one\nline two",
        "url%20password",
        "url password",
        "short",
        "short-long",
        "x",
        "inline-secret",
    ];

    const diagnostic = `Image pull failed: ${secrets.join("; ")}. Registry denied access.`;

    const uc = ucClient("http://sidecar.test", {
        fetch: async () =>
            new Response(
                `data: ${JSON.stringify({ type: "error", error: `\u001b[31m${diagnostic}\u001b[0m` })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
    });

    const logs: string[] = [];

    const compose = `
x-env: &env
  PASSWORD: merge-secret
  CERT: |-
    line one
    line two
services:
  web:
    image: nginx
    environment:
      <<: *env
      URL: postgres://user:url%20password@db/database
    build:
      args:
        TOKEN: short-long
  db:
    image: postgres
    environment: [TOKEN=list-secret, SMALL=x, PASS=short]
secrets:
  key:
    content: inline-secret
`;

    const expected = `Image pull failed: ${secrets.map(() => "[REDACTED]").join("; ")}. Registry denied access.`;

    await expect(
        deployCompose(uc, compose, new AbortController().signal, async (text) => {
            logs.push(text);
        }),
    ).rejects.toThrow(expected);
    expect(logs).toEqual([expected]);
});
