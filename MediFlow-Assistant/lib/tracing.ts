import { Client, RunTree } from "langsmith";
import { traceable } from "langsmith/traceable";
import { getCurrentRunTree, withRunTree } from "langsmith/singletons/traceable";

/**
 * LangSmith tracing for the RAG pipeline.
 *
 * Spans are hand-rolled on the framework-agnostic `traceable` API rather than an AI SDK
 * integration: langsmith's `wrapAISDK` and `LangSmithTelemetry` type against
 * `LanguageModelV2` (AI SDK 5/6) and this app is on ai@3.x. It also buys per-span control
 * over what is recorded, which matters below.
 *
 * PHI and tracing
 * ---------------
 * Trace payloads are uploaded to LangSmith. This pipeline exists partly to keep
 * identifiers away from third parties, and the most useful spans sit on the unredacted
 * side of the redaction boundary - the verbatim OCR transcription, the raw question, the
 * token vault, the rehydrated answer. Capturing those is gated behind
 * LANGSMITH_TRACE_PHI, which defaults to OFF, so a deploy that forgets the flag degrades
 * to metadata-only rather than streaming patient records to a third-party region.
 *
 * With the flag off the invariant is deliberately strong: NO free text on any span, not
 * "only text Gemini already sees". The PII rules in @/lib/pii-redaction are label-anchored
 * by necessity (broad patterns wreck retrieval), so a question like "my name is Rahul
 * Mehta, is my LDL of 172 dangerous?" has nothing to anchor on and the name flows on into
 * the retrieval query, cache key and embedding input. Recording those "post-redaction,
 * therefore safe" fields verbatim puts real names in traces.
 *
 * So: flag off records only lengths, counts, ids, scores, timings and errors; flag on
 * records everything. Bulk payloads (embedding vectors, 500-chunk corpora) are dropped
 * either way - see recordOutputs.
 */

type Meta = Record<string, unknown>;

const PROJECT_NAME = process.env.LANGSMITH_PROJECT?.trim() || "default";

export const TRACING_ENABLED =
  process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;

/**
 * Whether spans may record raw pre-redaction / post-rehydration text.
 * Deliberately opt-in: absent env var means no PHI leaves the process.
 */
export const TRACE_PHI = process.env.LANGSMITH_TRACE_PHI === "true";

// Built once: the client holds an in-memory batch queue, so a per-request client would
// drop traces when the request ends before its batch is sent.
const client: Client | null = TRACING_ENABLED
  ? new Client({
      apiKey: process.env.LANGSMITH_API_KEY,
      apiUrl: process.env.LANGSMITH_ENDPOINT,
    })
  : null;

if (TRACING_ENABLED) {
  // Worth logging at boot: a deploy that silently has PHI capture on is the failure
  // this flag exists to prevent.
  console.log(
    `LangSmith tracing enabled for project "${PROJECT_NAME}" ` +
      `(raw PHI capture: ${TRACE_PHI ? "ON" : "off"})`
  );
}

/** A summary safe to record when PHI capture is off. */
export function textShape(label: string, text: string | undefined | null): Meta {
  return { [label]: text ? `<${text.length} chars withheld>` : "<empty>" };
}

/**
 * Metadata keys LangSmith uses to identify the model behind an `llm` span. Without these
 * the span shows no provider and gets no cost attribution.
 */
export function llmMetadata(model: string, provider = "google"): Meta {
  return { ls_provider: provider, ls_model_name: model, ls_model_type: "chat" };
}

/**
 * Token usage in the shape LangSmith reads for cost calculation. It multiplies these
 * counts by its own price table for `ls_model_name`, so a model missing from that table
 * shows tokens but zero cost until pricing is configured in the workspace.
 */
export function usageMetadata(usage?: LlmSpanUsage): Meta {
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
  return {
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export interface SpanOptions<O> {
  /** LangSmith run type: chain | llm | retriever | tool | parser. Drives UI + cost. */
  runType?: string;
  tags?: string[];
  metadata?: Meta;
  /**
   * Recorded in place of the real inputs when PHI capture is off. Supply this for
   * any span whose inputs contain pre-redaction text.
   */
  safeInputs?: Meta;
  /**
   * Recorded in place of the real outputs when PHI capture is off. Supply this for
   * any span whose outputs contain pre-redaction or rehydrated text.
   */
  safeOutputs?: (output: O) => Meta;
  /**
   * Always applied, regardless of the PHI flag - this drops bulk noise rather than
   * protecting anything. `safeOutputs` still wins when PHI capture is off, being the
   * more restrictive of the two.
   */
  recordOutputs?: (output: O) => Meta;
}

// traceable records a non-object return value as `{ outputs: value }`. Undo that so
// callers' safeOutputs/metadata callbacks always see the value the function returned.
function unwrapRecordedOutput<O>(recorded: unknown): O {
  if (
    recorded &&
    typeof recorded === "object" &&
    !Array.isArray(recorded) &&
    "outputs" in recorded &&
    Object.keys(recorded).length === 1
  ) {
    return (recorded as { outputs: O }).outputs;
  }
  return recorded as O;
}

/**
 * Run `fn` as a LangSmith span.
 *
 * Nesting is automatic: spans opened inside another span's callback become its
 * children via AsyncLocalStorage, so instrumenting the route handler and the lib
 * functions independently still yields one tree per request.
 *
 * A no-op passthrough when tracing is disabled - no client, no overhead.
 */
export function span<I extends Meta, O>(
  name: string,
  inputs: I,
  fn: (inputs: I) => Promise<O>,
  options: SpanOptions<O> = {}
): Promise<O> {
  if (!client) return fn(inputs);

  const { runType = "chain", tags, metadata, safeInputs, safeOutputs, recordOutputs } = options;

  const traced = traceable(fn as (inputs: I) => Promise<O>, {
    name,
    run_type: runType,
    client,
    project_name: PROJECT_NAME,
    tags,
    metadata,
    processInputs: (raw: unknown) =>
      TRACE_PHI || !safeInputs ? (raw as Meta) : safeInputs,
    processOutputs: (raw: unknown) => {
      const value = unwrapRecordedOutput<O>(raw);
      if (!TRACE_PHI && safeOutputs) return safeOutputs(value);
      if (recordOutputs) return recordOutputs(value);
      return raw as Meta;
    },
  } as never);

  return (traced as (inputs: I) => Promise<O>)(inputs);
}

/**
 * Attach metadata to the currently open span from inside it, for values only known once
 * the step has run - cache hit/miss, similarity score, chunk counts, extraction path.
 * Metadata is what LangSmith filters and groups on.
 */
export function setSpanMetadata(metadata: Meta): void {
  if (!client) return;
  try {
    const run = getCurrentRunTree(true);
    if (!run) return;
    run.extra = run.extra ?? {};
    (run.extra as Meta).metadata = {
      ...((run.extra as Meta).metadata as Meta | undefined),
      ...metadata,
    };
  } catch {
    // No span open (function called outside a traced request). Not an error.
  }
}

export interface LlmSpanUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** Picks the raw or withheld variant according to the PHI flag. */
export function phiGated(raw: Meta, safe: Meta): Meta {
  return TRACE_PHI ? raw : safe;
}

/**
 * A span whose lifetime is managed by hand, for steps whose start and end are not the
 * entry and exit of one function. Two cases here:
 *
 *  - `streamText`: the route needs the stream object back immediately, but token usage
 *    and finish reason only settle once the stream drains.
 *  - the chat request as a whole: its remaining work runs in a ReadableStream `start()`
 *    callback the runtime invokes after the Response is returned.
 */
export interface ManualSpan {
  /** Pass to `runInSpan` so callback-based `span()` calls nest underneath. */
  readonly runTree: RunTree;
  succeed(outputs?: Meta): Promise<void>;
  fail(error: unknown): Promise<void>;
  setMetadata(metadata: Meta): void;
  /** Opens a child span, for work that cannot rely on async-context propagation. */
  child(name: string, runType: string, inputs: Meta): ManualSpan | null;
}

function manualSpan(config: Record<string, unknown>, parent?: RunTree): ManualSpan | null {
  if (!client) return null;

  const fullConfig = { client, project_name: PROJECT_NAME, ...config };

  let run: RunTree;
  try {
    run = parent ? parent.createChild(fullConfig as never) : new RunTree(fullConfig as never);
  } catch (error) {
    console.error(`LangSmith: failed to create span ${config.name}:`, error);
    return null;
  }

  const posted = run.postRun().catch((error) => {
    console.error(`LangSmith: failed to post span ${config.name}:`, error);
  });

  const settle = async (outputs: Meta | undefined, error?: string) => {
    try {
      await posted;
      await run.end(outputs, error);
      await run.patchRun();
    } catch (patchError) {
      console.error(`LangSmith: failed to close span ${config.name}:`, patchError);
    }
  };

  return {
    runTree: run,
    succeed: (outputs) => settle(outputs),
    fail: (error) =>
      settle(undefined, error instanceof Error ? error.message : String(error)),
    setMetadata(metadata) {
      run.extra = run.extra ?? {};
      (run.extra as Meta).metadata = {
        ...((run.extra as Meta).metadata as Meta | undefined),
        ...metadata,
      };
    },
    child: (childName, childRunType, childInputs) =>
      manualSpan({ name: childName, run_type: childRunType, inputs: childInputs }, run),
  };
}

/** Open a manually managed span, nesting under the active span if there is one. */
export function startSpan(options: {
  name: string;
  runType?: string;
  inputs: Meta;
  safeInputs?: Meta;
  tags?: string[];
  metadata?: Meta;
}): ManualSpan | null {
  if (!client) return null;
  const { name, runType = "chain", inputs, safeInputs, tags, metadata } = options;

  let parent: RunTree | undefined;
  try {
    parent = getCurrentRunTree(true);
  } catch {
    parent = undefined;
  }

  return manualSpan(
    {
      name,
      run_type: runType,
      tags,
      metadata,
      inputs: TRACE_PHI || !safeInputs ? inputs : safeInputs,
    },
    parent
  );
}

/**
 * Open an `llm`-type manual span. The `ls_*` metadata keys are how LangSmith
 * identifies the model for its cost table.
 */
export function startLlmSpan(options: {
  name: string;
  model: string;
  provider?: string;
  inputs: Meta;
  safeInputs?: Meta;
  tags?: string[];
  metadata?: Meta;
  parent?: ManualSpan | null;
}): ManualSpan | null {
  const { name, model, provider, inputs, safeInputs, tags, metadata, parent } = options;
  const config = {
    name,
    run_type: "llm",
    tags,
    metadata: { ...metadata, ...llmMetadata(model, provider) },
    inputs: TRACE_PHI || !safeInputs ? inputs : safeInputs,
  };

  // An explicit parent wins over async context: the LLM span is created before the
  // stream callback that closes it, so context propagation cannot be relied on.
  if (parent) return manualSpan(config, parent.runTree);
  return startSpan({
    name,
    runType: "llm",
    inputs,
    safeInputs,
    tags,
    metadata: { ...metadata, ...llmMetadata(model, provider) },
  });
}

/**
 * Close out an LLM span with generation results, shaped for cost attribution.
 */
export async function endLlmSpan(
  llmSpan: ManualSpan | null,
  result: {
    text?: string;
    usage?: LlmSpanUsage;
    finishReason?: string;
    toolCalls?: unknown[];
    /** Number of round-trips the multi-step tool loop actually took. */
    stepCount?: number;
  }
): Promise<void> {
  if (!llmSpan) return;
  await llmSpan.succeed({
    // Withheld rather than omitted, so an empty generation stays distinguishable
    // from a suppressed one.
    ...phiGated({ text: result.text ?? "" }, textShape("text", result.text)),
    finish_reason: result.finishReason,
    tool_call_count: result.toolCalls?.length ?? 0,
    ...(result.stepCount === undefined ? {} : { step_count: result.stepCount }),
    ...usageMetadata(result.usage),
  });
}

/**
 * Run `fn` with `span` as the active parent, so `span()` calls inside it nest
 * underneath. Required when resuming work in a callback the runtime invokes outside
 * the original async context, such as a ReadableStream's `start`.
 */
export async function runInSpan<T>(
  parent: ManualSpan | null,
  fn: () => Promise<T>
): Promise<T> {
  if (!parent) return fn();
  return withRunTree(parent.runTree, fn);
}

/**
 * Wait for queued trace uploads to reach LangSmith.
 *
 * Required, not optional hygiene: the client batches uploads in the background and a
 * serverless host can freeze the function the moment the response is returned, so
 * without an explicit await the batch never leaves - tracing that works locally and
 * produces an empty dashboard in production. Never throws.
 */
export async function flushTraces(): Promise<void> {
  if (!client) return;
  try {
    await client.awaitPendingTraceBatches();
  } catch (error) {
    console.error("LangSmith: failed to flush traces:", error);
  }
}
