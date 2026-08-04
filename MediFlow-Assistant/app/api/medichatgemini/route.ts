import { generateDocumentId, queryPineconeVectorStore, pinecone, upsertConversationMemory } from "@/utils";
import {
    getCachedResponse,
    cacheResponse,
    hasConversationMemory,
    markConversationMemory,
} from "@/lib/cache";
import { redactUserQuestion, getVault, rehydrateText, queryNeo4jRelationships } from "@/lib/pii-redaction";
import { geminiModel } from "@/lib/gemini";
import { Pinecone } from "@pinecone-database/pinecone";
// import { Message, OpenAIStream, StreamData, StreamingTextResponse } from "ai";
import { Message, StreamData, streamText, tool, formatStreamPart } from "ai";
import { z } from "zod";

// Allow streaming responses up to 30 seconds
export const maxDuration = 60;
// export const runtime = 'edge';


// The main model calls this itself, mid-generation, instead of the route
// pre-fetching graph context for a fixed set of entities before every answer.
// Built per-request (not at module scope) so it can scope vault-token lookups
// (e.g. "[NAME_1]") to this specific document's vaultId.
function createQueryKnowledgeGraphTool(documentId?: string) {
    return tool({
        description:
            "Look up the known relationships for a single medical entity (a drug, condition, symptom, or treatment) " +
            "in the patient's knowledge graph. Call this when the report or user question references an entity whose " +
            "relationships (e.g. what it treats, interacts with, or is caused by) would help answer the question. " +
            "If a result surfaces another entity worth exploring (e.g. an interacting drug), call this tool again with " +
            "that entity name to follow the chain.",
        parameters: z.object({
            entity: z.string().describe("The exact medical entity name to look up, e.g. \"Aspirin\" or \"Hypertension\"."),
        }),
        execute: async ({ entity }) => {
            const relationships = await queryNeo4jRelationships([entity], documentId);
            if (!relationships || relationships.length === 0) {
                return { entity, relationships: [], message: `No known relationships found for "${entity}".` };
            }
            return { entity, relationships };
        },
    });
}

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

    // data is {} when the user chats without uploading a report.
    const reportData: string = reqBody.data?.reportData ?? "";
    const vaultId: string = reqBody.data?.vaultId ?? ""; // Get vault ID from request
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

    if (cachedAnswer) {
        // Cache HIT - return cached response (but re-hydrate it first)
        console.log("✅ Cache HIT! Re-hydrating cached response");

        // Get vault for re-hydration
        const vault = await getVault(vaultId);
        const rehydratedAnswer = vault ? rehydrateText(cachedAnswer, vault) : cachedAnswer;

        // Emit using the AI SDK data-stream protocol so useChat (default
        // streamProtocol: "data") can parse it — the same framing the
        // cache-MISS path produces via toDataStreamResponse(). Returning raw
        // text here means the client silently drops the response.
        const encoder = new TextEncoder();
        return new Response(
            new ReadableStream({
                start(controller) {
                    // Data annotation (code "2") — mirrors the miss-path data.append()
                    controller.enqueue(
                        encoder.encode(
                            formatStreamPart("data", [
                                { retrievals: "[CACHED_RESPONSE]", cacheHit: true },
                            ])
                        )
                    );
                    // Text part (code "0")
                    controller.enqueue(
                        encoder.encode(formatStreamPart("text", rehydratedAnswer))
                    );
                    // Finish message (code "d") so the client cleanly ends the turn
                    controller.enqueue(
                        encoder.encode(
                            formatStreamPart("finish_message", {
                                finishReason: "stop",
                                usage: { promptTokens: 0, completionTokens: 0 },
                            })
                        )
                    );
                    controller.close();
                },
            }),
            {
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "X-Vercel-AI-Data-Stream": "v1",
                    "X-Cache": "HIT",
                },
            }
        );
    }

    // Cache MISS - run normal flow
    console.log("❌ Cache MISS. Running full inference pipeline...");
    const data = new StreamData();
    const query = `Represent this for searching relevant passages: patient medical report says: \n${reportData}. \n\n${redactedQuestion}`;

    // Moved above the retrievals because the conversation-history query is built from
    // it, and both retrievals now start at the same time.
    const recentConversationHistory = messages.length > 1
        ? messages
            .slice(-4)
            .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${getMessageText(message.content)}`)
            .join("\n")
        : "No prior conversation history";

    // The conversation-history search is skipped unless this document actually has
    // stored memory to find. It used to run unconditionally, and in two common cases it
    // could only ever return "<nomatches>" - at the cost of one HuggingFace embedding
    // plus a topK 12 query and a topK 500 corpus pull:
    //
    //  - First turn on a freshly ingested report. upsertConversationMemory only runs
    //    after an answer completes, so nothing exists under this documentId yet.
    //  - No report uploaded. Memory is only ever WRITTEN when vaultId is set, so the
    //    user has none of their own to retrieve. Worse, reportFilter is undefined
    //    without a vaultId, so this search ran UNFILTERED across every document's chat
    //    memory - the only thing it could surface was other patients' conversations.
    //
    // `messages.length > 1` short-circuits the Redis lookup on every turn after the
    // first: a prior turn in this session already wrote memory. So the flag is only
    // read on the one turn where it can change the outcome.
    const shouldRetrieveMemory =
        !!vaultId && (messages.length > 1 || (await hasConversationMemory(vaultId)));

    // These two are independent, so they run concurrently. Each costs one HuggingFace
    // embedding - the slowest dependency in the pipeline - plus two Pinecone queries,
    // and awaiting them in sequence doubled retrieval wall-clock for nothing.
    // "<nomatches>" is the same sentinel queryPineconeVectorStore returns on an empty
    // result, so the prompt sees an identical memory section either way.
    const [retrievals, chatHistoryRetrievals] = await Promise.all([
        queryPineconeVectorStore(
            pinecone,
            'medic',
            "diagnosis2",
            query,
            reportFilter
        ),
        shouldRetrieveMemory
            ? queryPineconeVectorStore(
                pinecone,
                'medic',
                "conversation-history",
                `Find relevant prior conversation context for this follow-up question.\n\nCurrent question: ${redactedQuestion}\n\nRecent chat history:\n${recentConversationHistory}`,
                reportFilter
            )
            : Promise.resolve("<nomatches>"),
    ]);

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

  \n\nYou also have a queryKnowledgeGraph tool that looks up known relationships for a medical entity in the patient's knowledge graph. Call it when an entity mentioned in the report or query would benefit from that context, and call it again with a new entity if a result reveals something else worth following (e.g. an interacting drug). Skip it entirely if the question doesn't need graph context.

  \n\nProvide thorough justification for your answer.
  \n\n**Answer:**
  `;

    data.append({
        retrievals: retrievals,
        cacheHit: false,
    });

    const result = await streamText({
        model: geminiModel,
        prompt: finalPrompt,
        tools: { queryKnowledgeGraph: createQueryKnowledgeGraphTool(vaultId) },
        maxSteps: 5,
        onFinish(event) {
            // Surface why a generation produced no text (safety block, tool-only step, etc.).
            console.log(
                `🏁 Generation finished: finishReason=${event.finishReason} ` +
                `textLength=${event.text?.length ?? 0} toolCalls=${event.toolCalls?.length ?? 0}`
            );
            data.close();
            // Cache the response after generation completes (cache redacted version, no tool-call noise)
            if (event.text) {
                cacheResponse(redactedQuestion, event.text, reportData);
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

                    // Use the clean generated text (no data-stream framing or tool-call payloads) for memory
                    const cleanAnswerText = await result.text;

                    if (vaultId && cleanAnswerText) {
                        const memoryText = `User question: ${redactedQuestion}\nAssistant answer: ${cleanAnswerText}`;
                        await upsertConversationMemory(
                            pinecone,
                            "medic",
                            {
                                id: generateDocumentId(`${vaultId}:${redactedQuestion}:${cleanAnswerText}`),
                                documentId: vaultId,
                                text: memoryText,
                            }
                        );
                        // Marks this document as having memory worth searching, so the next
                        // turn's conversation-history retrieval is not skipped. Set
                        // unconditionally because upsertConversationMemory swallows its own
                        // failures and reports nothing back; the cost of being wrong here is
                        // one pointless retrieval, not a wrong answer.
                        await markConversationMemory(vaultId);
                    }

                    // If the model produced no text (safety block, tool-only turn, etc.) the
                    // data stream has no text part and the UI renders an empty bubble. Inject a
                    // fallback text part just before the stream's finish markers so the user sees
                    // a helpful message instead of a blank response.
                    let streamPayload = responseText;
                    if (!cleanAnswerText || !cleanAnswerText.trim()) {
                        console.warn("⚠️ Model returned empty text; injecting fallback message.");
                        const fallback =
                            "I couldn't generate an answer for that one. Please try rephrasing your " +
                            "question, or ask about a specific finding in the report (a medication, " +
                            "biomarker, or diagnosis).";
                        const fallbackPart = `0:${JSON.stringify(fallback)}`;
                        const lines = responseText.split("\n");
                        // Text parts must precede the finish-step (e:) / finish-message (d:) parts.
                        const finishIdx = lines.findIndex((l) => l.startsWith("d:") || l.startsWith("e:"));
                        if (finishIdx === -1) {
                            streamPayload = `${fallbackPart}\n${responseText}`;
                        } else {
                            lines.splice(finishIdx, 0, fallbackPart);
                            streamPayload = lines.join("\n");
                        }
                    }

                    // Re-hydrate the response with original PII
                    const vault = await getVault(vaultId);
                    const finalText = vault ? rehydrateText(streamPayload, vault) : streamPayload;
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
