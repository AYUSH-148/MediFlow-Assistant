import { generateObject } from "ai";
import { z } from "zod";
import { geminiModel } from "@/lib/gemini";
import { groqStructured } from "@/lib/groq";
import { span, setSpanMetadata, textShape } from "@/lib/tracing";

/**
 * Second check on a borderline semantic-cache match: do two questions ask for the same
 * information?
 *
 * Cosine similarity alone cannot make that call on medical questions. After the move to
 * gemini-embedding-001 the cache eval measured "hepatitis B surface antigen" against
 * "...antibody" at 0.985 - higher than most true paraphrases - while "free T4" against
 * "FT4 level" scored 0.948. The populations overlap, so no single threshold is both safe
 * and useful: 0.95 replayed 8/23 near-miss questions' answers, and the lowest threshold
 * with zero wrong replays (0.99) kept only 6/21 paraphrases. The text differs by one token
 * and the meaning flips, which is exactly what an embedding averages away and a reader
 * does not.
 *
 * So the cache reuses an answer outright only above CACHE_AUTO_HIT_SIMILARITY, and asks
 * this judge in the band below it. The judge sees the two questions and nothing else: no
 * report text and no cached answer, so it decides on what was asked, not on whether an
 * answer happens to cover both.
 *
 * It fails CLOSED, unlike the guard, grader and answer check. Those fail open because
 * stopping costs the user an answer; here a failure costs one normal generation, while
 * failing open would replay an answer to a question nobody asked.
 */

const VerdictSchema = z.object({
    sameQuestion: z
        .boolean()
        .describe("True only if one answer would be fully correct for both questions."),
});

/**
 * Which model judges. Opt-in with CACHE_JUDGE_PROVIDER=groq, Gemini the default and the
 * fallback, as for the other stages. gpt-oss-20b rather than 120b because Groq
 * rate-limits per model and 120b already carries the guard (every message) and the
 * answer judge; the only stage sharing 20b is the grader, which never runs on a cache hit.
 */
export const CACHE_JUDGE_PROVIDER: "groq" | "gemini" =
    process.env.CACHE_JUDGE_PROVIDER === "groq" ? "groq" : "gemini";
export const GROQ_CACHE_JUDGE_MODEL = "openai/gpt-oss-20b";

// VerdictSchema as JSON Schema for Groq's strict mode (see lib/groq.ts).
const VERDICT_JSON_SCHEMA = {
    type: "object",
    properties: {
        sameQuestion: { type: "boolean", description: VerdictSchema.shape.sameQuestion.description },
    },
    required: ["sameQuestion"],
    additionalProperties: false,
};

// The examples are deliberately not the eval's pairs, so `npm run eval:cache` measures
// the judge on cases it was not shown.
function buildPrompt(cachedQuestion: string, newQuestion: string): string {
    return `A patient asked two questions about the same medical report. A saved answer to the
first question will be shown for the second only if you decide they ask for exactly the
same information.

They are DIFFERENT if any of these differ:
- the test, marker or condition, even when the names look alike (magnesium vs manganese,
  neutrophils vs lymphocytes, type 1 vs type 2 diabetes)
- the direction (raised vs reduced, hyper- vs hypo-, too high vs too low)
- the kind of result (a marker of current infection vs a marker of immunity)
- the intent (what a value is vs what to do about it)
- the scope (one value vs a whole panel)

They are the SAME despite differences in wording, word order, spelling (oesophagus vs
esophagus) or an abbreviation against its full name (BP vs blood pressure, LFTs vs liver
function tests).

When unsure, answer false: a wrong replay misleads the patient, while a false "different"
only costs a fresh answer.

Question 1: ${cachedQuestion}
Question 2: ${newQuestion}`;
}

export type CacheJudgeVerdict = "same" | "different" | "failed";

export async function judgeCacheMatch(
    cachedQuestion: string,
    newQuestion: string
): Promise<CacheJudgeVerdict> {
    return span(
        "cache_judge",
        { cachedQuestion, newQuestion },
        async () => {
            const prompt = buildPrompt(cachedQuestion, newQuestion);
            let judgedBy: "groq" | "gemini" = "gemini";
            let groqError: string | undefined;
            let object: z.infer<typeof VerdictSchema> | undefined;
            try {
                if (CACHE_JUDGE_PROVIDER === "groq") {
                    try {
                        const result = await groqStructured(
                            GROQ_CACHE_JUDGE_MODEL,
                            prompt,
                            "cache_match",
                            VERDICT_JSON_SCHEMA
                        );
                        object = VerdictSchema.parse(result.content);
                        judgedBy = "groq";
                    } catch (error) {
                        groqError = error instanceof Error ? error.message : String(error);
                        console.error("Groq cache judge failed; falling back to Gemini:", groqError);
                    }
                }
                object ??= (
                    await generateObject({ model: geminiModel, schema: VerdictSchema, temperature: 0, prompt })
                ).object;

                const verdict: CacheJudgeVerdict = object.sameQuestion ? "same" : "different";
                setSpanMetadata({ verdict, judgedBy, ...(groqError ? { groqFallback: groqError } : {}) });
                return verdict;
            } catch (error) {
                // Fail closed: see the note at the top of the file.
                console.error("Cache judge failed; treating as a miss:", error);
                setSpanMetadata({
                    verdict: "failed",
                    swallowedError: error instanceof Error ? error.message : String(error),
                    ...(groqError ? { groqFallback: groqError } : {}),
                });
                return "failed";
            }
        },
        {
            runType: "llm",
            tags: ["cache", "judge"],
            safeInputs: { ...textShape("cachedQuestion", cachedQuestion), ...textShape("newQuestion", newQuestion) },
            recordOutputs: (verdict) => ({ verdict }),
        }
    );
}
