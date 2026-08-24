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
| Nothing in a RAG pipeline naturally refuses, so trivia gets answered, cached, and stored as clinical memory | A **query guard** that routes to refuse / clarify / answer *before* anything expensive runs |
| A vague follow-up ("is that bad?") means nothing to a cache keyed on question text | The guard **rewrites the question to stand alone**, so the cache key describes what was actually asked |
| Retrieval always returns its top-k, so irrelevant chunks arrive labelled as evidence | **Corrective-RAG grading** against the bare question, with an explicit "not in your report" verdict |
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
                    query guard ──── refuse ──▶ redirect ──▶ stream
                    (intent + rewrite) ─ clarify ──▶ ask ──▶ stream
                                          │ answer
                                          ▼  question now stands alone
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
                  grade chunks against the question (corrective RAG)
                  relevant / partial ─▶ keep survivors
                  none ─────────────▶ drop context, require
                                       "this is not in your report"
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

### ✂️ Chunking that keeps its headings

`RecursiveCharacterTextSplitter` cuts on blank lines, then newlines, then spaces. It has no
idea a clinical report is mostly tables, so a cut lands wherever the character budget runs
out — and the rows after it are separated from the header row naming their columns.

A chunk in that state is worse than useless as evidence. Retrieved alone,
`172 mg/dL   < 100   HIGH` does not say which analyte it belongs to, or which number is the
result and which the reference. The generator infers column meaning from position, and it
will — sometimes wrongly, always confidently.

The 150-character overlap was the existing mitigation, and it is probabilistic: it carries
the header across only when the cut happens to fall within 150 characters of it. On a table
long enough to span several chunks it stops helping. Measured on a synthetic 40-row panel,
**2 of 4 chunks held rows with no header among them; after the fix, none do.**

Each chunk is now prefixed with the headings in force where it starts — its section, and the
column header of the table it sits inside — unless it already contains them. `chunksGivenContext`
is recorded so the prefixing is measurable rather than assumed.

This is deliberately independent of how the table was drawn. `pdf-parse` also exposes
`getTable()`, but that detects tables through their **border geometry**: on a ruled table it
returns structured rows, and on a whitespace-aligned one — how most lab reports are laid out
— it finds nothing at all. Verified both ways before choosing this approach.

The prefix helps beyond tables: a chunk lifted out of `SECTION 4 - LIVER` now says so, both
to the model reading it as evidence and to the embedding that has to match a question about
the liver.

### 🔎 Hybrid retrieval + RRF

Semantic search alone misses exact clinical terms; keyword search alone misses paraphrase. Both arms run over the **same document-filtered corpus** and are fused:

- **Dense:** Pinecone `topK 12`, cosine, 1024-dim `mxbai-embed-large-v1`.
- **Sparse:** TF-IDF over a `topK 500` filtered corpus pull, with stop-word filtering.
- **Fusion:** Reciprocal Rank Fusion (`k = 60`), final `topK 10`.

Both arms reuse a **single embedding call** — the query vector is computed once and passed into the keyword corpus fetch rather than recomputed.

**The query is the question alone**, behind the instruction prefix `mxbai` expects for retrieval queries (it is an asymmetric model — queries take a prefix, documents do not). The whole report summary used to be prepended to it, which cost three things at once:

| Cost | Why |
|---|---|
| Cosine similarity was meaningless as a relevance signal | The query vector was dominated by the report, so every chunk scored high on report-to-report similarity whatever was asked |
| The sparse arm scored against the report, not the question | `rankWithTfIdf` tokenises the same string, so every word of the summary became a query term — 33 terms instead of 14 on a representative question |
| A long report silently deleted the question | The summary sat *ahead* of the question in a string with a 512-token ceiling. A multi-page summary pushed the question past it, and the question is what got cut |

Prepending it was a way to give a context-free follow-up (*"is that bad?"*) something to match on. The query guard now rewrites such questions to stand alone **before** retrieval runs, so the context is already in the question and the prepend was redundant. Truncation is also now applied in `generateEmbedding` and **recorded** rather than left to the model, so a query that lost its tail is visible instead of looking like retrieval that merely performed badly.

### 🧭 The query guard — scope and ambiguity, before anything expensive

Nothing in a RAG pipeline naturally refuses. Ask *"what is the capital of India"* and the old flow ran full retrieval, answered from the model's general knowledge, cached the answer for 24 hours, and — with a report loaded — wrote it into long-term conversation memory as clinical history.

A single classification pass now runs **ahead of the cache lookup** and returns one of three intents:

- **refuse** — not health-related. Returns a redirect and stops.
- **clarify** — health-related but ambiguous, or needs report data when no report is uploaded. Returns one question.
- **answer** — proceeds, carrying a standalone rewrite of the question with pronouns resolved from conversation history.

Placement is what makes it cheap. Refuse and clarify return *before* retrieval, so an off-topic question costs one Flash call instead of five embedding calls and four Pinecone queries — **refusals are faster than answers**. Because they return early, the cache write and memory write sit on an unreachable branch; no suppression flag is threaded through anything.

The rewrite is the subtle half. *"Is that bad?"* means nothing on its own. The generator could resolve it from history, but the semantic cache keys on question text alone — so one turn's answer was replayed for a later, unrelated follow-up:

| Turn | User asks | Cache key *before* | Cache key *after* |
|---|---|---|---|
| 2 | "is that bad?" | `is that bad?` | `Is an LDL of 165 mg/dL concerning?` |
| 4 | "is that bad?" | `is that bad?` ← **collision** | `Is a BP of 148/92 concerning?` |

Resolving the question first makes the key self-describing, fixing the collision without hashing conversation history into it. Stored memory stops preserving a pronoun whose referent is gone, too.

The guard is pinned to `temperature: 0` — routing should not be a coin flip — and **fails open**: an outage degrades to the previous behaviour rather than to a chat that refuses everything.

### ✅ Corrective RAG — grading retrieval before trusting it

Retrieval always returns something. `<nomatches>` only appears when fusion yields literally zero rows, which does not happen on a populated index — so the top 10 chunks arrive labelled as evidence whether or not they bear on the question. The only thing between that and a confident wrong answer was a line of prompt etiquette asking the model to ignore irrelevant findings.

A grading pass now judges the chunks **against the question** and returns a verdict:

| Verdict | Chunks sent | What the generator is told |
|---|---|---|
| `relevant` | filtered survivors | answer from these |
| `partial` | survivors | answer what's covered, state explicitly what the report does not cover |
| `none` | none | say the report does not contain this — do not reach for general medical knowledge |

There is deliberately **no cheap numeric pre-filter**, because neither available score measures relevance to the question:

- The **RRF score** is `1/(60+rank)` summed across arms — pure rank position. The top result of a completely irrelevant corpus scores exactly as well as the top result of a perfect one.
- The **vector similarity** is now measured against the question alone, so it *has* become a meaningful signal — but it is still not used as a gate. Retrieval **ranks**; it does not threshold. The cutoff separating "relevant" from "the closest thing in this document" is not a constant, and a wrong one fails silently in the direction that matters: dropping evidence the report does contain.

Grading against the bare question is the one comparison the retrieval pipeline never makes. Empty retrievals still short-circuit without a model call, and surviving chunks are renumbered contiguously — a prompt listing "Finding 1, 4, 7" invites the model to wonder what it is not being shown.

Both non-relevant instructions send the model back to the report summary before declaring anything absent. The grader only saw the excerpts, but the summary is also in the prompt, so an unqualified *"not in your report"* would contradict something the model can plainly see.

### 🕸️ GraphRAG as an agentic tool, not a prefetch

Extracted `(subject, predicate, object)` triples land in Neo4j. Rather than prefetching graph context for a fixed entity list on every request, the model gets a `queryKnowledgeGraph` tool and decides when to reach for it — following chains across up to 5 steps (e.g. *drug → interacting drug → contraindication*).

The subtle part is **scoping the neighbour, not just the queried node**. Generic entities like `Atorvastatin` are deliberately unscoped so knowledge is shared across documents — which means traversing out of one would return the `[NAME_n]` nodes of every patient ever prescribed it. The chat route then rehydrates through the *current* document's vault, resolving another patient's token to this patient's name. The model would confidently state a relationship belonging to someone else, and nothing about the output would look wrong. A neighbour is therefore admitted only when it is genuinely generic or explicitly scoped to this document.

### 🚨 Failing visibly on the generation path

The guard fails open and the cache degrades quietly, but generation had no equivalent. A
`streamText` rejection - quota, auth, a network blip - was re-thrown, so Next returned a
bare 500 with no body. On the client that was worse than it sounds: `useChat` throws
`new Error(await response.text())` on a non-ok response, so an empty body meant an empty
message, and `keepLastMessageOnError` defaults to `false` in this version of the SDK, so
the same failure **rolled the user's own question back out of the transcript**. The
question disappeared with nothing on screen to explain it.

The route now returns a status and a plain-text reason - 429 for rate limiting, 502 for an
upstream fault, 500 otherwise - which `useChat` surfaces as `error.message`. Only the
status is read from the provider's error, never its message: it can quote the prompt back,
and on this route the prompt contains report text. The client keeps the failed message,
renders the reason, and offers a retry.

### ⚡ Semantic caching

Answers are cached in Redis keyed by report hash, matched by **cosine similarity ≥ 0.95** rather than by exact string. The match runs against the guard's **resolved** question, not the raw one — that is what stops two identical-looking follow-ups from colliding on one key. Cache hits are re-emitted in the AI SDK data-stream protocol so the client parses them identically to a live generation. `bestSimilarity` is recorded on misses too — otherwise a threshold that never fires is indistinguishable from a cold cache.

### 🖼️ Figures in born-digital reports

The text-layer path reads a page's words exactly and its pictures not at all - and it is
chosen precisely **because** the PDF has text, so an ECG trace or an echo sitting in a
text-bearing report was dropped with nothing recorded to say so. `charsPerPage` looks
healthy either way.

Three local, free steps decide whether a paid one is warranted:

| Step | Cost | Purpose |
|---|---|---|
| `getImage()` | free, local | which pages carry an image, and how big |
| size filter (≥150px per edge, ≥40k px²) | free | drop letterhead logos, signatures, rules |
| `getScreenshot({ partial })` | free, local | render only the surviving pages |
| one batched Gemini call | **the only paid step** | describe every figure page at once |

A report with no figures never reaches the vision model at all. Whole pages are rendered
rather than the extracted image bytes, because a chart stripped of its caption and axis
labels is materially harder to read.

**The text layer stays authoritative.** Figures are added to it, never substituted for it -
routing a whole document to vision because a chart appeared would trade exact lab values for
a model's re-reading of them, which is the regression the text-layer-first design exists to
prevent. Descriptions are appended under an explicit `--- FIGURES (described from page
images, not transcribed text) ---` heading, and that label travels into the chunks and the
answer prompt: a described figure is the model's reading of a picture, and if it arrived
looking like transcribed text neither the grader nor the generator could tell evidence from
inference.

Two ordering decisions carry the design:

- Descriptions are appended **after** `analyzeText`, so the summary every prompt carries and
  the graph triples stay derived from the report's own words. The descriptions still reach
  the index, which is what makes a question about a chart answerable.
- `documentId` hashes the text **before** the figure block. Descriptions are model output, so
  the same file uploaded twice can produce differently worded text - hashing that would give
  one document two ids and defeat the dedup it exists to provide.

Failures degrade rather than block: detection or description throwing leaves the text-layer
result intact, and `figuresDescribed`, `figuresSkipped` and `figuresFailed` are returned to
the client as well as traced, so a figure the pipeline saw and could not read is reported
rather than swallowed.

### 📄 Two extraction paths

Born-digital PDFs are read via their text layer (`pdf-parse`), which is faster, cheaper, and lossless. A PDF whose text layer yields too little (< 100 chars, or < 20 chars/page) is treated as scanned and falls back to Gemini vision OCR — as are all image uploads. Both paths use **Gemini structured output** with a Zod schema, so a malformed response fails loudly as a 422 instead of silently becoming an empty summary.

### 📡 Observability without leaking

The whole pipeline is instrumented with LangSmith spans (`retriever`, `llm`, `tool`, `parser`), including token usage for cost attribution. Because the most useful spans sit on the *unredacted* side of the boundary, raw text capture is gated behind `LANGSMITH_TRACE_PHI`, which **defaults to off** — a deploy that forgets the flag degrades to metadata-only rather than streaming patient records to a third party.

### 📦 Upload transport

The file goes up as `multipart/form-data`, not as a base64 data URL in a JSON body.

The original shape was JSON — one `JSON.stringify` on the client, one `req.json()` on the
server, no parsing to write. The cost showed up two layers away. Base64 encodes 3 bytes as 4
characters, so every upload paid **33% in transport** and the whole file passed through memory
as a string on both sides. To fit phone photos under that inflated ceiling, images were
re-encoded at **JPEG quality 0.1** — which degrades exactly the fine print, decimal points in
lab values, that the OCR path then has to read. A transport convenience was corrupting
extraction input.

Multipart carries the bytes as-is:

| | Base64 in JSON | `multipart/form-data` |
|---|---|---|
| Wire overhead | +33% | ~0% |
| Image handling | JPEG quality 0.1 | downscale to 2000px long edge, quality 0.85 |
| Server memory | file as a JS string, then a Buffer | Buffer directly |
| Size guard | none — opaque platform failure | explicit 400, client and server |

Images are now bounded by **resolution rather than quality**, which is the right axis: halving
the long edge of an oversized scan costs far less legibility than requantising every pixel of
it. The size check is also two-sided — the client rejects an oversized PDF before reading it,
and the route rejects one that did not come from the client, with a 400 rather than the 422
used for "read the document but could not understand it".

One hop still uses base64: Gemini's `generateContent` takes inline binary as
`inlineData.data`, because that endpoint is JSON too. The AI SDK encodes it there. That one is
a provider constraint rather than a local choice — and it only applies on the OCR path, so a
born-digital PDF now travels as raw bytes end to end.

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
│   ├── api/medichatgemini/route.ts        # chat: redact → guard → cache → retrieve → grade → generate → rehydrate
│   ├── about/page.tsx
│   └── page.tsx
├── lib/
│   ├── pii-redaction.ts    # redaction rules, token vault, Neo4j read/write
│   ├── query-guard.ts      # refuse / clarify / answer routing + question rewriting
│   ├── retrieval-grader.ts # corrective-RAG chunk grading + grounding instructions
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
| Conversation-memory flag TTL | none — mirrors non-expiring vectors | `lib/cache.ts` |
| Guard / grader temperature | 0 | `lib/query-guard.ts`, `lib/retrieval-grader.ts` |
| Gemini calls per answered question | 3 (guard → grader → generation) | `app/api/medichatgemini/route.ts` |
| Max tool-calling steps | 5 | `app/api/medichatgemini/route.ts` |

---

## Known limitations

- Redaction is **rule-based**, so a name written in free prose (`"my name is Rahul, is my LDL high?"`) has no label to anchor on and survives. This is why nothing downstream treats post-redaction text as safe by default.
- The query guard and the retrieval grader are **model judgment, not deterministic rules**. Both can misclassify — a legitimate question refused, or irrelevant chunks kept — and both deliberately fail open, so an outage degrades to the older, less careful behaviour rather than blocking the chat. Their spans record `intent`, `verdict` and `ungraded` precisely so drift is measurable rather than anecdotal.
- Answering a question now costs **three sequential Gemini calls** rather than one. Refusals and clarifications short-circuit before retrieval and grading, so the cheap paths stayed cheap, but the common case pays roughly two extra Flash round trips for the grounding.
- An indexing failure still returns a usable summary rather than failing the upload, but the response now says so (`searchable: false`) and the UI stops reporting success. Before that, a Pinecone or HuggingFace outage produced "Report processed!" for a document the chat could not search, and every question about it was answered "this is not in your report".
- A guard outage and a quota failure look the same from the user's chair, though they are distinguishable in a trace: the root span records `guardIntent` and `guardFailed`, and a generation failure closes with `outcome: "error"`.
- Gemini safety filters are disabled — clinical prompts about dosages and treatments get blocked at default thresholds, and a blocked generation returns empty text rather than an error. Report contents are injected verbatim, so uploaded documents should be treated as untrusted input.
- Uploads are capped at **4MB** and held in request memory for the lifetime of the request, so a large report is rejected rather than queued. Raising that ceiling means uploading to object storage instead — which for this pipeline would mean a durable copy of the *unredacted* document living outside the request, so it is deliberately not done: today the raw file is never persisted anywhere.
- If a vault expires before its cached answers do, those answers come back with `[NAME_1]` placeholders intact. The pipeline detects and reports this rather than hiding it.

---

## ⭐ Support

If you find this useful, a star on the repo is appreciated.
