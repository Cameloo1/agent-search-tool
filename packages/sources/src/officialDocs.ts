import type { NormalizedSourceType, RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchText, itemId, safeSourceFetch, stripHtml } from "./utils/http.js";

type OfficialDoc = {
  id: string;
  title: string;
  url: string;
  author: string;
  source_type: NormalizedSourceType;
  tags: string[];
  summary: string;
  published?: string;
};

const OFFICIAL_DOCS: OfficialDoc[] = [
  {
    id: "sec-market-structure",
    title: "SEC Market Structure",
    url: "https://www.sec.gov/market-structure",
    author: "U.S. Securities and Exchange Commission",
    source_type: "government",
    tags: ["sec", "market structure", "direct feeds", "co-location", "exchange data", "trading", "latency"],
    summary:
      "SEC market-structure material is a primary source for U.S. equity market plumbing, including exchanges, market data, order routing, trading centers, and low-latency infrastructure context."
  },
  {
    id: "sec-edgar-access",
    title: "SEC EDGAR Access Guidance",
    url: "https://www.sec.gov/os/accessing-edgar-data",
    author: "U.S. Securities and Exchange Commission",
    source_type: "government",
    tags: ["sec", "edgar", "filings", "fair access", "rate limits", "10 requests per second", "disclosures"],
    summary:
      "SEC EDGAR access guidance explains programmatic access expectations and fair-access limits for public company filings and disclosure feeds."
  },
  {
    id: "fed-fomc-calendar",
    title: "Federal Reserve FOMC Calendars",
    url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    author: "Board of Governors of the Federal Reserve System",
    source_type: "government",
    tags: ["fomc", "federal reserve", "macro releases", "scheduled events", "rates", "trading"],
    summary:
      "The Federal Reserve publishes scheduled FOMC calendars and policy materials that institutions prepare for before market-moving macro events."
  },
  {
    id: "bls-cpi",
    title: "BLS Consumer Price Index",
    url: "https://www.bls.gov/cpi/",
    author: "U.S. Bureau of Labor Statistics",
    source_type: "government",
    tags: ["cpi", "inflation", "macro release", "scheduled releases", "prices", "economy"],
    summary:
      "BLS CPI is a primary scheduled macro release used to track inflation surprises, expectations, rates, and market reactions."
  },
  {
    id: "treasury-fiscal-data",
    title: "Treasury Fiscal Data",
    url: "https://fiscaldata.treasury.gov/",
    author: "U.S. Department of the Treasury",
    source_type: "government",
    tags: ["treasury", "debt", "interest costs", "fiscal data", "auctions", "government finance"],
    summary:
      "Treasury Fiscal Data is a primary public-data portal for U.S. debt, interest costs, fiscal flows, and Treasury auction datasets."
  },
  {
    id: "cbo-long-term-budget",
    title: "CBO Long-Term Budget Outlook",
    url: "https://www.cbo.gov/topics/budget/long-term-budget",
    author: "Congressional Budget Office",
    source_type: "government",
    tags: ["cbo", "debt", "deficits", "interest costs", "fiscal capacity", "budget projections"],
    summary:
      "CBO long-term budget projections are primary high-authority evidence for deficits, debt, interest costs, and fiscal-capacity pressure."
  },
  {
    id: "eia-steo",
    title: "EIA Short-Term Energy Outlook",
    url: "https://www.eia.gov/outlooks/steo/",
    author: "U.S. Energy Information Administration",
    source_type: "government",
    tags: ["eia", "oil", "crude", "brent", "wti", "petroleum", "forecast", "prices", "supply", "demand"],
    summary:
      "EIA STEO is an official forecast source for oil prices, petroleum supply and demand, inventories, consumption, production, and energy-market outlooks."
  },
  {
    id: "eia-open-data",
    title: "EIA Open Data",
    url: "https://www.eia.gov/opendata/",
    author: "U.S. Energy Information Administration",
    source_type: "government",
    tags: ["eia", "oil", "energy data", "api", "petroleum", "gasoline", "prices", "inventory"],
    summary:
      "EIA Open Data documents public access to energy datasets and APIs for petroleum, crude oil, electricity, natural gas, forecasts, and prices."
  },
  {
    id: "owasp-top-ten",
    title: "OWASP Top 10",
    url: "https://owasp.org/www-project-top-ten/",
    author: "OWASP Foundation",
    source_type: "other",
    tags: ["owasp", "appsec", "web security", "access control", "injection", "misconfiguration", "vulnerabilities"],
    summary:
      "OWASP Top 10 is a high-authority application-security reference for recurring web-application risks such as broken access control, injection, and misconfiguration."
  },
  {
    id: "owasp-asvs",
    title: "OWASP Application Security Verification Standard",
    url: "https://owasp.org/www-project-application-security-verification-standard/",
    author: "OWASP Foundation",
    source_type: "other",
    tags: ["owasp", "asvs", "appsec", "verification", "testing", "auth", "session", "authorization"],
    summary:
      "OWASP ASVS is a verification standard for application-security controls, useful for converting LLM-assisted review into concrete release gates."
  },
  {
    id: "nist-ssdf",
    title: "NIST Secure Software Development Framework SP 800-218",
    url: "https://csrc.nist.gov/pubs/sp/800/218/final",
    author: "National Institute of Standards and Technology",
    source_type: "government",
    tags: ["nist", "ssdf", "secure software", "sdlc", "pre-production", "security testing"],
    summary:
      "NIST SSDF frames secure software development as repeatable SDLC practices rather than a single final security scan."
  },
  {
    id: "cisa-secure-by-design",
    title: "CISA Secure by Design",
    url: "https://www.cisa.gov/securebydesign",
    author: "Cybersecurity and Infrastructure Security Agency",
    source_type: "government",
    tags: ["cisa", "secure by design", "software security", "appsec", "release gates", "security defaults"],
    summary:
      "CISA Secure by Design guidance emphasizes building security into product design, defaults, testing, and development practices."
  },
  {
    id: "nasdaq-totalview",
    title: "Nasdaq TotalView Market Data",
    url: "https://www.nasdaqtrader.com/Trader.aspx?id=TotalView2",
    author: "Nasdaq",
    source_type: "other",
    tags: ["nasdaq", "direct feed", "market data", "order book", "trading", "latency", "exchange"],
    summary:
      "Nasdaq TotalView documentation is an exchange-side reference for direct market data depth feeds used by professional market participants."
  },
  {
    id: "cme-market-data-platform",
    title: "CME Market Data Platform",
    url: "https://www.cmegroup.com/market-data/real-time/market-data-platform.html",
    author: "CME Group",
    source_type: "other",
    tags: ["cme", "market data", "direct feed", "futures", "latency", "exchange"],
    summary:
      "CME Market Data Platform documentation describes real-time exchange market data delivery for derivatives and futures markets."
  },
  {
    id: "huggingface-minilm",
    title: "all-MiniLM-L6-v2 model card",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
    author: "Hugging Face and sentence-transformers",
    source_type: "code",
    tags: ["embeddings", "miniLM", "semantic similarity", "sentence transformers", "deduplication", "vectors"],
    summary:
      "The all-MiniLM-L6-v2 model card documents a lightweight sentence-transformer embedding model commonly used for semantic similarity and clustering."
  }
];

export const officialDocsHandler: SourceHandler = {
  name: "official_docs",
  async fetch(subQuery, options) {
    return safeSourceFetch("official_docs", async () => {
      const ranked = rankDocs(subQuery.sub_query);
      const selected = clampResults(ranked, options.maxResults);
      const items: RawItem[] = [];
      for (const doc of selected) {
        const fetched = await fetchDocText(doc, options.timeoutMs, options.signal).catch(() => "");
        items.push({
          id: itemId("official_docs", doc.id),
          source: "official_docs",
          source_type: doc.source_type,
          url: doc.url,
          title: doc.title,
          author: doc.author,
          publish_date: doc.published ? new Date(doc.published).toISOString() : null,
          text: [doc.title, doc.summary, fetched].filter(Boolean).join("\n\n"),
          summary: doc.summary,
          metadata: { official_doc_id: doc.id, tags: doc.tags }
        });
      }
      return items;
    });
  }
};

function rankDocs(query: string): OfficialDoc[] {
  const queryTerms = terms(query);
  const scored = OFFICIAL_DOCS.map((doc) => ({
    doc,
    score:
      overlapScore(queryTerms, terms(`${doc.title} ${doc.summary} ${doc.tags.join(" ")}`)) +
      directPhraseBoost(query.toLowerCase(), doc.tags)
  })).sort((a, b) => b.score - a.score);
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length ? positive : scored).map((item) => item.doc);
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
}

function overlapScore(queryTerms: Set<string>, docTerms: Set<string>): number {
  if (!queryTerms.size) return 0;
  let hits = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) hits += 1;
  }
  return hits / queryTerms.size;
}

function directPhraseBoost(query: string, tags: string[]): number {
  return tags.reduce((sum, tag) => (query.includes(tag.toLowerCase()) ? sum + 0.35 : sum), 0);
}

async function fetchDocText(doc: OfficialDoc, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const body = await fetchText(doc.url, Math.min(timeoutMs, 3500), {
    headers: { Accept: "text/html, text/plain;q=0.8" },
    signal
  });
  return stripHtml(body).slice(0, 3_000);
}
