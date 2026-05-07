# Scoring Mechanism and Pipeline Math

This document explains how Agent Search scores evidence, selects final chunks, and decides whether an answer is safe to synthesize. The goal is not to make an LLM "feel confident." The goal is to keep every answer tied to source-aware, inspectable, repeatable evidence decisions.

The scoring stack is layered:

```text
raw source items
  -> canonical extraction metadata
  -> normalized chunks
  -> deterministic pre-rank
  -> structured chunk scoring
  -> extraction confidence ceilings
  -> reliability adjustment
  -> duplicate clustering
  -> budgeted final assembly
  -> evidence health
  -> gap analysis and repair
  -> cited synthesis and review
```

The implementation lives primarily in:

- `packages/core/src/stage5_5Prerank.ts`
- `packages/core/src/stage6Score.ts`
- `packages/core/src/reliabilityStore.ts`
- `packages/core/src/stage7Dedup.ts`
- `packages/core/src/stage8Assemble.ts`
- `packages/core/src/evidenceHealth.ts`
- `packages/core/src/gapAnalysis.ts`

## Score Types

Agent Search keeps several scores separate instead of collapsing everything into one opaque number.

| Score | Range | Meaning |
|---|---:|---|
| `local_score` | 0 to 1 | Fast deterministic pre-rank score before LLM scoring. |
| `relevance_to_query` | 0 to 1 | Whether the chunk directly helps answer the user query. |
| `source_weight` | 0 to 1 | Prior authority of source name/source type, later reliability-adjusted. |
| `confidence_score` | 0 to 1 | Claim support confidence for the chunk. |
| `freshness_fitness` | 0 to 1 | Fit between publication age and query needs. |
| `surprise_score` | 0 to 1 | Whether a chunk adds non-obvious or differentiating evidence. |
| `combined_score` | 0 to 1 | Stage 6 filtering score. |
| `marginal_gain` | unbounded small real | Final assembly utility under token budget. |
| `evidence_quality_score` | 0 to 100 | Overall trust/readiness for synthesis. |
| `evidence_coverage_score` | 0 to 100 | Breadth and non-redundant answer coverage. |

## Source Weights

Built-in source names and source types have authority priors. The effective source weight is:

```text
source_weight = max(source_name_weight, source_type_weight)
```

Examples:

| Source | Weight |
|---|---:|
| SEC EDGAR | 0.98 |
| Data.gov | 0.95 |
| PubMed | 0.93 |
| Official docs | 0.92 |
| arXiv | 0.88 |
| Semantic Scholar | 0.86 |
| GitHub | 0.74 |
| Wikipedia | 0.72 |
| Stack Exchange | 0.58 |
| Hacker News | 0.42 |

Examples by source type:

| Source type | Weight |
|---|---:|
| filing | 0.98 |
| government | 0.95 |
| medical | 0.93 |
| academic | 0.87 |
| structured fact | 0.86 |
| code | 0.74 |
| encyclopedic | 0.72 |
| forum | 0.55 |
| technical discussion | 0.42 |
| other | 0.35 |

These priors are not final proof. They help route attention before later scoring, deduplication, evidence health, and review.

## Stage 5.5: Deterministic Pre-Rank

Pre-rank keeps Stage 6 from scoring every normalized chunk. In balanced mode, the default LLM candidate cap is 12. This is a speed and quality guardrail: the system should score the best diverse candidates, not the largest pile of snippets.

Each normalized chunk receives:

```text
local_score = clamp01(
  (
    lexical * 0.46
    + source_weight * 0.24
    + freshness * 0.10
    + title_boost
    + phrase_boost
    + primary_boost
    + query_type_boost
    + required_match_boost
  )
  * bad_context_penalty
)
```

Where:

- `lexical = query_term_hits / denominator`
- `denominator = max(4, min(14, query_term_count or 4))`
- `title_boost = min(0.12, title_hit_count * 0.03)`
- `phrase_boost = min(0.10, matching_query_bigram_count * 0.035)`
- `primary_boost = 0.06` for primary-like source types such as filing, government, structured fact, or primary-source stance
- `required_match_boost = 0.10` if the chunk matches an intent-required source type
- `bad_context_penalty = 0.45` for boilerplate like author pages, privacy pages, copyright pages, or terms pages

Freshness is bucketed:

| Age | Freshness |
|---|---:|
| <= 1 year | 1.00 |
| <= 3 years | 0.78 |
| <= 8 years | 0.60 |
| older or undated fallback | 0.45 to 0.55 |

Query-type boosts are capped at 0.12 total:

- fresh-fact queries reward freshness fitness.
- source-attribution queries reward primary-source stance.
- academic queries reward academic chunks.
- adversarial queries reward government, filing, and medical evidence.
- dedup-prone queries reward surprise score.

Pre-rank also removes exact/canonical duplicates before LLM scoring. Duplicate keys prefer canonical URL, then title plus content fingerprint, then content fingerprint.

Candidate selection is diversity-aware:

1. Reserve slots for required source types first.
2. Fill remaining slots by adjusted local score.
3. Penalize repeated source names by `0.82`.
4. Penalize repeated source types by `0.90`.
5. Add a small boost for still-uncovered required source types.

## Stage 6: Chunk Scoring

Stage 6 asks a structured model to score each candidate chunk. The required structured fields are:

- `chunk_id`
- `relevance_to_query`
- `confidence_score`
- `freshness_fitness`
- `surprise_score`
- `claim_graph`
- `epistemic_stance`
- `summary`

If the model fails schema validation, omits chunk ids, times out, or returns unusable output, deterministic fallback scoring fills the missing values. Fallback is a safety path, not the preferred path.

The Stage 6 filter is:

```text
combined_score =
  relevance_to_query
  * source_weight
  * confidence_score
  * max(0.4, freshness_fitness)
```

Default threshold:

```text
combined_score >= 0.20
```

The freshness term is floored at `0.4` so older but authoritative evidence can still survive when the question is not truly time-sensitive.

## Contextual Relevance Guards

Stage 6 includes domain guards that cap relevance when a chunk is keyword-adjacent but not answer-relevant. For example:

- boilerplate author/copyright/terms pages can be capped near zero
- oil questions require oil/forecast/supply-demand signals
- retrieval architecture questions require deduplication, submodular, Bayesian, similarity, retrieval, or claim signals
- market/news-speed questions require trading, filing, market-data, macro-release, or compliance signals

This prevents a high-authority but wrong-context page from dominating because it shares a few terms.

## Extraction Confidence Ceilings

Extraction quality can cap confidence. This is what prevents metadata-only or snippet-only evidence from supporting detailed claims.

| Extraction status | Confidence ceiling | Treatment |
|---|---:|---|
| `full_text` | 1.00 | normal scoring |
| `section_text` | 1.00 | normal scoring |
| `structured_abstract` | 0.55 | summary-level support only |
| `snippet` | 0.35 | weak evidence |
| `metadata_only` | 0.15 | existence only, not detailed support |
| `failed` | 0.08 | visible failure, not support |

For `metadata_only` and `failed`, Agent Search also:

```text
relevance_to_query = min(relevance_to_query, 0.12)
claim_graph = []
epistemic_stance = "speculation"
```

## Stage 6 Cache

Stage 6 uses a process-local LRU-style cache with up to 2,000 entries. The cache key includes:

- scoring schema version
- normalized query
- intent object
- scorer model
- source name
- source type
- title
- URL
- extraction status/method/confidence/coverage
- chunk content

Cached scores are reused for duplicate or repeated evidence, especially inside repair loops.

## Stage 6 Rescue Rules

If every chunk falls below threshold, Stage 6 can rescue weak-but-plausible chunks:

```text
relevance_to_query >= 0.12
combined_score >= max(0.025, threshold * 0.20)
```

It can also rescue chunks that cover missing required source types. This prevents a brittle all-or-nothing failure when the scorer is conservative but the evidence is still usable.

## Bayesian-Style Source Reliability

After Stage 6, Agent Search can adjust source weight using a reliability store. Each source/domain pair has a Beta-distribution-like record:

```text
prior = clamp(source_type_weight, 0.05, 0.95)
strength = 6
alpha = prior * strength
beta = (1 - prior) * strength
reliability_score = alpha / (alpha + beta)
```

Outcomes update the distribution:

| Outcome | Alpha delta | Beta delta |
|---|---:|---:|
| confirmed | 1.0 | 0.0 |
| contradicted | 0.0 | 1.0 |
| repeated | 0.2 | 0.1 |
| observed | 0.05 | 0.05 |

The adjusted source weight is:

```text
adjusted_source_weight =
  clamp((chunk_source_weight + reliability_score) / 2, 0.05, 1.00)
```

This is intentionally conservative. A source does not become perfect because it was selected once, and a good source is not destroyed by one noisy observation.

## Stage 7: Duplicate and Near-Duplicate Clustering

Deduplication uses several duplicate levels, then clusters with union-find.

A pair is duplicate if any condition passes:

```text
same canonical document key
OR same normalized content key
OR document_jaccard >= 0.92
OR claim_jaccard >= 0.78
OR semantic_cosine >= semantic_threshold
```

Semantic threshold:

```text
semantic_threshold = default_dedup_threshold
```

The default is `0.85` for same-source-type comparisons. Cross-source-type semantic duplicates are stricter:

```text
cross_type_threshold = max(0.94, default_dedup_threshold + 0.08)
```

Representative selection chooses the highest:

```text
representative_score =
  relevance_to_query
  * source_weight
  * confidence_score
  * freshness_fitness
```

Dedup diagnostics include duplicate level, member ids, rejected ids, novelty score, and Jensen-Shannon divergence.

## Information-Theoretic Novelty

Text distributions are normalized token frequencies. KL divergence is:

```text
KL(P || Q) = sum over tokens p(token) * ln(p(token) / q(token))
```

Jensen-Shannon divergence is:

```text
M = (P + Q) / 2
JSD(P, Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M)
normalized_JSD = JSD(P, Q) / ln(2)
```

Cluster novelty is:

```text
novelty_score = 1 - max_jaccard_overlap_with_other_cluster_members
```

## Stage 8: Budgeted Assembly

Stage 8 selects final chunks under the token budget. It first reserves required source-type coverage, then greedily selects by marginal gain.

The core gain function is:

```text
marginal_gain =
  relevance_to_query
  * novelty
  * source_weight
  * query_type_weight
  - epistemic_stance_penalty
```

Novelty is:

```text
novelty = clamp(1 - max_similarity_to_selected, 0.05, 1.00)
```

Similarity uses embedding cosine when embeddings exist, otherwise claim overlap.

Required-source reservation uses:

```text
required_coverage_boost = 0.35
required_coverage_min_relevance = 0.12
required_coverage_min_gain = 0.02
```

Query-type weight adds targeted boosts:

| Query or requirement | Boost |
|---|---:|
| required source type match | +0.28 |
| multi-hop claim count | +0.04 per claim, capped at +0.25 |
| fresh-fact freshness | up to +0.25 |
| adversarial primary source | +0.25 |
| source-attribution claim support | +0.18 |
| dedup-prone surprise | up to +0.30 |
| academic/medical source for academic query | +0.22 |
| cultural non-speculative source | +0.08 |

Penalties:

| Condition | Penalty |
|---|---:|
| speculation stance | -0.18 |
| adversarial query with opinion stance | -0.12 |
| fresh-fact query with tertiary summary stance | -0.05 |

Chunks below contextual relevance `0.08` are rejected as contextual mismatches even if they fit the budget.

## Evidence Health

Evidence health turns the selected chunk set into two user-facing scores:

- `evidence_quality_score`
- `evidence_coverage_score`

First it computes component scores:

```text
relevance_confidence =
  pct((average_relevance + average_confidence) / 2)
```

```text
source_authority =
  pct(
    average_source_weight * 0.72
    + primary_source_bonus
    + intent_bonus
  )
```

`primary_source_bonus` is `0.18` when at least one primary-like source is present.

Coverage/diversity:

```text
coverage_diversity =
  pct(
    claim_coverage * 0.34
    + min(1, distinct_source_types / 3) * 0.24
    + min(1, distinct_sources / 3) * 0.16
    + required_source_type_match_ratio * 0.16
    + non_redundancy * 0.10
  )
```

Claim coverage is:

```text
claim_coverage = min(1, selected_claim_count / 8)
```

Non-redundancy is:

```text
non_redundancy =
  selected_count / max(1, selected_count + dedup_rejected_count)
```

Freshness/failure:

```text
failure_penalty =
  min(0.35, failed_important_source_count * 0.12)

freshness_failure =
  pct(max(0, average_freshness - failure_penalty))
```

Then:

```text
evidence_quality =
  relevance_confidence * 0.35
  + source_authority * 0.25
  + coverage_diversity * 0.25
  + freshness_failure * 0.15
```

```text
evidence_coverage =
  coverage_diversity * 0.65
  + relevance_confidence * 0.20
  + non_redundancy * 100 * 0.15
```

The final scores are capped by relevance and extraction quality:

```text
if average_relevance < 0.25: cap at 34
else if average_relevance < 0.35: cap at 58
else cap at 100
```

Near-zero relevance chunks and degraded extraction reduce final scores:

```text
zero_relevance_penalty =
  near_zero_count > 0
    ? max(0.45, 1 - near_zero_count / selected_count)
    : 1

extraction_penalty =
  degraded_count > 0
    ? max(0.55, 1 - degraded_count / selected_count * 0.25)
    : 1
```

Status thresholds:

| Minimum score | Status |
|---:|---|
| 80 | strong |
| 60 | adequate |
| 35 | weak |
| below 35 | insufficient |

## Gap Analysis and Repair

Gap analysis checks whether the selected evidence can answer the query safely. It looks for:

- no selected chunks
- weak or insufficient evidence health
- missing required source types
- important source failures
- near-zero contextual relevance
- keyword-adjacent but answer-irrelevant chunks
- missing domain-specific answer facets

Balanced mode is bounded:

- at most 2 hard-gap repair rounds
- 45 second repair budget
- stop repair when evidence is adequate or strong and only soft gaps remain
- deepen degraded high-authority existing sources before broad new retrieval

This is why balanced mode can remain fast without silently ignoring hard evidence gaps.

## Model Versus Deterministic Responsibilities

The structured model helps with semantic judgments that are hard to encode cleanly:

- query relevance
- claim extraction
- epistemic stance
- chunk summary
- confidence judgment

Deterministic code owns the safety rails:

- source allowlisting
- schema validation
- fallback scoring
- extraction ceilings
- source priors
- reliability adjustment
- duplicate clustering
- token-budget assembly
- evidence health
- repair limits
- trace emission

This split is the main architecture decision: use models where they add judgement, but keep acceptance, filtering, and auditability in code.

## Traceability

Every major scoring decision is surfaced in the trace:

- pre-rank selected and rejected candidates
- duplicate groups
- scoring batch durations
- structured LLM call attempts
- reasoning enabled/disabled
- cache hits and misses
- fallback usage
- source results and errors
- extraction counts and degradation
- final marginal gains
- evidence health components
- gap-analysis stop reason
- synthesis review

The compare UI reads the same trace used by the API/debug routes, so the visible runtime diagnostics are not separate from the pipeline.

## Practical Interpretation

High-quality answers usually have:

- multiple selected chunks
- more than one source type
- at least one primary-like source when the query asks for facts, policies, filings, or claims about current entities
- high relevance and confidence
- low duplicate rejection pressure
- full-text or section-text extraction
- few or no important source failures
- evidence health of `adequate` or `strong`

Weak answers are still allowed when the user asks a hard question, but they should be visibly cautious, cited, and traceable. The system should never silently turn a failed source call or metadata-only result into strong claim support.
