import { describe, expect, it } from "vitest";
import type { SourceHandler } from "@agent-search/sources";
import { createAgentSearchToolSuite, defineAgentSearchConfig, defineSourcePlugin, registerAgentSearchTools } from "./index.js";

const companyDocsHandler: SourceHandler = {
  name: "company_docs",
  async fetch(subQuery) {
    return {
      source: "company_docs",
      ok: true,
      items: [
        {
          id: "company_docs:item",
          source: "company_docs",
          source_type: "other",
          url: "https://docs.example.com/research/source",
          title: "Company source",
          author: null,
          publish_date: null,
          text: `Company evidence about ${subQuery.sub_query}. This document contains enough detail to be selected as evidence.`,
          summary: null,
          metadata: {}
        }
      ],
      error: null,
      timing_ms: 2
    };
  }
};

const companyDocsPlugin = defineSourcePlugin({
  manifest: {
    id: "company_docs",
    version: "0.1.0",
    entrypoint: "./companyDocs.ts",
    sources: [{ id: "company_docs", label: "Company Docs", source_type: "other" }],
    env: [{ name: "COMPANY_DOCS_TOKEN", required: true }]
  },
  handlers: { company_docs: companyDocsHandler }
});

describe("agent search SDK", () => {
  it("exposes the full tool suite and runs a plugin-backed search", async () => {
    const suite = createAgentSearchToolSuite(
      defineAgentSearchConfig({
        sourcePlugins: [companyDocsPlugin],
        defaultRequest: { quality_mode: "fast", token_budget: 1200 },
        pipelineOptions: { enableExtraction: false, maxRepairRounds: 0 }
      })
    );

    expect(suite.tools.map((tool) => tool.name)).toEqual([
      "agent_search",
      "agent_search_evidence",
      "agent_search_trace",
      "agent_search_sources",
      "agent_search_source_health",
      "agent_search_cost",
      "agent_search_plugin_doctor"
    ]);

    const result = (await suite.tools[0]?.execute({ query: "what does company docs say?", sources: ["company_docs"] })) as any;

    expect(result.request_id).toBeTruthy();
    expect(result.evidence.some((item: any) => item.source_name === "company_docs")).toBe(true);
    expect(suite.store.get(result.request_id)?.trace.request_id).toBe(result.request_id);
  });

  it("registers tools into generic registries and reports plugin doctor state", async () => {
    const suite = createAgentSearchToolSuite({ sourcePlugins: [companyDocsPlugin] });
    const registry: { tools: any[] } = { tools: [] };

    registerAgentSearchTools(registry, suite);

    expect(registry.tools).toHaveLength(7);
    const doctor = (await registry.tools.find((tool) => tool.name === "agent_search_plugin_doctor")?.execute({})) as any;
    expect(doctor.ok).toBe(false);
    expect(doctor.missing_env[0]?.env).toBe("COMPANY_DOCS_TOKEN");
  });
});

