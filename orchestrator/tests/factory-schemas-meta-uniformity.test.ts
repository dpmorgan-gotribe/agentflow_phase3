import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const factoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const schemasDir = resolve(factoryRoot, "schemas");
const schemaFiles = readdirSync(schemasDir).filter((f) =>
  f.endsWith(".schema.json"),
);

describe("factory schemas — meta-schema uniformity (refactor-009)", () => {
  it("ships at least 10 schemas (sentinel against a silent prune)", () => {
    expect(schemaFiles.length).toBeGreaterThanOrEqual(10);
  });

  describe.each(schemaFiles)("%s", (schemaFile) => {
    const schemaPath = join(schemasDir, schemaFile);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $schema?: string;
    };

    it("declares draft-2019-09 or draft-2020-12 as its meta-schema", () => {
      expect(schema.$schema).toBeDefined();
      expect(schema.$schema).toMatch(/draft\/(2019-09|2020-12)\/schema$/);
    });

    it("compiles under Ajv2020 without throwing", () => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      // Some factory schemas use $ref to siblings (e.g. tasks.schema.json
      // references feature.schema.json). Register every sibling so $ref
      // resolution doesn't crash mid-compile.
      for (const sibling of schemaFiles) {
        if (sibling === schemaFile) continue;
        const siblingSchema = JSON.parse(
          readFileSync(join(schemasDir, sibling), "utf8"),
        );
        try {
          ajv.addSchema(siblingSchema, `./${sibling}`);
        } catch {
          // Sibling already registered or has a conflicting $id — fine for
          // this assertion; we only care that the target compiles.
        }
      }
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  });
});
