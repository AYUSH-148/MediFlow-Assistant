# 🚑 MediFlow Assistant

**Upload a medical report, get answers you can trust — without handing your name to an LLM.**

MediFlow is a production-shaped RAG application for clinical documents. It reads a report (PDF, scan, or phone photo), strips personally identifying information *before* anything is embedded, stored, or sent to a model, and then answers questions about it using hybrid retrieval and a medical knowledge graph. Identifiers are restored only in the final response, on the way back to the person who uploaded the report.

**🔗 Live demo → [medi-flow-assistant.vercel.app](https://medi-flow-assistant.vercel.app/)**

> ⚕️ Not medical advice. This is an informational tool for understanding a report, not a diagnostic system.

---

## Why this project is interesting

Most RAG demos stop at "chunk a PDF, embed it, stuff it in a prompt." The hard parts of this one are the ones that only show up once you take the domain seriously:

| Problem | How it's solved |
|---|---|
| PHI must not reach the LLM, the vector DB, the cache, or the trace backend | Rule-based redaction into a Redis **token vault**, with rehydration at the last possible moment |
| Clinical questions rarely use the report's exact wording | **Hybrid retrieval** — dense vectors + TF-IDF, fused with Reciprocal Rank Fusion |
| A knowledge graph shared across patients can leak one patient's data into another's answer | Graph nodes are **scoped by document** on both the write *and* the read side |
| Redaction that's too aggressive destroys the clinical text you're trying to search | Label-anchored, case-sensitive patterns tuned against real report layouts |
| Scanned reports have no text layer; born-digital ones do | Text-layer extraction first, **Gemini vision OCR as fallback** |
| You can't debug an LLM pipeline you can't see — but tracing PHI defeats the point | LangSmith spans with a **PHI capture flag that defaults to off** |

---

## Architecture

```
                          ┌──────────────────────────────┐
   PDF / image  ─────────▶│  POST /api/extractreportgemini│
                          └───────────────┬──────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
     text layer (pdf-parse)      Gemini structured output      redaction rules
     └─ empty? ─▶ Gemini OCR     ├─ summary                    ├─ [NAME_1] …
                                 └─ entity triples             └─ vault ──▶ Redis (24h)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
      chunk 1200/150             redacted triples            redacted summary
      embed (mxbai 1024d)        Neo4j :Entity graph          ──▶ browser
      Pinecone ns: diagnosis2    (document-scoped)


                          ┌──────────────────────────────┐
   question    ─────────▶ │   POST /api/medichatgemini    │
                          └───────────────┬──────────────┘
                                          ▼
                              redact question (no vault)
                                          ▼
                       semantic cache lookup (Redis, cos ≥ 0.95)
                                   hit ──▶ rehydrate ──▶ stream
                                   miss
                                          ▼
                    ┌─────────── Promise.all ───────────┐
                    ▼                                   ▼
        hybrid retrieval (report)         conversation memory (skipped
        vector top-12 ┐                   when the namespace is empty)
        TF-IDF top-500┴─ RRF ─▶ top-10
                    └─────────────┬─────────────────────┘
                                  ▼
                    Gemini 2.5 Flash + queryKnowledgeGraph tool
                          (agentic, up to 5 steps → Neo4j)
                                  ▼
                    stream ─▶ buffer ─▶ cache ─▶ write memory
                                  ▼
                       rehydrate from vault ─▶ client
```

---

## Engineering deep dives

### 🔒 PII redaction with a token vault

Redaction runs over the **entire document** before chunking, not just the summary — so no identifier ever reaches Pinecone.

- Every distinct PII value gets one stable token (`[NAME_1]`, `[MRN_2]`) across the document *and* its summary, so the same person maps to the same token everywhere.
- Rules are **label-anchored** (`Patient:`, `DOB:`, `MRN:`) rather than broad. A naive "two capitalised words = a name" rule tokenises half a clinical report and destroys retrieval quality.
- Replacement is case-insensitive and whitespace-tolerant, because OCR reads a header as `PATIENT RAHUL MEHTA` while the model's summary says `Rahul Mehta` — an exact-match replace leaves the second spelling on screen.
- The vault lives in Redis with a 24-hour TTL and is **never** sent to the trace backend; shipping it alongside the redacted text would hand over both the ciphertext and the key.
- Rehydration is verified: the pipeline counts tokens that survive, including ones split across streaming chunk boundaries, and records that as an alertable metric.

### 🔎 Hybrid retrieval + RRF

Semantic search alone misses exact clinical terms; keyword search alone misses paraphrase. Both arms run over the **same document-filtered corpus** and are fused:

- **Dense:** Pinecone `topK 12`, cosine, 1024-dim `mxbai-embed-large-v1`.
- **Sparse:** TF-IDF over a `topK 500` filtered corpus pull, with stop-word filtering.
- **Fusion:** Reciprocal Rank Fusion (`k = 60`), final `topK 10`.

Both arms reuse a **single embedding call** — the query vector is computed once and passed into the keyword corpus fetch rather than recomputed.

### 🕸️ GraphRAG as an agentic tool, not a prefetch

Extracted `(subject, predicate, object)` triples land in Neo4j. Rather than prefetching graph context for a fixed entity list on every request, the model gets a `queryKnowledgeGraph` tool and decides when to reach for it — following chains across up to 5 steps (e.g. *drug → interacting drug → contraindication*).

The subtle part is **scoping the neighbour, not just the queried node**. Generic entities like `Atorvastatin` are deliberately unscoped so knowledge is shared across documents — which means traversing out of one would return the `[NAME_n]` nodes of every patient ever prescribed it. The chat route then rehydrates through the *current* document's vault, resolving another patient's token to this patient's name. The model would confidently state a relationship belonging to someone else, and nothing about the output would look wrong. A neighbour is therefore admitted only when it is genuinely generic or explicitly scoped to this document.

### ⚡ Semantic caching

Answers are cached in Redis keyed by report hash, matched by **cosine similarity ≥ 0.95** against the redacted question rather than by exact string. Cache hits are re-emitted in the AI SDK data-stream protocol so the client parses them identically to a live generation. `bestSimilarity` is recorded on misses too — otherwise a threshold that never fires is indistinguishable from a cold cache.

### 📄 Two extraction paths

Born-digital PDFs are read via their text layer (`pdf-parse`), which is faster, cheaper, and lossless. A PDF whose text layer yields too little (< 100 chars, or < 20 chars/page) is treated as scanned and falls back to Gemini vision OCR — as are all image uploads. Both paths use **Gemini structured output** with a Zod schema, so a malformed response fails loudly as a 422 instead of silently becoming an empty summary.

### 📡 Observability without leaking

The whole pipeline is instrumented with LangSmith spans (`retriever`, `llm`, `tool`, `parser`), including token usage for cost attribution. Because the most useful spans sit on the *unredacted* side of the boundary, raw text capture is gated behind `LANGSMITH_TRACE_PHI`, which **defaults to off** — a deploy that forgets the flag degrades to metadata-only rather than streaming patient records to a third party.

### 🏎️ Latency work

- Report retrieval and conversation-memory retrieval run **concurrently** instead of sequentially.
- The conversation-memory search is **skipped entirely** when a Redis flag shows the namespace is empty for that document — turning an embedding call plus two Pinecone queries into a single `EXISTS`.
- Chunks are embedded in bounded batches of 8, since the HuggingFace inference API is the slowest dependency in ingest.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router), TypeScript |
| UI | Tailwind CSS, shadcn/ui, Radix |
| LLM | Google Gemini 2.5 Flash via Vercel AI SDK |
| Embeddings | `mixedbread-ai/mxbai-embed-large-v1` (1024-dim) via HuggingFace Inference |
| Vector DB | Pinecone |
| Knowledge graph | Neo4j |
| Cache + PII vault | Upstash Redis |
| Observability | LangSmith |
| Hosting | Vercel |

---

## Getting started

```bash
git clone git@github.com:AYUSH-148/MediFlow-Assistant.git
cd MediFlow-Assistant/MediFlow-Assistant
npm install
```

Create `.env.local` (see `.env.local.example`):

```bash
# Required
GEMINI_API_KEY=
PINECONE_API_KEY=
HF_TOKEN=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Optional — graph features are skipped when absent
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=

# Optional — tracing is off unless both of the first two are set
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
# LANGSMITH_TRACE_PHI=true   # records raw pre-redaction text — leave unset
```

**Pinecone setup.** Create an index named `medic` with **dimension 1024** and the **cosine** metric. The app uses two namespaces, created automatically on first write:

| Namespace | Contents |
|---|---|
| `diagnosis2` | Redacted report chunks |
| `conversation-history` | Per-document chat memory |

Then:

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint
```

---

## Project structure

```
MediFlow-Assistant/
├── app/
│   ├── api/extractreportgemini/route.ts   # ingest: extract → redact → chunk → index → graph
│   ├── api/medichatgemini/route.ts        # chat: redact → cache → retrieve → generate → rehydrate
│   ├── about/page.tsx
│   └── page.tsx
├── lib/
│   ├── pii-redaction.ts    # redaction rules, token vault, Neo4j read/write
│   ├── cache.ts            # semantic response cache + conversation-memory flag
│   ├── embeddings.ts       # HuggingFace client, single source of truth for the model id
│   ├── gemini.ts           # shared Gemini config + safety settings
│   └── tracing.ts          # LangSmith spans, PHI gating
├── components/             # chat UI, upload/preview, shadcn primitives
├── utils.ts                # Pinecone client, hybrid retrieval, TF-IDF, RRF
└── docs/e2e_flow.md        # end-to-end flow notes
```

---

## Configuration reference

| Setting | Value | Where |
|---|---|---|
| Chunk size / overlap | 1200 / 150 chars | `app/api/extractreportgemini/route.ts` |
| Embedding batch size | 8 | `lib/embeddings.ts` |
| Vector search `topK` | 12 | `utils.ts` |
| Keyword corpus `topK` | 500 | `utils.ts` |
| RRF constant / final `topK` | 60 / 10 | `utils.ts` |
| Cache similarity threshold | 0.95 | `app/api/medichatgemini/route.ts` |
| Cache + vault TTL | 24 hours | `lib/cache.ts`, `lib/pii-redaction.ts` |
| Max tool-calling steps | 5 | `app/api/medichatgemini/route.ts` |

---

## Known limitations

- Redaction is **rule-based**, so a name written in free prose (`"my name is Rahul, is my LDL high?"`) has no label to anchor on and survives. This is why nothing downstream treats post-redaction text as safe by default.
- Gemini safety filters are disabled — clinical prompts about dosages and treatments get blocked at default thresholds, and a blocked generation returns empty text rather than an error. Report contents are injected verbatim, so uploaded documents should be treated as untrusted input.
- Documents are uploaded as base64 data URLs, which caps practical file size. Large reports would want a multipart upload to object storage.
- If a vault expires before its cached answers do, those answers come back with `[NAME_1]` placeholders intact. The pipeline detects and reports this rather than hiding it.

---

## ⭐ Support

If you find this useful, a star on the repo is appreciated.
