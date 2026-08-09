import { createGoogleGenerativeAI } from "@ai-sdk/google";

// Single source of truth for the Gemini model, shared by both API routes so the model
// id and safety settings cannot drift apart.
export const GEMINI_MODEL_ID = "gemini-2.5-flash";

// A medical assistant routinely discusses conditions, treatments, dosages and "cures".
// At Gemini's default thresholds those prompts get blocked, and a blocked generation
// comes back with no text rather than an error - which surfaces as blank chat answers
// and failed report uploads.
//
// Disabling all four categories removes the provider's only content filter, and report
// text is injected into prompts verbatim: treat uploaded documents as untrusted input.
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

// Stateless configuration, so one instance is safely shared across requests.
export const geminiModel = google(GEMINI_MODEL_ID, {
  safetySettings: GEMINI_SAFETY_SETTINGS,
});
