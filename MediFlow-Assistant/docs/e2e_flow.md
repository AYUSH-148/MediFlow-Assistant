Goal
- Conversational RAG assistant for medical documents: extract, redact, store, and answer with provenance.

High-level flow
1. Upload (Client): User selects image/PDF in UI. File is validated and converted to base64 (data URL). Images are optionally compressed in-browser.
2. Ingestion API: Frontend POSTs `{ base64 }` to the ingestion route (`app/api/extractreportgemini/route.ts`).
3. OCR / Multimodal Extraction: The ingestion route sends the base64 file to Gemini (multimodal) via `generateContent` with a prompt that returns a JSON payload containing full text, a short summary, and extracted triples.
4. PII Redaction & Vaulting: Server runs `lib/pii-redaction.ts` to replace detected PII tokens and stores an encrypted vault (mapping tokens -> original values) in Redis (Upstash). The route returns a redacted summary and a `vaultId`.
5. Graph Storage: Extracted triples (entities/relations) are stored in Neo4j for Graph-RAG queries (`storeTriplesInNeo4j`).
6. Chunking & Embeddings (ingest step): Redacted text is chunked and embeddings are generated (HF or provider). Embeddings are stored in Pinecone (vector DB).
7. User Query (Chat flow): User asks a question; the chat route (`app/api/medichatgemini/route.ts`) redacts the question, then routes it through the query guard (`lib/query-guard.ts`).
8. Query Guard: One classification pass returns `refuse` (not health-related — returns a redirect and stops), `clarify` (ambiguous, or needs a report that was never uploaded — returns one question and stops), or `answer`. On `answer` it also rewrites the question to stand alone, resolving pronouns from the conversation history. Because refuse/clarify return here, retrieval, the cache write and the memory write are unreachable for them. The rewritten question is what every later stage uses — cache key, both retrieval queries, prompt, and stored memory.
9. Retrieval: Redis semantic cache lookup (`lib/cache.ts`) on the resolved question; on miss, hybrid retrieval from Pinecone (dense + TF-IDF fused with RRF) and the conversation-memory namespace run concurrently. The memory search is skipped when a Redis flag shows the namespace is empty for that document.
10. Retrieval Grading: `lib/retrieval-grader.ts` grades the retrieved chunks against the bare question and returns `relevant`, `partial`, or `none`. Chunks that do not bear on the question are dropped; on `none` the excerpt section is emptied and the generator is instructed to say the report does not contain the information rather than answering from general medical knowledge.
11. Model Generation: Assemble prompt (redacted report summary + graded excerpts + conversation memory + grounding rule + today's date). Gemini streams the answer with the `queryKnowledgeGraph` tool available for Neo4j lookups, the response is cached in Redis, written to conversation memory, then re-hydrated from the vault before streaming to the client.

Concrete example
- Uploaded file: `report-123.png` (radiology image of a multi-page report).
- OCR / Gemini returns raw text: "Patient John Doe, DOB 1970-01-01. Findings: left lower lobe consolidation consistent with pneumonia."
- Redacted summary: "Patient [NAME_1], DOB [DOB_1]. Findings: left lower lobe consolidation consistent with pneumonia." Vault stores `{ "[NAME_1]": "John Doe", "[DOB_1]": "1970-01-01" }` under `vault:<vaultId>` in Redis.
- Triples inserted in Neo4j: (Pneumonia)-[:LOCATION]->(Left lower lobe).
- Embeddings stored in Pinecone for retrieval.
- User asks: "Could this be aspiration pneumonia?" → chat route redacts the question → guard returns `answer` (health-related, already self-contained) → cache miss → Pinecone returns the consolidation passage → grader returns `relevant` and keeps it → Neo4j returns aspiration risk relations → prompt assembled and Gemini responds with a reasoned answer. The route caches the redacted response and re-hydrates PII before returning.
- Follow-up: "is that bad?" → guard returns `answer` with `resolvedQuestion: "Is left lower lobe consolidation consistent with pneumonia serious?"`. That resolved form — not the two-word original — becomes the cache key, the retrieval query, and the stored memory entry.
- Out of scope: "what is the capital of India" → guard returns `refuse`, a redirect is streamed, and nothing is retrieved, cached, or written to memory.
- Not in the report: "what is my vitamin D level?" → guard returns `answer`, retrieval returns its top chunks anyway, grader returns `none` → the excerpt section is emptied and the answer states that the report does not contain vitamin D results, instead of inventing one.

Files referenced
- Ingestion: app/api/extractreportgemini/route.ts
- Client upload: components/ReportComponent.tsx
- PII & vaulting: lib/pii-redaction.ts
- Query guard: lib/query-guard.ts
- Retrieval grading: lib/retrieval-grader.ts
- Semantic cache: lib/cache.ts
- Chat/QA: app/api/medichatgemini/route.ts

Notes
- Current implementation sends files as base64 data URIs from the browser. This is simple and works for small-to-medium files but requires size limits and validation. For larger files, multipart upload to a storage service (S3, UploadThing) with server-side processing is recommended.
- Vaults and cache use Upstash Redis; graph store uses Neo4j; vector store integration uses Pinecone (see chat route for retrieval calls).