import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const factoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const schemaPath = resolve(
  factoryRoot,
  "schemas",
  "brief-capabilities.schema.json",
);

describe("brief-capabilities.schema.json — Ajv2020 compatibility (bug-106)", () => {
  it("declares a meta-schema that Ajv2020 can resolve", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $schema?: string;
    };
    expect(schema.$schema).toBeDefined();
    expect(schema.$schema).toMatch(/draft\/(2019-09|2020-12)\/schema$/);
  });

  it("compiles under Ajv2020 without throwing 'no schema with key or ref'", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  it("validates a canonical-shape brief-capabilities object", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const canonical = {
      version: "1.0",
      capabilities: [
        {
          id: "cap-12-column-rename",
          source: "brief.md#12",
          summary: "Users can rename a column inline",
          category: "core",
        },
        {
          id: "cap-11.4-help-route",
          source: "brief.md#11.4",
          summary: "/help route documenting keyboard shortcuts",
          category: "optional",
        },
      ],
    };
    const ok = validate(canonical);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects an unknown category enum value", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const bad = {
      version: "1.0",
      capabilities: [
        {
          id: "cap-12-foo",
          source: "brief.md#12",
          summary: "x",
          category: "must-have",
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects a malformed id (must match cap-{section}-{kebab-slug})", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const bad = {
      version: "1.0",
      capabilities: [
        {
          id: "12-foo",
          source: "brief.md#12",
          summary: "x",
          category: "core",
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });
});
