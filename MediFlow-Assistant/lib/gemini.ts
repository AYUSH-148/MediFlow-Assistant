import { createGoogleGenerativeAI } from "@ai-sdk/google";

// Single source of truth for the Gemini model shared by both API routes.
//
// Both routes now reach Gemini through the Vercel AI SDK provider. The ingest route
// used to use Google's own @google/generative-ai instead, which meant two libraries
// talking to the same model with two independent configurations - and they had
// drifted, leaving the safety settings below applied to chat only.
export const GEMINI_MODEL_ID = "gemini-2.5-flash";

// A medical assistant routinely discusses conditions, treatments, dosages, and
// "cures". At Gemini's default thresholds those prompts get blocked, and a blocked
// generation comes back with no text rather than as an error - which surfaced as
// blank chat answers and as failed report uploads.
//
// Blocking is disabled across all four categories for this clinical use case. Note
// this removes the provider's only content filter, and report text is injected into
// prompts verbatim: treat uploaded document contents as untrusted input.
export const GEMINI_SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({
  category: category as
    | "HARM_CATEGORY_HARASSMENT"
    | "HARM_CATEGORY_HATE_SPEECH"
    | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
    | "HARM_CATEGORY_DANGEROUS_CONTENT",
  threshold: "BLOCK_NONE" as const,
}));

const google = createGoogleGenerativeAI({
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: process.env.GEMINI_API_KEY,
});

// One configured instance for both routes, so the model id and safety settings
// cannot drift apart again. The model object is stateless configuration - sharing it
// across requests is safe.
export const geminiModel = google(GEMINI_MODEL_ID, {
  safetySettings: GEMINI_SAFETY_SETTINGS,
});
