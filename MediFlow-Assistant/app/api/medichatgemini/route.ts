import {
    generateDocumentId,
    queryPineconeVectorStoreDetailed,
    pinecone,
} from "@/utils";
import { buildRetrievalQuery } from "@/lib/embeddings";
import {
    getDocumentSession,
    readSessionId,
    appendSessionTurns,
    type StoredTurn,
} from "@/lib/session";
import {
    gradeRetrieval,
    buildGroundingInstruction,
    type GradedRetrieval,
} from "@/lib/retrieval-grader";
import {
    getCachedResponse,
    cacheResponse,
} from "@/lib/cache";
import {
    redactDocument,
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
    generateText,
    tool,
    formatStreamPart,
    type JSONValue,
} from "ai";
import { z } from "zod";
import { guardQuestion } from "@/lib/query-guard";
import { checkAnswer, buildRevisionInstruction, type AnswerCheck } from "@/lib/answer-checker";
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

// Gemini calls are cut off once a turn has run this long, leaving the rest of maxDuration
// for the cache write, rehydration and trace flush. Unbounded, a turn that needed the retry
// could chain six-plus calls (each retried by the SDK on failure) past 60s, and the platform
// then killed the function: the user got a 504 instead of the fallback text.
const ANSWER_BUDGET_MS = 50_000;
// A retry is a generation plus a re-check. With less than this left it cannot finish, so
// the fallback is sent straight away instead.
const RETRY_MIN_MS = 15_000;

// Stand-ins for the retrieval and grading a conversational turn skips. Shaped like the
// real results so the prompt-building below stays one path rather than two: "" reads as
// "no excerpts", which is exactly true here.
const EMPTY_RETRIEVAL = { text: "", chunks: [] };
const NOTHING_GRADED: GradedRetrieval = {
    verdict: "none",
    text: "",
    chunks: [],
    missing: "",
    // Nothing was retrieved, so nothing was graded. Recorded honestly: a turn counted as
    // a grader failure would make the grader look broken in the traces.
    ungraded: true,
};

// buildGroundingInstruction's "none" branch tells the model to say the report does not
// contain the information - a true statement and the wrong answer, because the question
// was never about the report. This replaces it for conversational turns.
const CONVERSATIONAL_GROUNDING =
    "This question is about the conversation itself, not about the report. Answer it " +
    "from the conversation history below: say what was actually asked or answered, " +
    "quoting the user's own wording where it helps. If the history holds nothing yet, " +
    "say this is the first question of the conversation. Do not retrieve, infer or " +
    "volunteer clinical findings to answer it, and do not tell the user their report " +
    "lacks the information - it was never the place to look.";

// Shown when an answer failed the hallucination check twice. Deliberately says nothing
// about the content of either rejected draft.
const UNVERIFIED_FALLBACK =
    "I couldn't verify an answer to that against your report, so I'd rather not guess. " +
    "Try asking about a specific finding (a medication, biomarker, or diagnosis), or check " +
    "with the clinician who ordered the report.";

const EMPTY_GENERATION_FALLBACK =
    "I couldn't generate an answer for that one. Please try rephrasing your question, or " +
    "ask about a specific finding in the report (a medication, biomarker, or diagnosis).";

// Emit a ready-made answer in the AI SDK data-stream protocol so useChat (default
// streamProtocol: "data") can parse it - the same framing toDataStreamResponse()
// produces on the generation path. Returning raw text here makes the client silently
// drop the response.
//
// Shared by every exit path: the cache hit, the query guard, and generation, whose answer
// is only sent once it has been checked and rehydrated.
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
    // Both used to arrive in the request body. The document id is now resolved from an
    // HttpOnly session cookie the client cannot read or forge, and the summary comes with
    // it - so a request can no longer pair one document's id with another's summary, and
    // there is no document field for a caller to supply at all.
    const sessionId = readSessionId(req);
    const session = await getDocumentSession(sessionId);
    const reportData: string = session?.summary ?? "";
    const vaultId: string = session?.documentId ?? "";

    // Managed by hand because each exit path closes it at a different point, and an
    // unexpected throw is closed by the catch below rather than by the path that threw.
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
            handleChat({
                root,
                messages,
                userQuestion,
                reportData,
                vaultId,
                sessionId,
                storedTurns: session?.transcript ?? [],
            })
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
    sessionId,
    storedTurns,
}: {
    root: ManualSpan | null;
    messages: Message[];
    userQuestion: string;
    reportData: string;
    vaultId: string;
    /** Null when no session cookie was sent; the transcript is then not persisted. */
    sessionId: string | null;
    storedTurns: StoredTurn[];
}): Promise<Response> {
    const deadline = Date.now() + ANSWER_BUDGET_MS;
    const budgetSignal = () => AbortSignal.timeout(Math.max(deadline - Date.now(), 0));
    const reportFilter = vaultId ? { documentId: { $eq: vaultId } } : undefined;

    const reportVault = vaultId ? await getVault(vaultId) : null;

    // Raw question in, placeholder question out, so both sides of the boundary are gated.
    //
    // The question is the last message, so it is redacted in the same pass as the client's
    // transcript, against the report's vault. Redacted on its own it started a fresh vault
    // numbered from 1: "Dr. Kapoor" became [NAME_1], which in the summary is the patient, so
    // the model answered about the wrong person and rehydration then named the patient. Now
    // a value the report already tokenised gets the report's token, a new one is numbered
    // after the report's, and the turns are numbered in order, so a name typed in an earlier
    // turn keeps its token in this one.
    //
    // The client's copy is raw: its user turns are what was typed, and its assistant turns
    // are the rehydrated answers the user saw. The stored transcript was redacted on the way
    // in and needs nothing.
    const redaction = await span(
        "redact_question",
        { question: userQuestion },
        async () => {
            const result = redactDocument(
                messages.map((message) => getMessageText(message.content)),
                reportVault ?? {}
            );
            const redacted = result.redactedTexts.at(-1) ?? "";
            setSpanMetadata({
                inputChars: userQuestion.length,
                redactedChars: redacted.length,
                // Any change at all means PII reached the endpoint.
                piiFound: redacted !== userQuestion,
                // Values the report's vault did not hold, typed by the user.
                tokensAdded:
                    Object.keys(result.vault).length - Object.keys(reportVault ?? {}).length,
            });
            return result;
        },
        {
            runType: "chain",
            tags: ["redaction", "pii-boundary"],
            safeInputs: textShape("question", userQuestion),
            safeOutputs: (result) =>
                textShape("redactedQuestion", result.redactedTexts.at(-1) ?? ""),
            // Names the field the same in both modes, so the gated and raw paths compare.
            recordOutputs: (result) => ({ redactedQuestion: result.redactedTexts.at(-1) ?? "" }),
        }
    );
    const redactedQuestion = redaction.redactedTexts.at(-1) ?? "";

    // What the answer is rehydrated with: the report's vault plus anything the user typed
    // that it did not hold. The additions live for this request only - the "Kapoor" behind
    // a new [NAME_3] belongs to this conversation, not to the report every session shares.
    // ponytail: a new token in the stored transcript can't be rehydrated after a refresh
    // (the client then posts nothing to rebuild it from). Keep the additions on the session
    // if that shows up.
    const vault =
        reportVault || Object.keys(redaction.vault).length ? redaction.vault : null;

    // The whole conversation, not a four-message tail.
    //
    // `useChat` posts the entire transcript on every request, so the route already had all
    // of it, kept the last four, and then spent an embedding call plus two Pinecone queries
    // recovering a lossy, out-of-order approximation of what it had just discarded. At
    // roughly 250 tokens a turn against a 1M-token window, the whole thing costs a fraction
    // of a percent - so it is passed verbatim, which is both cheaper and lossless.
    //
    // The stored transcript wins when it is longer: a page refresh empties `useChat`'s
    // state, and the client would then post an empty array while the user still sees a
    // report loaded. Comparing lengths keeps whichever side actually has the conversation
    // without needing to merge them.
    const clientTurns = messages.map((message, index) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: redaction.redactedTexts[index],
    }));
    const conversationTurns = storedTurns.length > clientTurns.length ? storedTurns : clientTurns;

    const recentConversationHistory = conversationTurns.length > 1
        ? conversationTurns
            .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
            .join("\n")
        : "No prior conversation history";

    root?.setMetadata({
        clientTurns: clientTurns.length,
        storedTurns: storedTurns.length,
        // True when a refresh emptied the client's state and the server's copy carried the
        // conversation - the case this persistence exists for.
        transcriptRestored: storedTurns.length > clientTurns.length,
    });

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

    // "What did I ask before?" is answered from the transcript, so it skips the report
    // pipeline entirely: no cache, no retrieval, no grading.
    //
    // The cache is the part that would be actively wrong rather than merely wasteful. Its
    // key is the report hash plus the question hash, with nothing in it identifying the
    // conversation - so one session's "what was my first question" would be replayed to
    // every other session holding the same report, for 24h.
    const conversational = guard.conversational;

    const cachedAnswer = conversational
        ? null
        : await getCachedResponse(effectiveQuestion, reportData, 0.95);

    if (cachedAnswer) {
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
    // Question only. The report summary used to be prepended here, which drowned the
    // question in the query vector, fed the whole summary to the TF-IDF arm as query
    // terms, and pushed the question past the embedding model's 512-token ceiling on a
    // long report. See buildRetrievalQuery.
    const query = buildRetrievalQuery(effectiveQuestion);

    // Only the report is retrieved now. Conversation history used to be a second Pinecone
    // namespace searched in parallel here - an embedding call plus a topK 12 query and a
    // topK 500 corpus pull, every turn, to fetch turns the request body already carried.
    // It also returned them ranked by similarity rather than in order, which made "what did
    // I ask before that?" unanswerable however good the recall was.
    const reportRetrieval = conversational
        ? EMPTY_RETRIEVAL
        : await queryPineconeVectorStoreDetailed(
              pinecone,
              'medic',
              "diagnosis2",
              query,
              reportFilter
          );

    // Corrective-RAG grading. Retrieval hands back its top 10 chunks whether or not they
    // bear on the question, so without this the generator receives padding labelled as
    // evidence and has only a politely-worded prompt line telling it to ignore anything
    // irrelevant. Grading against the bare question - the one comparison retrieval never
    // makes, since its query has the whole report prepended - filters the chunks and,
    // when nothing survives, switches the prompt to "say this is not in your report"
    // instead of letting the model reach for general knowledge.
    const graded = conversational
        ? NOTHING_GRADED
        : await gradeRetrieval({
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

    const today = new Date().toISOString().slice(0, 10);
    // Everything up to the answer cue, so the hallucination retry can append its own
    // instruction after the same evidence.
    const promptBody = `Here is a summary of a patient's clinical report, and a user query. Excerpts retrieved from that same report are also provided.
  Go through the clinical report and answer the user query.
  Ensure the response is factually accurate, and demonstrates a thorough understanding of the query topic and the clinical report.
  The retrieved excerpts are passages from THIS patient's own report, already checked for relevance to the query - treat them as evidence about this patient, not as generic background.

  \n\n**Grounding rule (follow this exactly):**
  \n${conversational ? CONVERSATIONAL_GROUNDING : buildGroundingInstruction(graded)}

  \n\n**Today's date:** ${today}

  \n\n**Patient's Clinical report summary:** \n${reportData}.
  \n**end of patient's clinical report**

  \n\n**User Query:**\n${effectiveQuestion}
  \n**end of user query**

  \n\n**Relevant excerpts from this patient's report:**
  \n\n${retrievals}.
  \n\n**end of report excerpts**

  \n\n**Conversation so far:**
  \n\n${recentConversationHistory}
  \n\n**end of conversation**

  \n\n${graded.verdict === "none"
            ? "Keep the answer short and direct - there is nothing here to justify at length."
            : "Provide thorough justification for your answer."}`;
    // Kept out of promptBody because the retry has no tools: told it had one, the model
    // could write "let me look that up" or a mock tool call in place of an answer.
    const toolInstruction = `You also have a queryKnowledgeGraph tool that looks up known relationships for a medical entity in the patient's knowledge graph. Call it when an entity mentioned in the report or query would benefit from that context, and call it again with a new entity if a result reveals something else worth following (e.g. an interacting drug). Skip it entirely if the question doesn't need graph context.`;
    const finalPrompt = `${promptBody}\n\n${toolInstruction}\n\n**Answer:**\n`;

    // Opened by hand so the knowledge-graph tool spans can attach to it explicitly: the AI
    // SDK runs tool execution inside its own step loop, where the async context that would
    // nest them automatically is not guaranteed to survive.
    const llmSpan = startLlmSpan({
        name: "generate_answer",
        model: GEMINI_MODEL_ID,
        parent: root,
        inputs: { prompt: finalPrompt },
        safeInputs: textShape("prompt", finalPrompt),
        tags: ["gemini", "generation"],
        metadata: { maxSteps: 5, tools: ["queryKnowledgeGraph"] },
    });

    // generateText, not streamText. The answer was always buffered whole before the client
    // saw a byte - it had to be, to cache and rehydrate it - and it now also has to pass the
    // hallucination check first, so streaming bought nothing but framing to work around: a
    // vault token split across two stream chunks could not be rehydrated.
    //
    // A rejection (auth, quota, network) closes the span and reaches POST's catch, which
    // turns it into a response the client can show.
    const generation = await generateText({
        model: geminiModel,
        prompt: finalPrompt,
        tools: { queryKnowledgeGraph: createQueryKnowledgeGraphTool(vaultId, llmSpan) },
        maxSteps: 5,
        abortSignal: budgetSignal(),
    }).catch(async (error) => {
        await llmSpan?.fail(error);
        throw error;
    });

    await endLlmSpan(llmSpan, {
        finishReason: generation.finishReason,
        usage: generation.usage,
        text: generation.text,
        // generation.toolCalls describes the FINAL step only, so a generation that called
        // the knowledge graph and then answered reports zero tool calls. Summing across
        // steps is the real count.
        toolCalls: generation.steps.flatMap((step) => step.toolCalls),
        stepCount: generation.steps.length,
    });

    const firstDraft = generation.text.trim();
    let answer = firstDraft;
    // Null when the check did not run: a conversational turn has no report evidence to
    // check against, and an empty generation has nothing to check.
    let check: AnswerCheck | null = null;
    // Whether the shown answer is the retry's rather than the first draft. Tracked, not
    // inferred from the text: a retry can return the draft word for word.
    let revised = false;

    if (firstDraft && !conversational) {
        // Everything the generator was shown about this patient, including what it looked
        // up itself: a correct answer drawn from the knowledge graph would otherwise read
        // as invented. The conversation too, or a fact the user stated two turns ago and
        // the answer repeated would be flagged as made up.
        const graphLookups = generation.steps.flatMap((step) =>
            step.toolResults.map((toolResult) => toolResult.result)
        );
        const graphSection = graphLookups.length
            ? `**Knowledge-graph lookups already made:**\n${JSON.stringify(graphLookups)}`
            : "";
        const evidence = [
            `Today's date: ${today}`,
            `Report summary:\n${reportData}`,
            `Report excerpts:\n${retrievals}`,
            graphSection,
            `Conversation so far:\n${recentConversationHistory}`,
        ]
            .filter(Boolean)
            .join("\n\n");

        check = await checkAnswer({
            question: effectiveQuestion,
            evidence,
            answer: firstDraft,
            abortSignal: budgetSignal(),
        });
        root?.setMetadata({
            answerCheck: check.verdict,
            answerCheckFailed: check.checkFailed,
            unsupportedClaims: check.unsupportedClaims.length,
        });

        if (check.verdict !== "grounded") {
            // One retry, no more: each round is a generation plus a check inside a 60s
            // budget, and an answer that fails twice is better replaced than retried.
            //
            // No tools on the retry. The lookups the first pass made are in the prompt, and
            // a fresh tool loop would repeat the slowest part of the turn.
            let retryStatus: "skipped" | "failed" | "empty" | "ran" = "skipped";
            answer = "";
            if (deadline - Date.now() >= RETRY_MIN_MS) {
                const retryPrompt =
                    `${promptBody}\n\n${graphSection}\n\n**Correction:**\n` +
                    `${buildRevisionInstruction(check, firstDraft)}\n\n**Answer:**\n`;
                const retrySpan = startLlmSpan({
                    name: "revise_answer",
                    model: GEMINI_MODEL_ID,
                    parent: root,
                    inputs: { prompt: retryPrompt },
                    safeInputs: textShape("prompt", retryPrompt),
                    tags: ["gemini", "generation", "hallucination-retry"],
                    metadata: { firstVerdict: check.verdict },
                });
                // A failed retry sends the fallback rather than failing the turn, as the
                // guard, grader and checker all fail open. Rethrowing turned a Gemini 429
                // here into an error, discarding a turn the fallback could still answer.
                const retry = await generateText({
                    model: geminiModel,
                    prompt: retryPrompt,
                    abortSignal: budgetSignal(),
                }).catch(async (error) => {
                    console.error("Answer retry failed; sending fallback:", error);
                    await retrySpan?.fail(error);
                    return null;
                });
                if (retry) {
                    await endLlmSpan(retrySpan, {
                        finishReason: retry.finishReason,
                        usage: retry.usage,
                        text: retry.text,
                    });
                    answer = retry.text.trim();
                }
                retryStatus = !retry ? "failed" : answer ? "ran" : "empty";
            }

            // A retry that was skipped, failed or came back empty keeps the first verdict,
            // which already failed.
            if (answer) {
                revised = true;
                check = await checkAnswer({
                    question: effectiveQuestion,
                    evidence,
                    answer,
                    abortSignal: budgetSignal(),
                });
            }
            root?.setMetadata({
                answerRetry: retryStatus,
                answerRecheck: answer ? check.verdict : retryStatus,
                answerRecheckFailed: check.checkFailed,
            });
        }
    }

    // A check that failed open reports "grounded", so its answer is shown - but not cached,
    // and labelled "unchecked" rather than "ok" so the header and traces can tell them apart.
    const passed = !!answer && (check === null || check.verdict === "grounded");
    const outcome = !firstDraft
        ? "empty-generation"
        : !passed
          ? "unverified"
          : check?.checkFailed
            ? "unchecked"
            : revised
              ? "revised"
              : "ok";
    const shownAnswer = !firstDraft
        ? EMPTY_GENERATION_FALLBACK
        : passed
          ? answer
          : UNVERIFIED_FALLBACK;

    if (passed) {
        await Promise.all([
            // The resolved question is stored rather than the raw one: "is that bad?"
            // preserves a pronoun whose referent is gone, and a later prompt would inherit
            // the dangling reference. A fallback is not recorded, so a turn the model never
            // answered is not remembered as one it did.
            appendSessionTurns(sessionId, [
                { role: "user", content: effectiveQuestion },
                { role: "assistant", content: answer },
            ]),
            // Only a verified answer is cached: a cache entry is replayed to every session
            // holding this report for 24h, through a path that never checks again. The
            // redacted text is cached, never the rehydrated one.
            check && !check.checkFailed
                ? cacheResponse(effectiveQuestion, answer, reportData)
                : undefined,
        ]);
    }

    const finalText = await span(
        "rehydrate_answer",
        { text: shownAnswer, vaultId },
        async () => {
            const output = vault ? rehydrateText(shownAnswer, vault) : shownAnswer;
            // Tokens still intact: the vault did not cover them (expired, partial, or never
            // written).
            const surviving = findVaultTokens(output);
            setSpanMetadata({
                vaultFound: !!vault,
                changed: output !== shownAnswer,
                tokensRestored: vault ? Object.keys(vault).length : 0,
                // A vault that exists but changes nothing means the answer had no
                // placeholders in it - which is also how an un-redacted identifier reaching
                // the client would look.
                vaultPresentButUnused: !!vault && output === shownAnswer,
                // Labels only, never the values behind them.
                tokensSurvivingRehydration: surviving.length,
                tokensSurvivingLabels: surviving,
                // The single field to alert on: a placeholder reached the client.
                rehydrationIncomplete: surviving.length > 0,
            });
            if (surviving.length > 0) {
                console.warn(
                    `${surviving.length} vault token(s) survived rehydration ` +
                    `(vault did not cover them): ${surviving.join(", ")}`
                );
            }
            return output;
        },
        {
            runType: "chain",
            tags: ["rehydration", "pii-boundary"],
            safeInputs: { ...textShape("text", shownAnswer), vaultId },
            safeOutputs: (output) => textShape("finalText", output),
            recordOutputs: (output) => ({ finalText: output }),
        }
    );

    if (!firstDraft) console.warn("Model returned empty text; sending fallback message.");

    root?.setMetadata({ outcome });
    await root?.succeed(phiGated({ answer: finalText }, textShape("answer", finalText)));
    await flushTraces();

    return streamStaticAnswer(finalText, {
        // The excerpts are shown to the user too, so they are rehydrated like the answer.
        annotation: {
            retrievals: vault ? rehydrateText(retrievals, vault) : retrievals,
            cacheHit: false,
        },
        headers: { "X-Answer-Check": outcome },
    });
}
