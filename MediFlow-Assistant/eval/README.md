# Evaluation harness

Measures the three stages that decide whether an answer is grounded: hybrid retrieval,
corrective-RAG grading, and the semantic response cache. Before this existed, the only
evidence any of them worked was reading LangSmith traces one request at a time.

Everything runs against a fixed synthetic corpus in a Pinecone namespace of its own, so
numbers are comparable between runs and nothing here touches production data.

## Running it

```bash
npm run eval:build      # ingest the fixtures into Pinecone (run once, and after any fixture edit)
npm run eval            # all three suites
npm run eval:retrieval  # one suite at a time
npm run eval:guard
npm run eval:cache
```

`eval:build` must run first. Suites refuse to start against a missing or stale corpus
rather than silently re-ingesting, because a fixture edited without a rebuild produces
gold labels describing text the index does not contain — which looks exactly like a
retrieval regression.

### Retries

Suites retry transient failures with exponential backoff and report how many they needed,
because a run that needed fifteen produced its latency figures under conditions worth
knowing about.

The guard suite needs a second mechanism. `guardQuestion` fails open rather than throwing,
so a rate limit resolves as a well-formed `intent: "answer"` carrying `guardFailed: true` -
invisible to a retry that watches for exceptions. It therefore retries on that flag via
`withRetry`'s `retryResult`, and a case that still fails open after its retries is counted
as an outage that voids the run's metrics rather than scored as a routing decision.

Note that the AI SDK already retries a 429 twice inside a single `generateObject` call, so
`guardFailed` means the failure survived those too.

### Environment

Reads `.env.local` then `.env`, same precedence as Next. Each suite requires only what it
uses:

| Suite | Requires |
|---|---|
| retrieval | `PINECONE_API_KEY`, `HF_TOKEN`, `GEMINI_API_KEY` |
| guard | `GEMINI_API_KEY` |
| cache | `PINECONE_API_KEY`, `HF_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

| Variable | Default | Effect |
|---|---|---|
| `EVAL_PINECONE_INDEX` | `medic` | Index to build the corpus in |
| `EVAL_PINECONE_NAMESPACE` | `eval-diagnosis2` | Namespace, never `diagnosis2` |
| `EVAL_CONCURRENCY` | `1` | Cases in flight. Above 1 the latency figures measure contention, and the report says so |

`LANGSMITH_TRACING=true` adds a span upload to every stage and inflates every latency
number. The run banner reports which mode produced the figures.

## What it measures

### Retrieval

Each case names a report and a question, and lists gold facts as verbatim `label value`
strings from the fixture (`Ferritin 6 ng/mL`). A retrieved chunk is a hit when it contains
one of them, after lowercasing and whitespace collapse.

Facts are written with their label on purpose. A bare `6 ng/mL` is a substring of
`26 ng/mL` elsewhere in the same report and would score a false hit; requiring the label
means a chunk counts only when it carries the line that answers the question.

- **recall@k / MRR** — did the answer-bearing chunk come back, and how high.
- **fact recall** — of the facts labelled for a question, how many were retrieved at all.
- **selectivity** — chunks returned against chunks available. This is the number to read
  first. `topK` is 10 and retrieval is filtered to one `documentId`, so a report with 10
  chunks or fewer returns *everything* regardless of the question, and its recall@10 is
  100% by construction rather than by merit. The suite splits results into large reports
  (more chunks than topK, where ranking does real work) and medium/small ones, because
  averaging a meaningful number with a tautological one produces neither.

### Grading (corrective RAG)

Verdict agreement against a labelled `relevant` / `partial` / `none`, plus the two
asymmetric failures that matter more than the aggregate:

- **false refusals** — a covered question graded `none`. `buildGroundingInstruction` then
  tells the model to say the report does not contain this, so the user is denied
  information their own report holds. The worst outcome the grader can produce.
- **false grounding** — an uncovered question graded `relevant` or `partial`, which is the
  padding-as-evidence problem the grader was added to fix.
- **answer dropped by grader** — retrieval returned a chunk carrying a gold fact and
  grading removed it. Distinct from a false refusal: the verdict can still read
  `relevant` while the one chunk that mattered was discarded.

Confusing `relevant` with `partial` is a judgement call about completeness and is scored
but not called a failure.

### Query guard

Intent accuracy over `answer` / `clarify` / `refuse`, with per-class precision and recall
— accuracy alone cannot distinguish a working guard from one that has collapsed onto a
single label.

Two named failure directions: **off-topic leaked through** (the original bug — a trivia
question answered from general knowledge, cached 24h, and written into long-term memory)
and **in-scope over-refused** (how the guard becomes useless).

A third direction sits inside `clarify`, and it produced a real user-facing bug: asking to
clarify something that was never unclear. The guard is handed the report summary, so it can
tell a broad question from an ambiguous one — with only a boolean, "what is the problem with
the patient?" routed to `clarify`, and since the answer to every follow-up also lived in the
report it could not see, the loop had no exit at temperature 0. The `answer-broad-*` cases
cover breadth in both first and third person, and `answer-escapes-clarify-loop` checks that
answering a clarifier makes progress.

Rewriting is scored separately. A follow-up like "is that bad?" routed to `answer` but
passed through verbatim still poisons the cache key, and intent accuracy alone would call
that a pass. The suite checks that context-dependent questions get rewritten *and* that
self-contained ones are left alone.

### Semantic cache

Pairs of questions against the same report, labelled `paraphrase` (should hit) or
`distinct` (must not). The distinct pairs are deliberate near-misses — LDL against HDL,
ALT against AST, hepatitis B against hepatitis C — because those are the only ones a
cosine threshold can realistically get wrong. Pairing unrelated questions would produce a
reassuring 0% false-hit rate that tested nothing.

Reported:

- **paraphrase hit rate** — a miss costs one wasted generation, nothing worse.
- **false hit rate** — a hit here replays one question's answer for a different question,
  and because it is served through the static-answer path the user sees no indication
  anything was reused.
- **threshold sweep** — hit rate and false-hit rate at thresholds from 0.80 to 0.99, and
  whether the two populations separate at all. The production threshold of 0.95 was never
  chosen against measured data; this is that data.
- **lookup scaling** — `getCachedResponse` does `KEYS` + `MGET` over every entry for the
  report and compares in process, so cost is linear in cached questions. Entries live 24h,
  so a busy report accumulates them all day.

A **measurement self-check** recomputes each pair's cosine independently and compares it
to what the lookup actually did. `getCachedResponse` swallows Redis and embedding failures
and returns `null`, which is indistinguishable from a genuine miss — without this check, a
run degraded by infrastructure would report a low hit rate as if it were a threshold
finding.

## Known limits

Read these before quoting any number from a run.

1. **Answer quality is not measured.** The harness stops at the grounding decision. Whether
   the generated prose is correct, safe or well-hedged needs an LLM judge or human review,
   and neither is here.

2. **The guard and the grader fail open by design.** On a Gemini error `guardQuestion`
   returns `answer` and `gradeRetrieval` passes chunks through ungraded. Both are now
   visible in the results: `guardFailed` per guard case and the `ungraded` count for the
   grader, and a non-zero value on either means some figures reflect an unavailable API
   rather than a judgement.

   The guard suite reports outages before its metrics and voids them, because a fully
   failed run is not merely noisy — it is indistinguishable on paper from a permissive
   guard. A 2026-08-14 run scored 46.2% intent accuracy with all eight refuse cases
   "leaking through" while every one of its 26 calls had in fact failed and been waved
   through. Read the outage row first; if it is non-zero, nothing below it means anything.

3. **Sample sizes are small** — 61 retrieval cases, 33 guard cases, 20 cache pairs. Enough
   to catch a broken stage or a regression between runs; not enough to tune a threshold on.
   The sweep reports the most permissive threshold with zero false hits as an observation
   about this gold set, not a recommendation.

4. **The corpus is synthetic.** Real uploads arrive via OCR or a PDF text layer, with
   transcription noise, broken table alignment and inconsistent units that these clean
   fixtures do not reproduce. Retrieval on real documents will be harder than this.

5. **Gold labels are one author's judgement**, written alongside the fixtures. `partial`
   versus `relevant` is the softest of them.

6. **Grading and guarding are LLM calls at temperature 0**, which is near-deterministic but
   not deterministic. Small run-to-run movement in those percentages is noise, not signal.

## Layout

```
eval/
  build.ts              ingest fixtures into the eval namespace
  run.ts                suite runner; writes eval/results/<timestamp>.json
  fixtures/reports/     5 synthetic reports, each with a hand-written summary
  dataset/              gold labels: retrieval.ts, guard.ts, cache.ts
  suites/               one file per suite
  lib/                  env loading, corpus build/manifest, metrics, retry, concurrency
```

Fixtures carry hand-written summaries rather than generated ones. The chat route prepends
the summary to every retrieval query, so the corpus builder deliberately skips the ingest
route's Gemini extraction pass — otherwise the summary, and therefore every retrieval
query and every number downstream, would differ on each rebuild.

`eval/.corpus.json` and `eval/results/` are gitignored. The fixtures and gold sets are
committed; what one run produced on one machine is a log, not a source of truth.
