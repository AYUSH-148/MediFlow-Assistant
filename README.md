# 🚑 MediFlow Assistant  
AI-powered Medical Report Analyzer & Q&A Assistant

MediFlow Assistant is a cutting-edge medical intelligence application that uses **Google Gemini**, **Pinecone**, **Hugging Face**, and **Next.js** to help users understand their medical reports.  
Upload PDFs or images → extract key medical information → ask questions → get accurate, personalized answers powered by **Retrieval Augmented Generation (RAG)**.

---

## 🧠 Features

### ➤ Medical Report Upload
- Upload PDFs or images of medical reports  
- Extract text using **Gemini Vision**  
- Automatically detect diagnosis, lab values, and treatment details  

### ➤ RAG-Powered Question Answering
- Ask any question about the uploaded report  
- Uses **Pinecone vector search** for retrieval  
- **Hugging Face embeddings** for semantic understanding  
- Gemini generates final medical-aware responses

### ➤ Fast Chat UI
- Built with **Next.js (App Router)**  
- Powered by **Vercel AI SDK** for streaming responses  
- Styled using **Shadcn/ui**

### ➤ Secure & Scalable
- Serverless deployment via **Vercel**  
- Sensitive data never permanently stored  
- Uses Pinecone Serverless for vector search

---

## 🏗️ Tech Stack

| Component | Technology |
|----------|------------|
| Frontend | Next.js, Shadcn/ui |
| AI Model | Google Gemini 2.x |
| Embeddings | Hugging Face Inference API |
| Vector Search | Pinecone Serverless |
| Runtime | Vercel Serverless / Edge |
| Streaming | Vercel AI SDK |

---

## ⚙️ Environment Variables

Create a `.env.local` file:

GEMINI_API_KEY=
PINECONE_API_KEY=
HF_TOKEN=

---
## 🧪 Sample Questions for Testing

- What is the diagnosis in this report?

- Explain the Troponin-I value.

- Why was the patient prescribed Aspirin?

- Summarize the report in simple words.

- Are the lab values normal for this patient?

---
## ⭐ Support
- If you like this project, please ⭐ the repository to support development!
