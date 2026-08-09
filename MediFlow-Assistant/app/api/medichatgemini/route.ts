import { generateDocumentId, queryPineconeVectorStore, pinecone, upsertConversationMemory } from "@/utils";
import {
    getCachedResponse,
    cacheResponse,
    hasConversationMemory,
    markConversationMemory,
} from "@/lib/cache";
import {
    redactUserQuestion,
    getVault,
    rehydrateText,
    queryNeo4jRelationships,
    findVaultTokens,
} from "@/lib/pii-redaction";
import { geminiModel, GEMINI_MODEL_ID } from "@/lib/gemini";
import { Message, StreamData, streamText, tool, formatStreamPart } from "ai";
import { z } from "zod";
import {
    span,
    setSpanMetadata,
    startSpan,
    startLlmSpan,
    endLlmSpan,
    runInSpan,
    flushTraces,
    textShape,
    phiGated,
    type ManualSpan,
} from "@/lib/tracing";

export const maxDuration = 60;

// Built per request so vault-token lookups (e.g. "[NAME_1]") can be scoped to this
// document's vaultId. The model decides when to call it, mid-generation, rather than
// the route pre-fetching graph context for a fixed set of entities.
function createQueryKnowledgeGraphTool(documentId?: string, llmSpan?: ManualSpan | null) {
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
            // Attached to the LLM span explicitly rather than via span(): the AI SDK runs
            // tool execution from inside stream consumption, where the async context that
            // would nest it automatically is not guaranteed to survive.
            const toolSpan =
                llmSpan?.child(
                    "query_knowledge_graph",
                    "tool",
                    phiGated(
                        { entity, documentId: documentId ?? null },
                        { documentId: documentId ?? null, ...textShape("entity", entity) }
                    )
                ) ?? null;

            try {
                const relationships = await queryNeo4jRelationships([entity], documentId);
                if (!relationships || relationships.length === 0) {
                    const empty = {
                        entity,
                        relationships: [],
                        message: `No known relationships found for "${entity}".`,
                    };
                    await toolSpan?.succeed({
                        relationshipCount: 0,
                        found: false,
                        ...phiGated({ ...empty }, textShape("entity", entity)),
                    });
                    return empty;
                }
                await toolSpan?.succeed({
                    relationshipCount: relationships.length,
                    found: true,
                    ...phiGated(
                        { entity, relationships },
                        textShape("entity", entity)
                    ),
                });
                return { entity, relationships };
            } catch (error) {
                await toolSpan?.fail(error);
                throw error;
            }
        },
    });
}

// Concatenates the text parts ("0:" lines) of a data-stream payload back into the string
// the client renders.
//
// Rehydration runs over the framed payload, so a token the model streamed across a chunk
// boundary is physically split by framing - `0:"Patient [NAME"` / `0:"_1] has..."` - and
// rehydrateText's literal split/join cannot match it. Reassembling heals the split, so a
// token found here but not in the raw payload identifies exactly that case.
function reassembleTextParts(payload: string): string {
    return payload
        .split("\n")
        .filter((line) => line.startsWith("0:"))
        .map((line) => {
            try {
                const decoded: unknown = JSON.parse(line.slice(2));
                return typeof decoded === "string" ? decoded : "";
            } catch {
                // A part split mid-escape leaves unparseable JSON; the raw body still lets
                // a token spanning the boundary be found.
                return line.slice(2);
            }
        })
        .join("");
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

    const messages: Message[] = reqBody.messages;
    const latestMessage = messages[messages.length - 1];
    const userQuestion = getMessageText(latestMessage?.content ?? "");

    // `data` is {} when the user chats without uploading a report.
    const reportData: string = reqBody.data?.reportData ?? "";
    const vaultId: string = reqBody.data?.vaultId ?? "";

    // Managed by hand because the request does not finish when the Response is returned:
    // on a cache miss the remaining work (buffering, memory write, rehydration) runs in a
    // ReadableStream `start` callback the runtime invokes afterwards. A callback-scoped
    // root would close too early and orphan every span opened after it.
    const root = startSpan({
        name: "chat",
        runType: "chain",
        inputs: {
            question: userQuestion,
            vaultId,
            hasReport: !!reportData,
            messageCount: messages.length,
        },
        safeInputs: {
            ...textShape("question", userQuestion),
            vaultId,
            hasReport: !!reportData,
            messageCount: messages.length,
        },
        tags: ["chat", vaultId ? "with-report" : "no-report"],
    });

    try {
        return await runInSpan(root, () =>
            handleChat({ root, messages, userQuestion, reportData, vaultId })
        );
    } catch (error) {
        // Each success path closes the root span itself, at a different point in the
        // request, so this only handles an unexpected throw.
        root?.setMetadata({ outcome: "error" });
        await root?.fail(error);
        await flushTraces();
        throw error;
    }
}

async function handleChat({
    root,
    messages,
    userQuestion,
    reportData,
    vaultId,
}: {
    root: ManualSpan | null;
    messages: Message[];
    userQuestion: string;
    reportData: string;
    vaultId: string;
}): Promise<Response> {
    const reportFilter = vaultId ? { documentId: { $eq: vaultId } } : undefined;

    // Raw question in, placeholder question out, so both sides of the boundary are gated.
    const redactedQuestion = await span(
        "redact_question",
        { question: userQuestion },
        async () => {
            const redacted = redactUserQuestion(userQuestion);
            setSpanMetadata({
                inputChars: userQuestion.length,
                redactedChars: redacted.length,
                // Any change at all means PII reached the endpoint.
                piiFound: redacted !== userQuestion,
            });
            return redacted;
        },
        {
            runType: "chain",
            tags: ["redaction", "pii-boundary"],
            safeInputs: textShape("question", userQuestion),
            safeOutputs: (redacted) => textShape("redactedQuestion", redacted),
            // Names the field the same in both modes, so the gated and raw paths compare.
            recordOutputs: (redacted) => ({ redactedQuestion: redacted }),
        }
    );

    const cachedAnswer = await getCachedResponse(redactedQuestion, reportData, 0.95);

    if (cachedAnswer) {
        const vault = await getVault(vaultId);
        const rehydratedAnswer = await span(
            "rehydrate_cached_answer",
            { text: cachedAnswer, vaultId },
            async () => {
                const output = vault ? rehydrateText(cachedAnswer, vault) : cachedAnswer;
                // No framing case here - a cached answer is stored as plain text, so there
                // are no chunk boundaries to split a token. A survivor usually means the
                // vault expired while the 24h response cache entry outlived it.
                const surviving = findVaultTokens(output);
                setSpanMetadata({
                    vaultFound: !!vault,
                    changed: output !== cachedAnswer,
                    tokensRestored: vault ? Object.keys(vault).length : 0,
                    tokensSurvivingRehydration: surviving.length,
                    tokensSurvivingLabels: surviving,
                    rehydrationIncomplete: surviving.length > 0,
                });
                if (surviving.length > 0) {
                    console.warn(
                        `${surviving.length} vault token(s) survived rehydration of a cached ` +
                        `answer (vault likely expired before the cache entry): ${surviving.join(", ")}`
                    );
                }
                return output;
            },
            {
                runType: "chain",
                tags: ["rehydration", "pii-boundary", "cache-hit"],
                safeInputs: { ...textShape("text", cachedAnswer), vaultId },
                safeOutputs: (output) => textShape("rehydratedAnswer", output),
                recordOutputs: (output) => ({ rehydratedAnswer: output }),
            }
        );

        // This path completes before the Response is returned, so the root span closes here.
        root?.setMetadata({ outcome: "cache-hit", cacheHit: true });
        await root?.succeed(
            phiGated({ answer: rehydratedAnswer }, textShape("answer", rehydratedAnswer))
        );
        await flushTraces();

        // Emitted in the AI SDK data-stream protocol so useChat (default streamProtocol:
        // "data") can parse it - the same framing toDataStreamResponse() produces on the
        // miss path. Returning raw text here makes the client silently drop the response.
        const encoder = new TextEncoder();
        return new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            formatStreamPart("data", [
                                { retrievals: "[CACHED_RESPONSE]", cacheHit: true },
                            ])
                        )
                    );
                    controller.enqueue(
                        encoder.encode(formatStreamPart("text", rehydratedAnswer))
                    );
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

    root?.setMetadata({ cacheHit: false });
    const data = new StreamData();
    const query = `Represent this for searching relevant passages: patient medical report says: \n${reportData}. \n\n${redactedQuestion}`;

    const recentConversationHistory = messages.length > 1
        ? messages
            .slice(-4)
            .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${getMessageText(message.content)}`)
            .join("\n")
        : "No prior conversation history";

    // The conversation-history search is skipped unless this document actually has stored
    // memory to find, since it costs a HuggingFace embedding plus a topK 12 query and a
    // topK 500 corpus pull to return "<nomatches>". Two cases where it can only ever miss:
    // the first turn on a freshly ingested report (memory is written only after an answer
    // completes), and a chat with no report at all (memory is only ever written when
    // vaultId is set, and without one reportFilter is undefined - so the search ran
    // unfiltered across every document's chat memory).
    //
    // `messages.length > 1` short-circuits the Redis lookup after the first turn, since a
    // prior turn in this session already wrote memory.
    const shouldRetrieveMemory =
        !!vaultId && (messages.length > 1 || (await hasConversationMemory(vaultId)));

    // Independent, so they run concurrently; awaiting them in sequence doubled retrieval
    // wall-clock for nothing. "<nomatches>" is the same sentinel queryPineconeVectorStore
    // returns on an empty result, so the prompt sees an identical memory section either way.
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

    // A skipped retrieval simply has no span, so the skip is otherwise invisible.
    root?.setMetadata({ memoryRetrievalSkipped: !shouldRetrieveMemory });

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

    // Opened before streamText and closed in the stream callback below: usage and finish
    // reason only settle once the stream drains, but the route needs the stream object
    // back immediately. `parent` is explicit because async context does not survive into
    // that later callback.
    const llmSpan = startLlmSpan({
        name: "generate_answer",
        model: GEMINI_MODEL_ID,
        parent: root,
        inputs: { prompt: finalPrompt },
        safeInputs: textShape("prompt", finalPrompt),
        tags: ["gemini", "generation"],
        metadata: { maxSteps: 5, tools: ["queryKnowledgeGraph"] },
    });

    // Captured in onFinish and applied after buffering, so the span always closes before
    // the trace is flushed.
    let generation: {
        finishReason?: string;
        usage?: { promptTokens?: number; completionTokens?: number };
        text?: string;
        toolCalls?: unknown[];
        stepCount?: number;
    } | null = null;

    // The LLM span can be closed from four places (success, streamText rejecting, the
    // buffering loop failing, the no-body fallback). Closing it twice would patch a
    // finished run, so the first one wins.
    let llmSettled = false;
    const settleLlmSpan = async (close: () => Promise<void>) => {
        if (llmSettled) return;
        llmSettled = true;
        await close();
    };

    // A closure rather than `let` + try/catch so the tool-typed return of streamText stays
    // inferred - annotating it widens the tool map and breaks result.toolResults.
    const startGeneration = async () => {
      try {
        return await streamText({
            model: geminiModel,
            prompt: finalPrompt,
            tools: { queryKnowledgeGraph: createQueryKnowledgeGraphTool(vaultId, llmSpan) },
            maxSteps: 5,
            onFinish(event) {
                generation = {
                    finishReason: event.finishReason,
                    usage: event.usage,
                    text: event.text,
                    // event.toolCalls describes the FINAL step only, so a generation that
                    // called the knowledge graph and then answered reports zero tool calls.
                    // Summing across steps is the real count.
                    toolCalls: event.steps
                        ? event.steps.flatMap((step) => step.toolCalls ?? [])
                        : event.toolCalls,
                    stepCount: event.steps?.length,
                };
                data.close();
                // Cache the redacted text, without tool-call noise.
                if (event.text) {
                    cacheResponse(redactedQuestion, event.text, reportData);
                }
            }
        });
      } catch (error) {
        // streamText rejects outright on auth, quota (429) and network failures, and the
        // stream callback that normally closes the LLM span never runs in that case.
        await settleLlmSpan(async () => {
          await llmSpan?.fail(error);
        });
        throw error;
      }
    };

    const result = await startGeneration();

    const originalStream = result.toDataStreamResponse({ data });

    // The response is buffered so it can be cached and re-hydrated before it reaches the
    // client.
    if (originalStream.body) {
        const reader = originalStream.body.getReader();
        const chunks: Uint8Array[] = [];

        const newStream = new ReadableStream({
            async start(controller) {
                // The runtime invokes this after POST has returned, so the request's async
                // context is gone. runInSpan re-establishes the root span as the parent.
                await runInSpan(root, async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            if (value) {
                                chunks.push(value);
                            }
                        }

                        const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
                        let offset = 0;
                        for (const chunk of chunks) {
                            combined.set(chunk, offset);
                            offset += chunk.length;
                        }
                        const responseText = new TextDecoder().decode(combined);

                        // The generated text without data-stream framing or tool-call payloads.
                        const cleanAnswerText = await result.text;

                        // Generation is complete by now, so the LLM span closes with its
                        // token usage before anything downstream runs.
                        await settleLlmSpan(() =>
                            endLlmSpan(llmSpan, generation ?? { text: cleanAnswerText })
                        );

                        if (vaultId && cleanAnswerText) {
                            const memoryText = `User question: ${redactedQuestion}\nAssistant answer: ${cleanAnswerText}`;
                            const memoryResult = await upsertConversationMemory(
                                pinecone,
                                "medic",
                                {
                                    id: generateDocumentId(`${vaultId}:${redactedQuestion}:${cleanAnswerText}`),
                                    documentId: vaultId,
                                    text: memoryText,
                                }
                            );
                            // Marks this document as having memory worth searching, so the
                            // next turn's retrieval is not skipped. Gated on a confirmed
                            // write because upsertConversationMemory swallows its own
                            // failures and reports them via `stored`.
                            if (memoryResult.stored) {
                                await markConversationMemory(vaultId);
                            }
                        }

                        // With no text (safety block, tool-only turn) the data stream has no
                        // text part and the UI renders an empty bubble. Inject a fallback
                        // part just before the finish markers instead.
                        let streamPayload = responseText;
                        if (!cleanAnswerText || !cleanAnswerText.trim()) {
                            console.warn("Model returned empty text; injecting fallback message.");
                            root?.setMetadata({ emptyGeneration: true });
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

                        const vault = await getVault(vaultId);
                        const finalText = await span(
                            "rehydrate_answer",
                            { text: streamPayload, vaultId },
                            async () => {
                                const output = vault ? rehydrateText(streamPayload, vault) : streamPayload;

                                // Tokens still intact in the framed payload: the vault did not
                                // cover them (expired, partial, or never written).
                                const survivingInPayload = findVaultTokens(output);
                                // Tokens visible only once framing is removed: a stream chunk
                                // boundary fell inside the token. Same symptom, different cause.
                                const survivingInAnswer = findVaultTokens(reassembleTextParts(output));
                                const splitByFraming = survivingInAnswer.filter(
                                    (token) => !survivingInPayload.includes(token)
                                );

                                setSpanMetadata({
                                    vaultFound: !!vault,
                                    changed: output !== streamPayload,
                                    tokensRestored: vault ? Object.keys(vault).length : 0,
                                    // A vault that exists but changes nothing means the answer
                                    // had no placeholders in it - which is also how an
                                    // un-redacted identifier reaching the client would look.
                                    vaultPresentButUnused: !!vault && output === streamPayload,
                                    // Labels only, never the values behind them.
                                    tokensSurvivingRehydration: survivingInPayload.length,
                                    tokensSurvivingLabels: survivingInPayload,
                                    tokensSplitByFraming: splitByFraming.length,
                                    tokensSplitByFramingLabels: splitByFraming,
                                    // The single field to alert on: by either route, a
                                    // placeholder reached the client.
                                    rehydrationIncomplete:
                                        survivingInPayload.length > 0 || splitByFraming.length > 0,
                                });

                                if (survivingInPayload.length > 0) {
                                    console.warn(
                                        `${survivingInPayload.length} vault token(s) survived rehydration ` +
                                        `(vault did not cover them): ${survivingInPayload.join(", ")}`
                                    );
                                }
                                if (splitByFraming.length > 0) {
                                    console.warn(
                                        `${splitByFraming.length} vault token(s) were split across stream ` +
                                        `chunks and could not be rehydrated: ${splitByFraming.join(", ")}`
                                    );
                                }

                                return output;
                            },
                            {
                                runType: "chain",
                                tags: ["rehydration", "pii-boundary"],
                                safeInputs: { ...textShape("text", streamPayload), vaultId },
                                safeOutputs: (output) => textShape("finalText", output),
                                recordOutputs: (output) => ({ finalText: output }),
                            }
                        );

                        controller.enqueue(new TextEncoder().encode(finalText));

                        root?.setMetadata({ outcome: "ok" });
                        await root?.succeed(
                            phiGated(
                                { answer: cleanAnswerText },
                                textShape("answer", cleanAnswerText)
                            )
                        );
                    } catch (error) {
                        console.error("Error rehydrating response:", error);
                        controller.enqueue(new TextEncoder().encode("An error occurred while generating the response."));
                        // The buffering loop can fail before the success path settles the
                        // LLM span; a no-op if it already closed.
                        await settleLlmSpan(async () => {
                            await llmSpan?.fail(error);
                        });
                        root?.setMetadata({ outcome: "stream-error" });
                        await root?.fail(error);
                    } finally {
                        controller.close();
                        // Last chance to get this request's spans off the box: nothing runs
                        // after the stream closes, and a serverless host may freeze the
                        // function immediately.
                        await flushTraces();
                    }
                });
            },
        });

        return new Response(newStream, {
            headers: originalStream.headers,
        });
    }

    // No response body to buffer, so the stream callback that normally closes the root
    // span never runs. Closing it here keeps the trace from staying open forever.
    await settleLlmSpan(() => endLlmSpan(llmSpan, generation ?? {}));
    root?.setMetadata({ outcome: "no-stream-body" });
    await root?.succeed({ note: "response had no body to buffer" });
    await flushTraces();

    return originalStream;
}
