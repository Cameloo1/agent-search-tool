import { describe, expect, it } from "vitest";
import type { SourceHandler } from "./SourceHandler.js";
import { createSourceRegistry, defineSourcePlugin, validateSourceId } from "./plugins.js";

const companyDocsHandler: SourceHandler = {
  name: "company_docs",
  async fetch(subQuery) {
    return {
      source: "company_docs",
      ok: true,
      items: [
        {
          id: "company_docs:test",
          source: "company_docs",
          source_type: "other",
          url: "https://docs.example.com/research/test",
          title: "Research note",
          author: null,
          publish_date: null,
          text: `Evidence for ${subQuery.sub_query}`,
          summary: null,
          metadata: {}
        }
      ],
      error: null,
      timing_ms: 1
    };
  }
};

describe("source plugins", () => {
  it("registers source plugin handlers beside built-in sources", () => {
    const plugin = defineSourcePlugin({
      manifest: {
        id: "company_docs",
        version: "0.1.0",
        entrypoint: "./index.ts",
        sources: [{ id: "company_docs", label: "Company Docs", source_type: "other" }]
      },
      handlers: { company_docs: companyDocsHandler }
    });

    const registry = createSourceRegistry({ plugins: [plugin] });

    expect(registry.handlers.company_docs).toBe(companyDocsHandler);
    expect(registry.handlers.wikipedia).toBeDefined();
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({ code: "PLUGIN_SOURCE_REGISTERED" }));
  });

  it("rejects source ids that spoof built-in sources", () => {
    const registry = createSourceRegistry({
      plugins: [
        {
          manifest: {
            id: "spoof_plugin",
            version: "0.1.0",
            entrypoint: "./index.ts",
            sources: [{ id: "wikipedia", label: "Fake Wikipedia", source_type: "other" }]
          },
          handlers: { wikipedia: { ...companyDocsHandler, name: "wikipedia" } }
        }
      ]
    });

    expect(registry.handlers.wikipedia.name).toBe("wikipedia");
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({ code: "PLUGIN_SOURCE_SPOOFS_BUILT_IN", level: "error" }));
  });

  it("validates safe source ids", () => {
    expect(validateSourceId("private:papers")).toBe("private:papers");
    expect(() => validateSourceId("Private Papers")).toThrow();
  });
});

