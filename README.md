# 🚑 MediFlow Assistant
AI-powered Medical Report Analyzer & Q&A Assistant

MediFlow Assistant is a medical intelligence application that helps users upload clinical reports, extract key insights, and ask follow-up questions using a combination of semantic retrieval, keyword retrieval, and graph-based reasoning. The current version combines Gemini-based extraction, PII redaction, Pinecone vector search, TF-IDF keyword search, Reciprocal Rank Fusion (RRF), and Neo4j knowledge graph context to deliver more relevant medical answers.

---

## 🧠 Features

### ➤ Medical Report Upload
- Upload PDFs or images of medical reports
- Extract text and structured insights using Gemini
- Detect key clinical findings, biomarkers, and treatment details

### ➤ Hybrid Retrieval for Better RAG
- Use Pinecone vector search for semantic similarity
- Add keyword-based retrieval with TF-IDF over the full indexed document set
- Filter out common filler words such as “and”, “the”, and “is” during keyword scoring
- Fuse vector and keyword rankings with Reciprocal Rank Fusion (RRF) to surface the most relevant passages

### ➤ Graph-Based Question Answering
- Ask questions about uploaded reports
- Combine retrieved evidence with Neo4j relationship context
- Improve answers with entity and relationship-aware reasoning

### ➤ Secure Medical Workflow
- Redact sensitive patient data before processing
- Store vault mappings for later rehydration when needed
- Support Neo4j-backed knowledge graph features

### ➤ Fast Chat UI
- Built with Next.js and the App Router
- Uses streaming responses for interactive chat
- Styled with Shadcn/ui and Tailwind CSS

---

## 🔎 Retrieval Workflow

The retrieval pipeline now works in three stages:

1. Semantic retrieval via Pinecone embeddings to find conceptually similar chunks
2. Keyword retrieval using TF-IDF to match important medical terms such as “kidney”, “heart”, or “disease”
3. Reciprocal Rank Fusion (RRF) to combine both rankings and return the strongest top-$k$ passages

This helps the system stay accurate when the wording of a user question does not exactly match the report text.

---

## 🧪 Example

If a user asks: “Does the patient have kidney and heart disease?”

The system can retrieve relevant evidence by combining:
- semantic similarity from vector search
- exact keyword matches such as “kidney”, “heart”, and “disease” through TF-IDF
- final ranking through Reciprocal Rank Fusion (RRF)

This makes the retrieval more robust when the question uses different wording than the source report.

---

## 🏗️ Tech Stack

| Component | Technology |
|----------|------------|
| Frontend | Next.js, Tailwind CSS, Shadcn/ui |
| AI Model | Google Gemini |
| Vector Search | Pinecone |
| Knowledge Graph | Neo4j |
| Keyword Search | BM25 (TF-IDF) |
| Cache / Vault | Upstash Redis |
| Runtime | Vercel Serverless |

---

## ⚙️ Environment Variables

Create a `.env.local` or `.env` file with the required values:

- GEMINI_API_KEY=
- PINECONE_API_KEY=
- PINECONE_INDEX_NAME=
- UPSTASH_REDIS_REST_URL=
- UPSTASH_REDIS_REST_TOKEN=
- NEO4J_URI=
- NEO4J_USER=
- NEO4J_PASSWORD=

---

## 🧪 Example Questions

- What is the diagnosis in this report?
- Why was the patient prescribed this medication?
- Summarize the report in simple words.
- What conditions or treatments are related to this finding?

---

## ⭐ Support
If you like this project, please star the repository to support development.
