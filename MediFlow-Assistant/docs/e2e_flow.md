Goal
- Conversational RAG assistant for medical documents: extract, redact, store, and answer with provenance.

High-level flow
1. Upload (Client): User selects image/PDF in UI. File is validated and converted to base64 (data URL). Images are optionally compressed in-browser.
2. Ingestion API: Frontend POSTs `{ base64 }` to the ingestion route (`app/api/extractreportgemini/route.ts`).
3. OCR / Multimodal Extraction: The ingestion route sends the base64 file to Gemini (multimodal) via `generateContent` with a prompt that returns a JSON payload containing full text, a short summary, and extracted triples.
4. PII Redaction & Vaulting: Server runs `lib/pii-redaction.ts` to replace detected PII tokens and stores an encrypted vault (mapping tokens -> original values) in Redis (Upstash). The route returns a redacted summary and a `vaultId`.
5. Graph Storage: Extracted triples (entities/relations) are stored in Neo4j for Graph-RAG queries (`storeTriplesInNeo4j`).
6. Chunking & Embeddings (ingest step): Redacted text is chunked and embeddings are generated (HF or provider). Embeddings are stored in Pinecone (vector DB).
7. User Query (Chat flow): User asks a question; the chat route (`app/api/medichatgemini/route.ts`) redacts the question, checks Redis semantic cache (`lib/cache.ts`), and on miss retrieves relevant passages from Pinecone and relationships from Neo4j.
8. Model Generation: Assemble prompt (redacted report + retrievals + graph data). Route selects a model (Gemini by default), streams the answer, caches the redacted response in Redis, then re-hydrates PII from the vault for allowed disclosures and streams the final response to the client.

Concrete example
- Uploaded file: `report-123.png` (radiology image of a multi-page report).
- OCR / Gemini returns raw text: "Patient John Doe, DOB 1970-01-01. Findings: left lower lobe consolidation consistent with pneumonia."
- Redacted summary: "Patient [NAME_1], DOB [DOB_1]. Findings: left lower lobe consolidation consistent with pneumonia." Vault stores `{ "[NAME_1]": "John Doe", "[DOB_1]": "1970-01-01" }` under `vault:<vaultId>` in Redis.
- Triples inserted in Neo4j: (Pneumonia)-[:LOCATION]->(Left lower lobe).
- Embeddings stored in Pinecone for retrieval.
- User asks: "Could this be aspiration pneumonia?" → chat route redacts question, cache miss → Pinecone returns the consolidation passage, Neo4j returns aspirational risk relations → Prompt assembled and Gemini responds with a reasoned answer. The route caches the redacted response and re-hydrates PII if needed before returning.

Files referenced
- Ingestion: app/api/extractreportgemini/route.ts
- Client upload: components/ReportComponent.tsx
- PII & vaulting: lib/pii-redaction.ts
- Semantic cache: lib/cache.ts
- Chat/QA: app/api/medichatgemini/route.ts

Notes
- Current implementation sends files as base64 data URIs from the browser. This is simple and works for small-to-medium files but requires size limits and validation. For larger files, multipart upload to a storage service (S3, UploadThing) with server-side processing is recommended.
- Vaults and cache use Upstash Redis; graph store uses Neo4j; vector store integration uses Pinecone (see chat route for retrieval calls).