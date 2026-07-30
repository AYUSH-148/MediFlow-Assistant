import type { HarmBlockThreshold, HarmCategory, SafetySetting } from "@google/generative-ai";

// Single source of truth for the Gemini model shared by both API routes.
//
// The two routes deliberately reach Gemini through different SDKs: ingest is a
// one-shot JSON call and uses Google's own @google/generative-ai, while chat needs
// streamText, the tool-calling loop, and the data-stream framing useChat parses, so
// it goes through the @ai-sdk/google provider. Two clients are fine - two separate
// *configurations* were not, which is how the safety settings below ended up applied
// to the chat route only, leaving uploads still exposed to blocking.
//
// @ai-sdk/google resolves a bare id to "models/<id>" internally, so one constant
// works for both SDKs.
export const GEMINI_MODEL_ID = "gemini-2.5-flash";

// A medical assistant routinely discusses conditions, treatments, dosages, and
// "cures". At Gemini's default thresholds those prompts get blocked, and a blocked
// generation comes back as a candidate with NO text rather than an error - which
// surfaced as blank chat answers and as uploads failing inside JSON.parse.
//
// Blocking is disabled across all four categories for this clinical use case. Note
// this removes the provider's only content filter, and report text is injected into
// prompts verbatim: treat uploaded document contents as untrusted input.
const CLINICAL_HARM_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

const CLINICAL_HARM_THRESHOLD = "BLOCK_NONE" as const;

// Shape expected by @ai-sdk/google (string-literal unions).
export const GEMINI_SAFETY_SETTINGS = CLINICAL_HARM_CATEGORIES.map((category) => ({
  category,
  threshold: CLINICAL_HARM_THRESHOLD,
}));

// Same settings in the shape @google/generative-ai expects. Its HarmCategory and
// HarmBlockThreshold are string enums whose values are exactly the literals above,
// so the casts are safe and keep this file free of a runtime SDK import.
export const GOOGLE_SDK_SAFETY_SETTINGS: SafetySetting[] = CLINICAL_HARM_CATEGORIES.map(
  (category) => ({
    category: category as unknown as HarmCategory,
    threshold: CLINICAL_HARM_THRESHOLD as unknown as HarmBlockThreshold,
  })
);
