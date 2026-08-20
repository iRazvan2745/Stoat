// oxlint-disable no-await-in-loop
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  listTemplates,
  readTemplateIconValue,
  readTemplateLogo,
  readTemplateVersion,
} from "#lib/server/templates";
import {
  ensureSvgNamespace,
  expandTemplateSecrets,
  expandTemplateVariables,
  svglIconUrl,
} from "#lib/templates";

const writeTemplate = async (
  root: string,
  appId: string,
  options: {
    compose?: string;
    description?: string;
    env?: string;
    icon?: string;
    logo?: boolean;
    name?: string;
    tags?: string[];
    type?: string;
    versions?: string[];
  },
): Promise<void> => {
  const appPath = path.join(root, appId);
  await mkdir(appPath, { recursive: true });
  await writeFile(
    path.join(appPath, "manifest.json"),
    JSON.stringify({
      description: options.description ?? "A database",
      icon: options.icon,
      name: options.name ?? "PostgreSQL",
      tags: options.tags,
      type: options.type ?? "postgresql",
    }),
  );

  if (options.logo !== false) {
    await writeFile(
      path.join(appPath, "logo.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    );
  }

  for (const version of options.versions ?? ["18"]) {
    const versionPath = path.join(appPath, "versions", version);
    await mkdir(versionPath, { recursive: true });
    await writeFile(
      path.join(versionPath, "compose.yaml"),
      options.compose ?? "services:\n  postgres:\n    image: postgres:18\n",
    );
    await writeFile(
      path.join(versionPath, ".env"),
      options.env ?? "POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=postgres\nPOSTGRES_DB=app\n",
    );
  }
};

describe("listTemplates", () => {
  it("reads the project postgresql template", async () => {
    const templates = await listTemplates();
    const postgres = templates.find((template) => template.appId === "postgresql");

    expect(postgres).toMatchObject({
      description: "Relational database for apps that need durable SQL storage.",
      name: "PostgreSQL",
      tags: ["database"],
      type: "postgresql",
    });
    expect(postgres?.versions.map((version) => version.version)).toContain("18");
    expect(postgres?.logoSrc).toBe("/templates/postgresql/logo");
  });

  it("skips invalid apps and sorts versions newest first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-templates-"));

    try {
      await writeTemplate(root, "postgresql", { versions: ["18", "16"] });
      await mkdir(path.join(root, "broken"), { recursive: true });
      await writeFile(path.join(root, "broken", "manifest.json"), "{not json");
      await writeTemplate(root, "empty", { versions: [] });
      await mkdir(path.join(root, "empty", "versions"), {
        recursive: true,
      });

      const templates = await listTemplates(root);

      expect(templates.map((template) => template.appId)).toEqual(["postgresql"]);
      expect(templates[0]?.versions.map((version) => version.version)).toEqual(["18", "16"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to an svgl icon URL when no local logo is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-templates-"));

    try {
      await writeTemplate(root, "redis", {
        icon: "redis",
        logo: false,
        name: "Redis",
        tags: ["database", "cache"],
        type: "compose",
      });

      const templates = await listTemplates(root);

      expect(templates).toEqual([
        expect.objectContaining({
          appId: "redis",
          logoSrc: svglIconUrl("redis"),
          name: "Redis",
          tags: ["database", "cache"],
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("readTemplateVersion", () => {
  it("loads compose, manifest, and env variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-templates-"));

    try {
      await writeTemplate(root, "postgresql", {
        compose: "services:\n  postgres:\n    image: postgres:18\n",
        env: "POSTGRES_DB=app\nPOSTGRES_PASSWORD=s3cret\n",
      });

      const version = await readTemplateVersion("postgresql", "18", root);

      expect(version.manifest).toMatchObject({
        description: "A database",
        name: "PostgreSQL",
        tags: [],
        type: "postgresql",
      });
      expect(version.compose).toContain("image: postgres:18");
      expect(version.variables).toEqual([
        { name: "POSTGRES_DB", value: "app" },
        { name: "POSTGRES_PASSWORD", value: "s3cret" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects path-like template ids", async () => {
    await expect(readTemplateVersion("../etc", "18")).rejects.toThrow("Invalid template");
  });

  it("keeps secret placeholders until the service is created", async () => {
    const version = await readTemplateVersion("postgresql", "18");
    const password = version.variables.find((variable) => variable.name === "POSTGRES_PASSWORD");

    expect(password?.value).toBe("{{ UUID }}");
  });
});

describe("svglIconUrl", () => {
  it("builds the SVGL API URL and strips a trailing .svg", () => {
    expect(svglIconUrl("postgresql")).toBe("https://api.svgl.app/svg/postgresql.svg");
    expect(svglIconUrl("postgresql.svg")).toBe("https://api.svgl.app/svg/postgresql.svg");
  });
});

describe("ensureSvgNamespace", () => {
  it("adds xmlns so SVG files can render in img tags", () => {
    expect(ensureSvgNamespace('<svg xml:space="preserve" viewBox="0 0 1 1"></svg>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 1 1"></svg>',
    );
    expect(ensureSvgNamespace('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
  });
});

describe("readTemplateIconValue", () => {
  it("stores the postgresql logo as a base64 data URI", async () => {
    const icon = await readTemplateIconValue("postgresql");
    const prefix = "data:image/svg+xml;base64,";

    expect(icon?.startsWith(prefix)).toBe(true);

    const encoded = icon?.slice(prefix.length) ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it("falls back to an svgl URL when no local logo is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stoat-templates-"));

    try {
      await writeTemplate(root, "redis", {
        icon: "redis",
        logo: false,
        name: "Redis",
        type: "compose",
      });

      await expect(readTemplateIconValue("redis", "redis", root)).resolves.toBe(
        svglIconUrl("redis"),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("readTemplateLogo", () => {
  it("serves the postgresql logo as namespaced SVG", async () => {
    const logo = await readTemplateLogo("postgresql");

    expect(logo?.contentType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(logo?.body)).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});

describe("expandTemplateSecrets", () => {
  it("replaces UUID placeholders with unique UUIDs", () => {
    const expanded = expandTemplateSecrets("id={{ UUID }} other={{uuid}}");
    const uuids = expanded.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu);

    expect(expanded).not.toContain("{{");
    expect(uuids).toHaveLength(2);
    expect(uuids?.[0]).not.toBe(uuids?.[1]);
  });

  it("replaces {{ 32 }} with a 32-character base64 string", () => {
    const expanded = expandTemplateSecrets("secret={{ 32 }}");
    const secret = expanded.slice("secret=".length);

    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Za-z0-9+/]+$/u);
  });

  it("leaves unknown placeholders alone and rejects invalid lengths", () => {
    expect(expandTemplateSecrets("keep={{ FOO }}")).toBe("keep={{ FOO }}");
    expect(() => expandTemplateSecrets("{{ 0 }}")).toThrow("length must be between");
    expect(() => expandTemplateSecrets("{{ 257 }}")).toThrow("length must be between");
  });
});

describe("expandTemplateVariables", () => {
  it("expands placeholders in values only", () => {
    const variables = expandTemplateVariables([
      { name: "POSTGRES_PASSWORD", value: "{{ 32 }}" },
      { name: "POSTGRES_USER", value: "postgres" },
    ]);

    expect(variables[0]?.name).toBe("POSTGRES_PASSWORD");
    expect(variables[0]?.value).toHaveLength(32);
    expect(variables[0]?.value).toMatch(/^[A-Za-z0-9+/]+$/u);
    expect(variables[1]).toEqual({
      name: "POSTGRES_USER",
      value: "postgres",
    });
  });
});
