Goal
- Conversational RAG assistant for medical documents: extract, redact, store, and answer with provenance.

High-level flow
1. Upload (Client): User selects an image or PDF in the UI (`components/ReportComponent.tsx`). The file is size-checked (4 MB cap) and sent as `multipart/form-data`. Images are downscaled to a 2000px long edge first.
2. Ingestion API (`app/api/extractreportgemini/route.ts`): PDFs are read through their text layer with `pdf-parse`. If that yields too little text (< 100 chars, or < 20 chars/page), or the upload is an image, Gemini vision OCR is used instead and returns full text, summary and triples in one structured call.
3. Dedup (text-layer path only): `documentId` is a SHA-256 of the text. If a stored ingest result and its vault both exist, they are returned unchanged with no model call.
4. Analysis: On the text-layer path, one Gemini structured-output call returns the summary and triples. Pages carrying large figures are rendered and described in one batched Gemini call; the descriptions are appended under a labelled heading, after the summary is generated and outside the hash.
5. PII Redaction & Vaulting: `lib/pii-redaction.ts` replaces PII with `[TYPE_N]` tokens across the text and summary together, and stores the token -> original value vault in Redis (Upstash) under `vault:<documentId>` with a 24h TTL.
6. Chunking & Embeddings: The redacted text is chunked (1200/150, each chunk prefixed with its section and table header, `lib/chunking.ts`), embedded with `mxbai-embed-large-v1` via Hugging Face, and upserted to Pinecone `medic` / `diagnosis2` with `documentId` metadata.
7. Graph Storage: Redacted triples are stored in Neo4j, scoped by document (`storeTriplesInNeo4j`).
8. Session: The route creates a Redis session `{documentId, summary, transcript}` (`lib/session.ts`) and sets an HttpOnly `mf_sid` cookie. The response carries the redacted summary but never the `documentId`.
9. Review: The user can edit the summary; `app/api/session/report/route.ts` binds the edited summary to the session.
10. User Query (Chat flow): The chat route (`app/api/medichatgemini/route.ts`) loads the session from the cookie, redacts the question, and takes the longer of the client's and the stored transcript as conversation history.
11. Query Guard (`lib/query-guard.ts`): One classification pass returns `refuse` (not health-related; returns a redirect and stops), `clarify` (ambiguous, or needs a report that was never uploaded; returns one question and stops), or `answer`. On `answer` it also rewrites the question to stand alone, resolving pronouns from the conversation history. The rewritten question is what every later stage uses: cache key, retrieval query, prompt, and stored transcript. A question about the conversation itself ("what did I ask before?") is flagged `conversational` and skips the cache, retrieval and grading.
12. Retrieval: Redis semantic cache lookup (`lib/cache.ts`) on the resolved question; on a hit the answer is rehydrated and returned. On a miss, hybrid retrieval from Pinecone (dense + TF-IDF fused with RRF, filtered to the session's `documentId`).
13. Retrieval Grading: `lib/retrieval-grader.ts` grades the retrieved chunks against the bare question and returns `relevant`, `partial`, or `none`. Chunks that do not bear on the question are dropped; on `none` the excerpt section is emptied and the generator is instructed to say the report does not contain the information rather than answering from general medical knowledge.
14. Model Generation: Assemble the prompt (grounding rule + today's date + redacted report summary + resolved question + graded excerpts + full conversation transcript). Gemini generates with the `queryKnowledgeGraph` tool available for Neo4j lookups (up to 5 steps). The answer is generated whole (`generateText`), not streamed.
15. Hallucination Check (`lib/answer-checker.ts`): One temperature-0 pass judges the answer against the question and the evidence the generator had: graded excerpts, report summary, today's date and the knowledge-graph lookups it made. Numbers in the answer that appear nowhere in the evidence are pointed out to the checker. Only claims about this patient must be supported; general medical explanation is allowed. `grounded` answers are sent. A `partial` answer gets one revision that removes or corrects the named claims; an `unsupported` one is regenerated with the critique. The retry is checked again, and if it still fails the user gets a fixed "couldn't verify" message. Conversational turns skip the check. On a checker error the answer is sent unchecked (fail open).
16. Delivery: Verified answers are cached in Redis and appended to the session transcript; fallbacks are neither. The answer is rehydrated from the vault and sent to the client in the AI SDK data-stream format, with the excerpts as an annotation.

Concrete example
- Uploaded file: `report-123.png` (photo of a radiology report), so the OCR path runs.
- OCR / Gemini returns raw text: "Patient John Doe, DOB 1970-01-01. Findings: left lower lobe consolidation consistent with pneumonia."
- Redacted summary: "Patient [NAME_1], DOB [DOB_1]. Findings: left lower lobe consolidation consistent with pneumonia." Vault stores `{ "[NAME_1]": "John Doe", "[DOB_1]": "1970-01-01" }` under `vault:<documentId>` in Redis.
- Triples inserted in Neo4j: (Pneumonia)-[:LOCATION]->(Left lower lobe).
- Embeddings stored in Pinecone for retrieval; the browser receives the redacted summary and the `mf_sid` cookie.
- User asks: "Could this be aspiration pneumonia?" → chat route redacts the question → guard returns `answer` (health-related, already self-contained) → cache miss → Pinecone returns the consolidation passage → grader returns `relevant` and keeps it → Neo4j returns aspiration risk relations → prompt assembled and Gemini responds with a reasoned answer → checker returns `grounded`. The route caches the redacted response, appends the turn to the session transcript, and rehydrates PII before returning.
- Follow-up: "is that bad?" → guard returns `answer` with `resolvedQuestion: "Is left lower lobe consolidation consistent with pneumonia serious?"`. That resolved form, not the two-word original, becomes the cache key, the retrieval query, and the stored transcript entry.
- Conversation question: "what did I ask first?" → guard returns `answer` with `conversational: true` → no cache, retrieval or grading; the answer comes from the transcript.
- Out of scope: "what is the capital of India" → guard returns `refuse`, a redirect is streamed, and nothing is retrieved, cached, or written to the transcript.
- Not in the report: "what is my vitamin D level?" → guard returns `answer`, retrieval returns its top chunks anyway, grader returns `none` → the excerpt section is emptied and the answer states that the report does not contain vitamin D results, instead of inventing one.

Files referenced
- Ingestion: app/api/extractreportgemini/route.ts
- Summary review: app/api/session/report/route.ts
- Client upload / review: components/ReportComponent.tsx
- Session: lib/session.ts
- PII & vaulting: lib/pii-redaction.ts
- Chunking: lib/chunking.ts
- Figures: lib/pdf-figures.ts
- Query guard: lib/query-guard.ts
- Retrieval grading: lib/retrieval-grader.ts
- Semantic cache: lib/cache.ts
- Hallucination check: lib/answer-checker.ts
- Chat/QA: app/api/medichatgemini/route.ts

Notes
- Uploads are capped at 4 MB and held in request memory only; the raw file is never persisted.
- Vault, cache, ingest result and session all live in Upstash Redis with 24h TTLs; the graph store is Neo4j; the vector store is Pinecone. The vault is stored as plain JSON, not encrypted, so Redis access controls are what protect it.
