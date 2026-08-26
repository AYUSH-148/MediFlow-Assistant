import { randomBytes } from "crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Server-held binding between a browser and the document it uploaded.
 *
 * The chat route used to take `vaultId` straight out of the request body. That single
 * string unlocked the document's chunks in Pinecone, its nodes in Neo4j, and - the part
 * that matters - its vault, which is where the real name, MRN and date of birth live. No
 * ownership check existed, because there was nothing to check against: the app has no
 * users, no accounts and no sessions. Anyone holding a vaultId held the document.
 *
 * It was not a guessable id - a SHA-256 of the report text - but it was derived from
 * content rather than being a per-request secret, so the same file always produced the
 * same id, and it travelled in every chat body where any request log would capture it.
 *
 * Now the id never reaches the browser. The cookie carries an opaque random session id,
 * and the mapping to a document lives here. The client cannot name a document, so there
 * is no field to tamper with - which is a stronger guarantee than validating one.
 */
const SESSION_COOKIE = "mf_sid";

// Matches the vault and the response cache. A session outliving its vault would resolve
// to a document whose tokens no longer rehydrate.
const SESSION_TTL_SECONDS = 86400;

// The summary is user-editable by design - the review step invites extra history and
// symptoms - so it cannot simply be read back from the stored ingest result. It is bound
// to the session at confirmation instead, which is what stops one document's vaultId being
// paired with another's summary.
const MAX_SUMMARY_CHARS = 20_000;

export interface DocumentSession {
  documentId: string;
  summary: string;
}

function sessionKey(sessionId: string): string {
  return `medic_session:${sessionId}`;
}

/**
 * 32 random bytes, not a hash of anything. A session id derived from content would be
 * reproducible by anyone holding the same content, which is the property being removed.
 */
export async function createDocumentSession(
  documentId: string,
  summary: string
): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");
  await redis.setex(
    sessionKey(sessionId),
    SESSION_TTL_SECONDS,
    JSON.stringify({ documentId, summary } satisfies DocumentSession)
  );
  return sessionId;
}

export async function getDocumentSession(
  sessionId: string | null
): Promise<DocumentSession | null> {
  if (!sessionId) return null;
  try {
    // Upstash auto-deserializes stored JSON, so a string and an object both arrive here.
    const raw = await redis.get<DocumentSession | string>(sessionKey(sessionId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as DocumentSession) : raw;
    return parsed?.documentId ? parsed : null;
  } catch (error) {
    // A Redis failure must read as "no document", never as someone else's document.
    console.error("Error reading document session:", error);
    return null;
  }
}

/**
 * Replace the summary for an existing session, after the user has reviewed and possibly
 * edited it. The session id is not reissued: the document it points at has not changed,
 * and rotating it here would drop the binding mid-flow if the write failed.
 */
export async function updateSessionSummary(
  sessionId: string | null,
  summary: string
): Promise<DocumentSession | null> {
  const session = await getDocumentSession(sessionId);
  if (!session || !sessionId) return null;

  const trimmed = summary.slice(0, MAX_SUMMARY_CHARS);
  const updated: DocumentSession = { documentId: session.documentId, summary: trimmed };
  await redis.setex(sessionKey(sessionId), SESSION_TTL_SECONDS, JSON.stringify(updated));
  return updated;
}

/**
 * Read the session id from a request's Cookie header.
 *
 * Parsed here rather than through next/headers so the route handlers stay callable with a
 * plain Request in tests.
 */
export function readSessionId(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/**
 * HttpOnly is the point: page JavaScript cannot read this, so an XSS bug or a browser
 * extension cannot lift it the way it could lift a vaultId sitting in React state.
 * SameSite=Strict keeps it off cross-site requests, and Secure is dropped in development
 * because localhost is not served over HTTPS.
 */
export function sessionCookieHeader(sessionId: string): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
