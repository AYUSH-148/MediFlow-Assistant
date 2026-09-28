# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MediFlow Assistant: a Next.js 14 (App Router) conversational RAG app over uploaded medical reports. Gemini (`gemini-2.5-flash` via the Vercel AI SDK, `lib/gemini.ts`) for extraction/guarding/grading/answers, Hugging Face `mxbai-embed-large-v1` embeddings (1024-dim), Pinecone for vectors, Upstash Redis for cache/vault/sessions, Neo4j for Graph-RAG triples, LangSmith for tracing.

## Commands

```bash
npm run dev             # next dev
npm run build           # next build (output: 'standalone')
npm run lint            # next lint
npx tsc --noEmit        # type-check (no separate script)

npm run eval:build      # ingest eval fixtures into Pinecone; required first and after any fixture edit
npm run eval            # all eval suites
npm run eval:retrieval  # single suite: retrieval | guard | cache
```

There is no unit-test framework; the eval harness (`eval/`, run with `tsx`) is the test suite. It hits real Gemini/Pinecone/Redis, uses Pinecone namespace `eval-diagnosis2` (never production `diagnosis2`), and writes `eval/results/<timestamp>.json`. Read `eval/README.md` before interpreting numbers — notably, a non-zero guard outage / `ungraded` count voids the run's metrics.

Env: copy `.env.local.example`. Required: `GEMINI_API_KEY`, `HF_TOKEN`, `PINECONE_API_KEY` (index `medic`, dim 1024, cosine), `UPSTASH_REDIS_REST_URL`/`_TOKEN`. Neo4j vars optional (graph features skipped without them). Never enable `LANGSMITH_TRACE_PHI` casually — it sends raw pre-redaction text to LangSmith.

## Architecture

Full walkthrough with examples: `docs/e2e_flow.md` (note: its "conversation-memory namespace" is outdated — transcripts now live in the Redis session, see below).

Three API routes:

- `app/api/extractreportgemini/route.ts` — ingest. PDFs try the local text layer first (`pdf-parse`); scanned PDFs/images fall back to Gemini vision OCR. `lib/pdf-figures.ts` describes figures. Then PII redaction + vault, triples to Neo4j, `lib/chunking.ts` chunking, embeddings upserted to Pinecone `medic`/`diagnosis2`. `documentId` = SHA-256 of the text; text-layer re-uploads short-circuit via the stored ingest result (`reuseIngestedReport`) before any Gemini call. Sets the session cookie.
- `app/api/session/report/route.ts` — binds the user-edited summary to the session after the review step.
- `app/api/medichatgemini/route.ts` — chat. Pipeline: redact question → `lib/query-guard.ts` (`refuse`/`clarify` return early; `answer` also yields a standalone rewritten question used for everything downstream) → semantic cache (`lib/cache.ts`) → hybrid retrieval (`utils.ts`: dense + TF-IDF fused with RRF, filtered by `documentId`) → `lib/retrieval-grader.ts` (drops irrelevant chunks; `none` makes the model say the report lacks the info) → Gemini streams with a `queryKnowledgeGraph` Neo4j tool → cache write, transcript append, rehydrate PII from vault before returning.

Key invariants:

- **Session, not client ids.** `lib/session.ts` maps an HttpOnly `mf_sid` cookie to `{documentId, summary, transcript}` in Redis. The client never sees or sends `documentId`/`vaultId`; don't reintroduce them in request bodies or responses.
- **PII boundary.** `lib/pii-redaction.ts` replaces PII with `[TYPE_N]` tokens; the token→value vault is in Redis keyed by `documentId`. Everything sent to Gemini, Pinecone, Neo4j and the cache is redacted; rehydration happens only at the response edge. Trace spans use `safeInputs`/`phiGated`/`textShape` so raw text is recorded only when `LANGSMITH_TRACE_PHI=true`.
- **24h TTLs are aligned** across vault, response cache, ingest result and session — change them together.
- **Guard and grader fail open** on Gemini errors (`guardFailed`, ungraded pass-through) instead of throwing.
- **Tracing:** wrap stages with `span(...)` from `lib/tracing.ts`; routes call `flushTraces()` on every exit path because serverless hosts freeze after the response.
- Server-only PDF deps (`pdf-parse`, `pdfjs-dist`, `@napi-rs/canvas`) are externalized and force-included via `outputFileTracingIncludes` in `next.config.mjs`; removing those entries breaks ingest in standalone builds.

Path alias `@/*` maps to repo root (`@/utils` is root `utils.ts`, distinct from `lib/utils.ts` which only holds `cn`). UI is shadcn/ui (`components/ui/`); main client flow in `components/ReportComponent.tsx` (upload/review) and `components/chatcomponent.tsx` (`useChat`).

Code comments in this repo explain *why* at length (past bugs, trade-offs); preserve that context when editing.
