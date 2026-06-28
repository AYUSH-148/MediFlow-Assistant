# 🚑 MediFlow Assistant
AI-powered Medical Report Analyzer & Q&A Assistant

MediFlow Assistant is a medical intelligence application that helps users upload clinical reports, extract key insights, and ask follow-up questions using both retrieval and graph-based reasoning. The current version combines Gemini-based extraction, PII redaction, Neo4j knowledge graph storage, and response generation for richer medical assistance.

---

## 🧠 Features

### ➤ Medical Report Upload
- Upload PDFs or images of medical reports
- Extract text and structured insights using Gemini
- Detect key clinical findings, biomarkers, and treatment details

### ➤ RAG + Graph-Based Question Answering
- Ask questions about uploaded reports
- Combine Pinecone vector retrieval with Neo4j relationship context
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

## 🏗️ Tech Stack

| Component | Technology |
|----------|------------|
| Frontend | Next.js, Tailwind CSS, Shadcn/ui |
| AI Model | Google Gemini |
| Vector Search | Pinecone |
| Knowledge Graph | Neo4j |
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
