import {
    generateDocumentId,
    queryPineconeVectorStore,
    queryPineconeVectorStoreDetailed,
    pinecone,
    upsertConversationMemory,
} from "@/utils";
import { gradeRetrieval, buildGroundingInstruction } from "@/lib/retrieval-grader";
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
import {
    APICallError,
    Message,
    RetryError,
    StreamData,
    streamText,
    tool,
    formatStreamPart,
    type JSONValue,
} from "ai";
import { z } from "zod";
import { guardQuestion } from "@/lib/query-guard";
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

// Emit a ready-made answer in the AI SDK data-stream protocol so useChat (default
// streamProtocol: "data") can parse it - the same framing toDataStreamResponse()
// produces on the generation path. Returning raw text here makes the client silently
// drop the response.
//
// Shared by the cache-hit path and the query guard: both have their answer in hand and
// nothing to stream from a model.
function streamStaticAnswer(
    text: string,
    options: { annotation?: JSONValue; headers?: Record<string, string> } = {}
): Response {
    const encoder = new TextEncoder();

    return new Response(
        new ReadableStream({
            start(controller) {
                // Data annotation (code "2"). Omitted for guard replies: there are no
                // retrievals behind them, and the client opens its "Relevant Info"
                // accordion for any non-empty data.
                if (options.annotation !== undefined) {
                    controller.enqueue(
                        encoder.encode(formatStreamPart("data", [options.annotation]))
                    );
                }
                // Text part (code "0")
                controller.enqueue(encoder.encode(formatStreamPart("text", text)));
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
                ...options.headers,
            },
        }
    );
}

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

/**
 * Turn a failed turn into a response the client can actually show.
 *
 * Re-throwing left Next to return a bare 500 with no body. useChat throws
 * `new Error(await response.text())` on a non-ok response, so an empty body produced an
 * empty error message - and with `keepLastMessageOnError` defaulting to false in this
 * version of the SDK, the same failure rolled the user's own message back out of the
 * transcript. The question vanished with nothing on screen to explain it.
 *
 * A status plus a plain-text body fixes both halves: the text becomes `error.message` for
 * the client to render, and the status stays honest so a failure is still a failure to
 * anything watching the route. The generation path now degrades visibly, the way the
 * guard path already did.
 */
function generationErrorResponse(error: unknown): Response {
    // Only the upstream status is read, never the provider's message: it can quote the
    // prompt back, and on this route the prompt contains report text.
    const upstreamStatus = APICallError.isInstance(error)
        ? error.statusCode
        : RetryError.isInstance(error) && APICallError.isInstance(error.lastError)
          ? error.lastError.statusCode
          : undefined;

    // 401/403 is a deployment misconfiguration - not something the reader did or can fix -
    // so it reads as a generic outage rather than as "unauthorized".
    const { status, reason, message } =
        upstreamStatus === 429
            ? {
                  status: 429,
                  reason: "rate-limited",
                  message:
                      "The assistant is over its request limit right now. Your question is " +
                      "still here - try again in a minute.",
              }
            : upstreamStatus !== undefined && upstreamStatus >= 500
              ? {
                    status: 502,
                    reason: "upstream",
                    message:
                        "The model provider is having trouble right now. Your question is " +
                        "still here - try sending it again.",
                }
              : {
                    status: 500,
                    reason: "internal",
                    message:
                        "Something went wrong answering that. Your question is still here - " +
                        "try sending it again.",
                };

    return new Response(message, {
        status,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            // Lets a network tab or an uptime check tell the three apart without parsing prose.
            "X-Chat-Error": reason,
        },
    });
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
        //
        // The trace keeps the real error; only the client-facing body is sanitised.
        // Returning rather than re-throwing is what makes the failure visible at all.
        console.error("Chat request failed:", error);
        root?.setMetadata({ outcome: "error" });
        await root?.fail(error);
        await flushTraces();
        return generationErrorResponse(error);
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

    // Needed by the guard below, so it is built before anything else runs.
    const recentConversationHistory = messages.length > 1
        ? messages
            .slice(-4)
            .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${getMessageText(message.content)}`)
            .join("\n")
        : "No prior conversation history";

    // Deliberately ahead of the cache lookup, for two reasons.
    //
    // Refusals and clarifications return from here, which puts retrieval, the cache write
    // and the memory write on an unreachable branch. Nothing downstream needs a flag
    // threaded through it to suppress them - an off-topic question never gets that far.
    //
    // And the cache keys on question text alone, so a context-dependent follow-up like
    // "is that bad?" was stored under a key that said nothing about what "that" referred
    // to, then replayed for a later unrelated follow-up. Resolving the question to a
    // standalone form FIRST makes the key self-describing, fixing that collision without
    // hashing conversation history into the key.
    // The summary itself goes in, not `!!reportData`. A boolean cannot distinguish an
    // ambiguous question from a broad one, which is how "what is the problem with the
    // patient?" ended up in a clarify loop with the answer sitting in this very variable.
    const guard = await guardQuestion({
        question: redactedQuestion,
        history: recentConversationHistory,
        reportSummary: reportData,
    });

    // Recorded on the root span, not just the guard's own, because a fail-open outage
    // returns "answer" and is otherwise invisible from the top of the trace - the turn
    // simply looks like an ordinary unguarded one.
    root?.setMetadata({ guardIntent: guard.intent, guardFailed: guard.guardFailed });

    if (guard.intent !== "answer") {
        // Like the cache-hit path, this completes before the Response is returned, so the
        // root span closes and flushes here rather than in the stream callback.
        root?.setMetadata({ outcome: guard.intent, cacheHit: false, guardShortCircuit: true });
        await root?.succeed(
            phiGated({ reply: guard.reply }, { intent: guard.intent, ...textShape("reply", guard.reply) })
        );
        await flushTraces();

        return streamStaticAnswer(guard.reply, {
            headers: { "X-Guard-Intent": guard.intent },
        });
    }

    // Every downstream stage uses the resolved question rather than the raw one: the cache
    // key, both retrieval queries, the prompt, and the stored memory. That is what stops
    // "is that bad?" being written to memory as a dangling pronoun.
    const effectiveQuestion = guard.resolvedQuestion;

    const cachedAnswer = await getCachedResponse(effectiveQuestion, reportData, 0.95);

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

        return streamStaticAnswer(rehydratedAnswer, {
            annotation: { retrievals: "[CACHED_RESPONSE]", cacheHit: true },
            headers: { "X-Cache": "HIT" },
        });
    }

    root?.setMetadata({ cacheHit: false });
    const data = new StreamData();
    const query = `Represent this for searching relevant passages: patient medical report says: \n${reportData}. \n\n${effectiveQuestion}`;

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
    const [reportRetrieval, chatHistoryRetrievals] = await Promise.all([
        queryPineconeVectorStoreDetailed(
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
                `Find relevant prior conversation context for this follow-up question.\n\nCurrent question: ${effectiveQuestion}\n\nRecent chat history:\n${recentConversationHistory}`,
                reportFilter
            )
            : Promise.resolve("<nomatches>"),
    ]);

    // A skipped retrieval simply has no span, so the skip is otherwise invisible.
    root?.setMetadata({ memoryRetrievalSkipped: !shouldRetrieveMemory });

    // Corrective-RAG grading. Retrieval hands back its top 10 chunks whether or not they
    // bear on the question, so without this the generator receives padding labelled as
    // evidence and has only a politely-worded prompt line telling it to ignore anything
    // irrelevant. Grading against the bare question - the one comparison retrieval never
    // makes, since its query has the whole report prepended - filters the chunks and,
    // when nothing survives, switches the prompt to "say this is not in your report"
    // instead of letting the model reach for general knowledge.
    const graded = await gradeRetrieval({
        question: effectiveQuestion,
        retrievalText: reportRetrieval.text,
        chunks: reportRetrieval.chunks,
    });
    const retrievals = graded.text;

    root?.setMetadata({
        retrievalVerdict: graded.verdict,
        retrievalChunksKept: graded.chunks.length,
        retrievalChunksDropped: reportRetrieval.chunks.length - graded.chunks.length,
        retrievalUngraded: graded.ungraded,
    });

    const finalPrompt = `Here is a summary of a patient's clinical report, and a user query. Excerpts retrieved from that same report are also provided.
  Go through the clinical report and answer the user query.
  Ensure the response is factually accurate, and demonstrates a thorough understanding of the query topic and the clinical report.
  The retrieved excerpts are passages from THIS patient's own report, already checked for relevance to the query - treat them as evidence about this patient, not as generic background.

  \n\n**Grounding rule (follow this exactly):**
  \n${buildGroundingInstruction(graded)}

  \n\n**Today's date:** ${new Date().toISOString().slice(0, 10)}

  \n\n**Patient's Clinical report summary:** \n${reportData}.
  \n**end of patient's clinical report**

  \n\n**User Query:**\n${effectiveQuestion}
  \n**end of user query**

  \n\n**Relevant excerpts from this patient's report:**
  \n\n${retrievals}.
  \n\n**end of report excerpts**

  \n\n**Relevant conversation memory:**
  \n\n${chatHistoryRetrievals}
  \n\n**end of relevant conversation memory**

  \n\n**Recent conversation history from this session:**
  \n\n${recentConversationHistory}
  \n\n**end of recent conversation history**

  \n\nYou also have a queryKnowledgeGraph tool that looks up known relationships for a medical entity in the patient's knowledge graph. Call it when an entity mentioned in the report or query would benefit from that context, and call it again with a new entity if a result reveals something else worth following (e.g. an interacting drug). Skip it entirely if the question doesn't need graph context.

  \n\n${graded.verdict === "none"
            ? "Keep the answer short and direct - there is nothing here to justify at length."
            : "Provide thorough justification for your answer."}
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
                    cacheResponse(effectiveQuestion, event.text, reportData);
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
                            // The resolved question, not the raw one: storing "is that bad?"
                            // preserved the pronoun but lost its referent forever, leaving a
                            // dangling reference to resurface in a later prompt.
                            const memoryText = `User question: ${effectiveQuestion}\nAssistant answer: ${cleanAnswerText}`;
                            const memoryResult = await upsertConversationMemory(
                                pinecone,
                                "medic",
                                {
                                    id: generateDocumentId(`${vaultId}:${effectiveQuestion}:${cleanAnswerText}`),
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
