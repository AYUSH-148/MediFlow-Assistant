# MediFlow Assistant

MediFlow Assistant is a medical AI application that helps users upload clinical reports, extract key insights, and chat with the system using both document retrieval and graph-based knowledge relationships.

## What’s new

Recent updates include:

- Medical report ingestion and extraction using Gemini
- Structured JSON response handling for report summaries and entity triples
- PII redaction and vault-based recovery for sensitive medical data
- Neo4j-powered knowledge graph storage and relationship querying
- Enhanced chat responses that combine vector retrieval with graph context
- Redis-based caching for faster repeated queries

## Core features

- Upload and analyze clinical reports
- Extract structured medical information from reports
- Protect sensitive patient details with PII redaction
- Store and query entity relationships in Neo4j
- Ask follow-up questions in natural language with richer context

## Tech stack

- Next.js
- TypeScript
- Tailwind CSS
- Gemini AI
- Pinecone
- Neo4j
- Upstash Redis

## Environment variables

Create a local environment file with the required keys:

```bash
GEMINI_API_KEY=
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
```

## Vault retention and TTL

- `VAULT_TTL_SECONDS` (optional): controls how long PII vaults are kept in Redis, in seconds. By default the application uses a 14-day TTL (1209600 seconds). Increase this value if you want vaults to persist longer.
- Vaults are used to re-hydrate redacted PII tokens in generated summaries. If a vault expires, re-hydration will not occur and clients should re-run document extraction.
- For production deployments, consider your data retention and compliance requirements before extending the vault TTL.

## Getting started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open http://localhost:3000 to view the app.

## Notes

- Markdown files and docs are kept separate from the main app feature branch workflow.
- The graph-based features require Neo4j connectivity to be configured correctly.
