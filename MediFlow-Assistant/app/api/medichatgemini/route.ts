import { generateDocumentId, queryPineconeVectorStore, pinecone, upsertConversationMemory } from "@/utils";
import { getCachedResponse, cacheResponse } from "@/lib/cache";
import { redactUserQuestion, getVault, rehydrateText, queryNeo4jRelationships } from "@/lib/pii-redaction";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
// import { Message, OpenAIStream, StreamData, StreamingTextResponse } from "ai";
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, Message, StreamData, streamText } from "ai";

// Allow streaming responses up to 30 seconds
export const maxDuration = 60;
// export const runtime = 'edge';

const google = createGoogleGenerativeAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GEMINI_API_KEY
});
const model = google('models/gemini-2.5-flash', {
    safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ],
});

const geminiExtractor = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const extractorModel = geminiExtractor.getGenerativeModel({
    model: 'gemini-2.5-flash',
});

function getMessageText(content: Message["content"]): string {
    const rawContent = content as unknown;

    if (typeof rawContent === "string") return rawContent;
    if (Array.isArray(rawContent)) {
        return rawContent
            .map((part) => {
                if (typeof part === "string") return part;
                if (typeof part === "object" && part !== null && "text" in part) {
                    return String((part as { text?: unknown }).text ?? "");
                }
                return "";
            })
            .join(" ");
    }

    return "";
}

export async function POST(req: Request, res: Response) {
    const reqBody = await req.json();
    console.log(reqBody);

    const messages: Message[] = reqBody.messages;
    const latestMessage = messages[messages.length - 1];
    const userQuestion = getMessageText(latestMessage?.content ?? "");

    const reportData: string = reqBody.data.reportData;
    const vaultId: string = reqBody.data.vaultId; // Get vault ID from request
    const reportFilter = vaultId ? { documentId: { $eq: vaultId } } : undefined;

    // ==================== PII REDACTION ====================
    console.log("🔒 Applying PII redaction to user question...");

    // Redact PII from user question using same patterns
    const redactedQuestion = redactUserQuestion(userQuestion);
    console.log(`📝 Original: "${userQuestion}"`);
    console.log(`📝 Redacted: "${redactedQuestion}"`);

    // ==================== SEMANTIC CACHING ====================
    // Step 1: Check if a similar question exists in cache (using redacted question)
    console.log("🔍 Checking semantic cache for similar questions...");
    const cachedAnswer = await getCachedResponse(redactedQuestion, reportData, 0.95);

    const data = new StreamData();

    if (cachedAnswer) {
        // Cache HIT - return cached response (but re-hydrate it first)
        console.log("✅ Cache HIT! Re-hydrating cached response");

        // Get vault for re-hydration
        const vault = await getVault(vaultId);
        const rehydratedAnswer = vault ? rehydrateText(cachedAnswer, vault) : cachedAnswer;

        data.append({
            retrievals: "[CACHED_RESPONSE]",
            cacheHit: true,
        });
        data.close();

        // Return re-hydrated cached response as stream
        const encoder = new TextEncoder();
        return new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(rehydratedAnswer));
                    controller.close();
                },
            }),
            {
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "X-Cache": "HIT",
                },
            }
        );
    }

    // Cache MISS - run normal flow
    console.log("❌ Cache MISS. Running full inference pipeline...");
    const query = `Represent this for searching relevant passages: patient medical report says: \n${reportData}. \n\n${redactedQuestion}`;

    const retrievals = await queryPineconeVectorStore(
        pinecone,
        'medic',
        "diagnosis2",
        query,
        reportFilter
    );

    const recentConversationHistory = messages.length > 1
        ? messages
            .slice(-4)
            .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${getMessageText(message.content)}`)
            .join("\n")
        : "No prior conversation history";

    const chatHistoryRetrievals = await queryPineconeVectorStore(
        pinecone,
        'medic',
        "conversation-history",
        `Find relevant prior conversation context for this follow-up question.\n\nCurrent question: ${redactedQuestion}\n\nRecent chat history:\n${recentConversationHistory}`,
        reportFilter
    );

    // ==================== GRAPH QUERYING ====================
    console.log("🔗 Querying Neo4j for entity relationships...");
    let graphData = "";
    try {
        const entities = await extractEntitiesFromQuestion(redactedQuestion);
        if (entities.length > 0) {
            const relationships = await queryNeo4jRelationships(entities);
            if (relationships && relationships.length > 0) {
                graphData = `Entity Relationships: ${JSON.stringify(relationships)}\n`;
                console.log("✅ Found relationships in graph");
            } else {
                console.log("❌ No relationships found in graph");
            }
        } else {
            console.log("⚠️ No entities extracted for graph query");
        }
    } catch (error) {
        console.error("Failed to query Neo4j:", error);
        // Continue without graph data
    }

    const finalPrompt = `Here is a summary of a patient's clinical report, and a user query. Some generic clinical findings are also provided that may or may not be relevant for the report.
  Go through the clinical report and answer the user query.
  Ensure the response is factually accurate, and demonstrates a thorough understanding of the query topic and the clinical report.
  Before answering you may enrich your knowledge by going through the provided clinical findings.
  The clinical findings are generic insights and not part of the patient's medical report. Do not include any clinical finding if it is not relevant for the patient's case.

  \n\n**Patient's Clinical report summary:** \n${reportData}.
  \n**end of patient's clinical report**

  \n\n**User Query:**\n${redactedQuestion}?
  \n**end of user query**

  \n\n**Generic Clinical findings:**
  \n\n${retrievals}.
  \n\n**end of generic clinical findings**

  \n\n**Relevant conversation memory:**
  \n\n${chatHistoryRetrievals}
  \n\n**end of relevant conversation memory**

  \n\n**Recent conversation history from this session:**
  \n\n${recentConversationHistory}
  \n\n**end of recent conversation history**

  \n\n**Entity Relationships from Knowledge Graph:**
  \n\n${graphData}
  \n\n**end of entity relationships**

  \n\nProvide thorough justification for your answer.
  \n\n**Answer:**
  `;

    data.append({
        retrievals: retrievals,
        cacheHit: false,
    });

    let fullResponse = "";

    const result = await streamText({
        model: model,
        prompt: finalPrompt,
        onFinish() {
            data.close();
            // Cache the response after generation completes (cache redacted version)
            if (fullResponse) {
                cacheResponse(redactedQuestion, fullResponse, reportData);
            }
        }
    });

    // Capture the full response text
    const originalStream = result.toDataStreamResponse({ data });

    // We need to intercept and buffer the response to cache and re-hydrate it
    if (originalStream.body) {
        const reader = originalStream.body.getReader();
        const chunks: Uint8Array[] = [];

        const newStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value) {
                            chunks.push(value);
                        }
                    }

                    // Combine chunks into full response
                    const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    const responseText = new TextDecoder().decode(combined);

                    // Store full response for caching
                    fullResponse = responseText;

                    if (vaultId && fullResponse) {
                        const memoryText = `User question: ${redactedQuestion}\nAssistant answer: ${fullResponse}`;
                        await upsertConversationMemory(
                            pinecone,
                            "medic",
                            {
                                id: generateDocumentId(`${vaultId}:${redactedQuestion}:${fullResponse}`),
                                documentId: vaultId,
                                text: memoryText,
                            }
                        );
                    }

                    // Re-hydrate the response with original PII
                    const vault = await getVault(vaultId);
                    const finalText = vault ? rehydrateText(responseText, vault) : responseText;
                    if (vault) {
                        console.log("🔄 Re-hydrated response with original PII");
                    }

                    controller.enqueue(new TextEncoder().encode(finalText));
                } catch (error) {
                    console.error("Error rehydrating response:", error);
                    controller.enqueue(new TextEncoder().encode("An error occurred while generating the response."));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(newStream, {
            headers: originalStream.headers,
        });
    }

    return originalStream;
}

// Extract entities from user question using Gemini for semantic understanding
async function extractEntitiesFromQuestion(question: string): Promise<string[]> {
    const prompt = `Extract the medical entities (drugs, conditions, symptoms) from the following user question.\nReturn ONLY a JSON array of strings representing the entities. Do not include markdown formatting.\n\nUser Question: "${question}"\n`;

    try {
        const generatedContent = await extractorModel.generateContent([prompt]);
        const rawText = generatedContent.response.candidates?.[0].content.parts?.[0].text;
        if (!rawText) {
            throw new Error('No response text from Gemini entity extraction');
        }

        const parsed = JSON.parse(rawText.trim());
        if (Array.isArray(parsed)) {
            return parsed.map((entity) => String(entity).trim()).filter((entity) => entity.length > 0);
        }
        throw new Error('Gemini entity extraction returned unexpected format');
    } catch (error) {
        console.error('Gemini entity extraction failed, falling back to heuristic extraction:', error);
        // Fallback to the original heuristic extraction
        const words = question.split(/\s+/);
        const entities = words.filter((word) =>
            word.length > 2 &&
            word[0] === word[0].toUpperCase() &&
            !['What', 'How', 'Why', 'When', 'Where', 'Who', 'Is', 'Are', 'Does'].includes(word)
        );
        return entities.slice(0, 2);
    }
}

