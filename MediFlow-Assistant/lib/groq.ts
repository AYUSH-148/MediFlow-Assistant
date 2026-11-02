/**
 * One structured-output call to Groq, shared by the answer judge and the retrieval grader.
 *
 * No retries. A 429 here means the per-minute token budget is spent, and waiting for it
 * would hold the user's answer for seconds when Gemini can take the call now - so callers
 * fall back instead of retrying.
 *
 * Plain fetch to Groq's OpenAI-compatible endpoint rather than an AI SDK provider: the
 * provider package would have to match this project's old `ai` major.
 *
 * `schema` is JSON Schema for Groq's strict mode: every property required, no extras.
 * Callers write it by hand because the only zod converter available is a transitive
 * dependency of `ai` that could vanish on any upgrade, and validate the result with their
 * own zod schema.
 */
export async function groqStructured(
    model: string,
    prompt: string,
    schemaName: string,
    schema: object,
    abortSignal?: AbortSignal
): Promise<{ content: unknown; tokens: number | null }> {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ""}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            // Reasoning tokens count against the tokens-per-minute limit. Low effort still
            // caught every planted error but one in the judge eval.
            reasoning_effort: "low",
            response_format: {
                type: "json_schema",
                json_schema: { name: schemaName, strict: true, schema },
            },
        }),
        signal: abortSignal,
    });
    if (!response.ok) {
        // Status first so a retry pattern matching "429" sees it. Groq's error bodies name
        // the limit or the fault, never the prompt.
        throw new Error(`Groq ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = await response.json();
    return {
        content: JSON.parse(body.choices[0].message.content),
        // Groq's free tier is limited by tokens per minute, so this is the cost.
        tokens: body.usage?.total_tokens ?? null,
    };
}
