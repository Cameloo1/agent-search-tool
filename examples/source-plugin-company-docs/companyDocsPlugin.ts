import { defineSourcePlugin, type SourceHandler } from "@agent-search/sdk";

const companyDocsHandler: SourceHandler = {
  name: "company_docs",
  async fetch(subQuery) {
    const token = process.env.COMPANY_DOCS_TOKEN;
    if (!token) {
      return {
        source: "company_docs",
        ok: false,
        items: [],
        error: {
          code: "COMPANY_DOCS_TOKEN_MISSING",
          message: "COMPANY_DOCS_TOKEN is required for the company_docs source.",
          retryable: false,
          category: "missing_config"
        },
        timing_ms: 0
      };
    }

    return {
      source: "company_docs",
      ok: true,
      items: [
        {
          id: `company_docs:${encodeURIComponent(subQuery.sub_query).slice(0, 48)}`,
          source: "company_docs",
          source_type: "other",
          url: "https://docs.example.com/research",
          title: "Company research corpus result",
          author: null,
          publish_date: null,
          text: `Replace this with retrieved company evidence for: ${subQuery.sub_query}`,
          summary: null,
          metadata: { plugin_id: "company_docs" }
        }
      ],
      error: null,
      timing_ms: 1
    };
  }
};

export const companyDocsPlugin = defineSourcePlugin({
  manifest: {
    id: "company_docs",
    version: "0.1.0",
    entrypoint: "./companyDocsPlugin.ts",
    sources: [
      {
        id: "company_docs",
        label: "Company Docs",
        source_type: "other",
        description: "Trusted local/company research documents."
      }
    ],
    env: [{ name: "COMPANY_DOCS_TOKEN", required: true }],
    permissions: { network: ["docs.example.com"], filesystem: [] }
  },
  handlers: {
    company_docs: companyDocsHandler
  }
});
