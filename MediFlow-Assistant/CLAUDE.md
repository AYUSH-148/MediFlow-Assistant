# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MediFlow Assistant: a Next.js 14 (App Router) conversational RAG app over uploaded medical reports. Gemini (`gemini-2.5-flash` via the Vercel AI SDK, `lib/gemini.ts`) for extraction/guarding/grading/answers, Gemini `gemini-embedding-001` embeddings (truncated to 1024-dim, `lib/embeddings.ts`), Pinecone for vectors, Upstash Redis for cache/vault/sessions, Neo4j for Graph-RAG triples, LangSmith for tracing.

## Repo layout

The git root is the parent directory (`MedicalRAG/`), not this app directory. It holds the main `README.md` (design rationale per feature, config reference, known limitations) and `Patient2.pdf`, a sample report for manual upload tests. All code, `npm` commands and this file live in `MediFlow-Assistant/`. Git paths are prefixed `MediFlow-Assistant/`.

Other notes in this directory: `graph-rag-neo4j-cypher.md` (Cypher for the graph), `pii-setup-guide.md` (redaction setup), `note` (a sample assembled prompt, not code).

## Commands

```bash
npm run dev             # next dev
npm run build           # next build (output: 'standalone')
npm run lint            # next lint
npx tsc --noEmit        # type-check (no separate script)

npm run eval:build      # ingest eval fixtures into Pinecone; required first and after any fixture edit
npm run eval            # all eval suites
npm run eval:retrieval  # single suite: retrieval | guard | cache | judge (JUDGE_PROVIDER=groq to judge with Groq)
```

There is no unit-test framework; the eval harness (`eval/`, run with `tsx`) is the test suite. It hits real Gemini/Pinecone/Redis, uses Pinecone namespace `eval-diagnosis2` (never production `diagnosis2`), and writes `eval/results/<timestamp>.json`. Read `eval/README.md` before interpreting numbers — notably, a non-zero guard outage / `ungraded` count voids the run's metrics.

Env: copy `.env.local.example`. Required: `GEMINI_API_KEY` (also used for embeddings), `PINECONE_API_KEY` (index `medic`, dim 1024, cosine), `UPSTASH_REDIS_REST_URL`/`_TOKEN`. Neo4j vars optional (graph features skipped without them). Never enable `LANGSMITH_TRACE_PHI` casually — it sends raw pre-redaction text to LangSmith.

## Architecture

Full walkthrough with examples: `docs/e2e_flow.md`. The root `README.md` has the design rationale. Conversation history is the transcript in the Redis session (capped at 200 turns of 8k chars each); there is no conversation-memory Pinecone namespace any more, so ignore any mention of one.

Three API routes:

- `app/api/extractreportgemini/route.ts` — ingest. PDFs try the local text layer first (`pdf-parse`); scanned PDFs/images fall back to Gemini vision OCR. `lib/pdf-figures.ts` describes figures. Then PII redaction + vault, triples to Neo4j, `lib/chunking.ts` chunking, embeddings upserted to Pinecone `medic`/`diagnosis2`. `documentId` = SHA-256 of the text; text-layer re-uploads short-circuit via the stored ingest result (`reuseIngestedReport`) before any Gemini call. Sets the session cookie.
- `app/api/session/report/route.ts` — binds the user-edited summary to the session after the review step.
- `app/api/medichatgemini/route.ts` — chat. Pipeline: redact question → `lib/query-guard.ts` (`refuse`/`clarify` return early; `answer` also yields a standalone rewritten question used for everything downstream; Gemini by default, `GUARD_PROVIDER=groq` uses Groq `GROQ_GUARD_MODEL` with a Gemini fallback) → semantic cache (`lib/cache.ts`: closest cached question; reused at cosine ≥ 0.99, between 0.94 and 0.99 only if `lib/cache-judge.ts` says the questions match, `CACHE_JUDGE_PROVIDER=groq` for Groq `openai/gpt-oss-20b`; the judge fails closed to a miss) → hybrid retrieval (`utils.ts`: one filtered Pinecone query feeds both dense (top 12) and BM25 (whole response, query plus the guard's `searchTerms` aliases), fused with RRF, filtered by `documentId`) → `lib/retrieval-grader.ts` (drops irrelevant chunks; `none` makes the model say the report lacks the info; Gemini by default, `GRADER_PROVIDER=groq` uses Groq `openai/gpt-oss-20b` with the same Gemini fallback) → Gemini generates (`generateText`, not streamed) with a `queryKnowledgeGraph` Neo4j tool → `lib/answer-checker.ts` checks the answer against excerpts + summary + graph lookups (Gemini by default; `JUDGE_PROVIDER=groq` uses Groq `openai/gpt-oss-120b`, falling back to Gemini on any Groq error; `partial` is revised, `unsupported` regenerated, one retry, then a fixed fallback; skipped for conversational turns) → cache write (verified answers only), transcript append, rehydrate PII from vault before returning.

Key invariants:

- **Session, not client ids.** `lib/session.ts` maps an HttpOnly `mf_sid` cookie to `{documentId, summary, transcript}` in Redis. The client never sees or sends `documentId`/`vaultId`; don't reintroduce them in request bodies or responses.
- **PII boundary.** `lib/pii-redaction.ts` replaces PII with `[TYPE_N]` tokens; the token→value vault is in Redis keyed by `documentId`. Everything sent to Gemini, Pinecone, Neo4j and the cache is redacted; rehydration happens only at the response edge. Trace spans use `safeInputs`/`phiGated`/`textShape` so raw text is recorded only when `LANGSMITH_TRACE_PHI=true`.
- **24h TTLs are aligned** across vault, response cache, ingest result and session — change them together.
- **Guard, grader and answer check fail open** on Gemini errors (`guardFailed`, ungraded pass-through, `checkFailed`) instead of throwing. An unchecked answer is sent but never cached.
- **Tracing:** wrap stages with `span(...)` from `lib/tracing.ts`; routes call `flushTraces()` on every exit path because serverless hosts freeze after the response.
- Server-only PDF deps (`pdf-parse`, `pdfjs-dist`, `@napi-rs/canvas`) are externalized and force-included via `outputFileTracingIncludes` in `next.config.mjs`; removing those entries breaks ingest in standalone builds.

Path alias `@/*` maps to this app directory (`@/utils` is root `utils.ts`, distinct from `lib/utils.ts` which only holds `cn`). UI is shadcn/ui (`components/ui/`); main client flow in `components/ReportComponent.tsx` (upload/review) and `components/chatcomponent.tsx` (`useChat`).

Code comments in this repo explain *why* at length (past bugs, trade-offs); preserve that context when editing.
