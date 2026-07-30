import { Redis } from "@upstash/redis";
import neo4j from "neo4j-driver";

// Use the same Redis instance for both caching and vault
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Neo4j driver setup is initialized lazily so builds can succeed even when
// these credentials are not present in the current environment.
let neo4jDriver: any = null;

function getNeo4jDriver() {
  if (neo4jDriver) return neo4jDriver;

  const neo4jUri = process.env.NEO4J_URI ?? "";
  const neo4jUser = process.env.NEO4J_USER ?? "";
  const neo4jPassword = process.env.NEO4J_PASSWORD ?? "";

  if (!neo4jUri || !neo4jUser || !neo4jPassword) {
    console.warn("Neo4j credentials are not configured. Graph features will be skipped.");
    return null;
  }

  neo4jDriver = neo4j.driver(
    neo4jUri,
    neo4j.auth.basic(neo4jUser, neo4jPassword)
  );

  return neo4jDriver;
}

export async function verifyNeo4jConnectivity(): Promise<boolean> {
  const driver = getNeo4jDriver();
  if (!driver) {
    console.warn("Neo4j connectivity skipped because credentials are not configured.");
    return false;
  }

  try {
    await driver.verifyConnectivity();
    console.log("✅ Neo4j connectivity verified.");
    return true;
  } catch (error) {
    console.error("❌ Neo4j connectivity check failed:", error);
    return false;
  }
}

// PII detection rules. Each rule has a type (used for the token label) and a regex.
// When a regex has a capturing group, only group 1 is treated as PII and redacted
// (e.g. the name after a "Patient:" label), leaving the surrounding context intact.
//
// These patterns are intentionally precise. The pipeline now redacts the ENTIRE
// document before chunking (not just a short summary), so broad patterns like the
// old NAME (any two capitalized words) or ADDRESS (a number followed by anything,
// spanning newlines) would tokenize large amounts of legitimate clinical data and
// wreck retrieval. Unambiguous PII (email, phone, SSN, MRN) stays aggressively matched;
// contextual PII (name, DOB, address) is anchored to labels or structural cues.
// NOTE: inter-token whitespace uses [ \t] (never \s), because \s matches newlines and a
// multi-word capture like a name would greedily swallow the start of the next line
// (e.g. "John Doe\nDOB"), producing a vault value that no longer matches the real name
// elsewhere and leaving it un-redacted.
// Words that must never be absorbed into a captured name: neighbouring field labels and
// common filler. Without this guard the name capture runs past the end of the name and
// into the next column of the header - "Patient: Rahul Mehta   MRN: 884213" yielded the
// name "Rahul Mehta MRN", which is then what lands in the vault. The plain name, as it
// appears in the model's summary, no longer matches that value, so it survives redaction
// and reaches the client.
const NON_NAME_WORDS = [
  "MRN", "DOB", "ID", "SSN", "SEX", "GENDER", "AGE", "TEL", "FAX", "PHONE", "MOBILE",
  "EMAIL", "DATE", "TIME", "ADDRESS", "NUMBER", "NO", "REF", "VISIT", "ACCESSION",
  "PATIENT", "REPORT", "LAB", "LABORATORY", "TEST", "TESTS", "RESULT", "RESULTS",
  "SPECIMEN", "COLLECTED", "RECEIVED", "REFERENCE", "RANGE", "IMPRESSION",
  "HAS", "HAD", "WITH", "AND", "THE", "FOR", "NOT", "ON", "OFF", "IS", "WAS", "ARE",
  "OF", "TO", "IN", "AT", "BY",
];

// Report headers spell these either ALL-CAPS or Title-case, so block both forms.
const NOT_NAME_WORD = `(?!(?:${NON_NAME_WORDS.flatMap((w) => [
  w,
  w[0] + w.slice(1).toLowerCase(),
]).join("|")})\\b)`;

// Name labels, each accepted ALL-CAPS or Title-case. Longest first so "Patient Name"
// is preferred over a bare "Patient".
const NAME_LABELS = [
  "Patient's Name", "Patient Name", "Referring Physician", "Ordering Physician",
  "Attending Physician", "Patient", "Name", "Physician", "Provider", "Doctor",
  "Attending", "Dr",
]
  .map((label) =>
    label
      .split(" ")
      .map((w) => `(?:${w.toUpperCase()}|${w[0].toUpperCase()}${w.slice(1).toLowerCase()})`)
      .join("[ \\t]+")
  )
  .join("|");

const PII_RULES: Array<{ type: string; regex: RegExp }> = [
  // Email addresses
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },

  // Phone / fax numbers (various formats)
  { type: "PHONE", regex: /(?:\+?\d{1,3}[-.\t ]?)?\(?\d{3}\)?[-.\t ]?\d{3}[-.\t ]?\d{4}\b/g },

  // US Social Security Numbers (require dashes to avoid matching plain 9-digit IDs)
  { type: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },

  // Medical Record Number / Patient ID (label-anchored; capture the identifier)
  { type: "MRN", regex: /\b(?:MRN|Medical Record(?:[ \t]*(?:No\.?|Number|#))?|Patient[ \t]*ID)[ \t]*[:#\-]?[ \t]*([A-Z0-9][A-Z0-9-]{3,})/gi },

  // Date of birth (label-anchored; capture only the date so other clinical dates survive)
  { type: "DOB", regex: /\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth[ \t]*Date)[ \t]*[:\-]?[ \t]*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/gi },

  // Patient / provider name, label-anchored with an explicit separator; captures the
  // name only. One or two extra words are allowed (so a single-word name is caught),
  // each gated by NOT_NAME_WORD, and the inter-word gap is capped at two spaces so the
  // capture cannot jump the wide whitespace gap between header columns.
  {
    type: "NAME",
    regex: new RegExp(
      `\\b(?:${NAME_LABELS})[ \\t]*[:\\-][ \\t]*` +
        `(${NOT_NAME_WORD}[A-Z][A-Za-z'’.\\-]+(?:[ \\t]{1,2}${NOT_NAME_WORD}[A-Z][A-Za-z'’.\\-]+){0,2})`,
      "g"
    ),
  },

  // Same, but with no separator and an ALL-CAPS name - which is how OCR of a scanned or
  // photographed header usually reads ("PATIENT RAHUL MEHTA"). Two or three ALL-CAPS
  // words are required here: without a separator to anchor on, a single word would let
  // ordinary prose through, whereas a phrase like "PATIENT HAS ANEMIA" is rejected
  // because "HAS" is excluded and that breaks the required run.
  {
    type: "NAME",
    regex: new RegExp(
      `\\b(?:${NAME_LABELS})[ \\t]+` +
        `(${NOT_NAME_WORD}[A-Z][A-Z'’.\\-]+(?:[ \\t]{1,2}${NOT_NAME_WORD}[A-Z][A-Z'’.\\-]+){1,2})`,
      "g"
    ),
  },

  // Titled name without a label (Dr./Mr./Mrs./Ms./Prof.; capture the name, drop the title)
  { type: "NAME", regex: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){0,2})\b/g },

  // Street address on a single line: a house number, one to four Title-cased street-name
  // words, then a street-type suffix. Case-SENSITIVE (no /i) and Title-case-anchored on
  // purpose: the abbreviated suffixes (St, Dr, Rd, Ln, Ct, Pl…) collide with common
  // ALL-CAPS clinical terms otherwise — e.g. the old case-insensitive rule matched "St"
  // inside "ST-segment" and swallowed "Stage 2 … ST" into one ADDRESS token. The trailing
  // (?![-A-Za-z]) also rejects hyphenated continuations like "St-segment".
  { type: "ADDRESS", regex: /\b\d{1,6}[ \t]+(?:[A-Z][A-Za-z0-9.\-]*[ \t]+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Suite|Ste|Apt|Unit)\.?(?![-A-Za-z])/g },
];

// Values discovered by the rules above are substituted as literals, not as patterns.
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TokenVault {
  [token: string]: string; // token -> original value
}

interface RedactionResult {
  redactedText: string;
  vault: TokenVault;
  vaultId: string;
}

/**
 * Create a unique vault ID for this redaction session
 */
function generateVaultId(): string {
  return `vault_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Redact PII across one or more texts using a SINGLE shared vault.
 *
 * This is the primitive the rest of the module builds on. It runs in two phases so
 * that token assignment is consistent everywhere:
 *   1. Discover every distinct PII value across all texts and assign it one token
 *      (deduped by value, so the same person/number always maps to the same token,
 *      even across chunks and the summary).
 *   2. Replace each discovered value with its token in every text, longest value
 *      first so shorter values can't partially clobber a longer one.
 */
export function redactDocument(texts: string[]): { redactedTexts: string[]; vault: TokenVault } {
  const vault: TokenVault = {};
  const valueToToken = new Map<string, string>();
  const typeCounters: Record<string, number> = {};

  for (const text of texts) {
    for (const { type, regex } of PII_RULES) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        // Guard against zero-length matches causing an infinite loop.
        if (match.index === regex.lastIndex) regex.lastIndex++;

        const value = (match[1] ?? match[0]).trim();
        if (!value) continue;

        if (!valueToToken.has(value)) {
          const next = (typeCounters[type] ?? 0) + 1;
          typeCounters[type] = next;
          const token = `[${type}_${next}]`;
          valueToToken.set(value, token);
          vault[token] = value;
        }
      }
    }
  }

  // Replacement is case-INSENSITIVE and tolerant of whitespace width. A scanned report
  // transcribes as "PATIENT RAHUL MEHTA" while the model's summary refers to "Rahul
  // Mehta"; an exact replace leaves that second spelling in place, so the name reaches
  // the browser and the response cache even though it is sitting in the vault. The
  // values here are specific (names, emails, phone/MRN digits), so matching them
  // loosely does not endanger surrounding clinical text.
  const orderedValues = Array.from(valueToToken.keys()).sort((a, b) => b.length - a.length);
  const redactedTexts = texts.map((text) => {
    let out = text;
    for (const value of orderedValues) {
      const token = valueToToken.get(value)!;
      const pattern = escapeRegExp(value).replace(/[ \t]+/g, "[ \\t]+");
      out = out.replace(new RegExp(pattern, "gi"), () => token);
    }
    return out;
  });

  return { redactedTexts, vault };
}

/**
 * Detect and redact PII from a single text.
 * Returns redacted text and a vault mapping tokens to original values.
 */
export function redactPII(text: string): RedactionResult {
  const { redactedTexts, vault } = redactDocument([text]);
  return {
    redactedText: redactedTexts[0],
    vault,
    vaultId: generateVaultId(),
  };
}

/**
 * Store the token vault in Redis with TTL.
 * Best-effort: if Redis is unreachable, log and continue rather than failing the caller,
 * since the redacted report has already been produced without it.
 */
export async function storeVault(vaultId: string, vault: TokenVault, ttlSeconds: number = 86400): Promise<boolean> {
  try {
    await redis.setex(`vault:${vaultId}`, ttlSeconds, JSON.stringify(vault));
    console.log(`Stored vault ${vaultId} with ${Object.keys(vault).length} tokens`);
    return true;
  } catch (error) {
    console.error("Error storing vault:", error);
    return false;
  }
}

/**
 * Retrieve vault from Redis
 */
export async function getVault(vaultId: string): Promise<TokenVault | null> {
  try {
    // Upstash Redis auto-deserializes stored JSON: get() returns an object here even
    // though storeVault() wrote a JSON string. Handle both so we never JSON.parse an
    // object (which throws and silently disables PII rehydration).
    const vaultData = await redis.get<TokenVault | string>(`vault:${vaultId}`);
    if (!vaultData) return null;

    return typeof vaultData === "string" ? (JSON.parse(vaultData) as TokenVault) : vaultData;
  } catch (error) {
    console.error("Error retrieving vault:", error);
    return null;
  }
}

/**
 * Redact user question using the same patterns (no vault needed for questions)
 */
export function redactUserQuestion(question: string): string {
  // Reuse the shared redactor; the vault it builds is discarded because questions
  // are never rehydrated (only the report/answer are). Token numbering here is
  // independent of the document vault, which is fine: this only keeps PII out of
  // the semantic cache, retrieval query, and LLM prompt.
  return redactDocument([question]).redactedTexts[0];
}

/**
 * Redact entity triples using an existing vault: any subject/predicate/object
 * that contains a value already present in the vault is replaced with its token.
 */
export function redactTriples(
  triples: { subject: string; predicate: string; object: string }[],
  vault: TokenVault
): { subject: string; predicate: string; object: string }[] {
  const applyVault = (text: string): string => {
    let result = text;
    for (const [token, originalValue] of Object.entries(vault)) {
      if (originalValue) {
        result = result.split(originalValue).join(token);
      }
    }
    return result;
  };

  return triples.map(({ subject, predicate, object }) => ({
    subject: applyVault(subject),
    predicate: applyVault(predicate),
    object: applyVault(object),
  }));
}

/**
 * Re-hydrate text by replacing tokens with original values from vault
 */
export function rehydrateText(text: string, vault: TokenVault): string {
  let rehydratedText = text;

  // Use literal split/join rather than new RegExp(token): tokens like "[NAME_1]"
  // contain regex-special characters ([, ]) that would otherwise be interpreted as
  // a character class and corrupt the output.
  Object.entries(vault).forEach(([token, originalValue]) => {
    rehydratedText = rehydratedText.split(token).join(originalValue);
  });

  return rehydratedText;
}

/**
 * Clean up vault from Redis (optional - TTL will handle this automatically)
 */
export async function cleanupVault(vaultId: string): Promise<void> {
  try {
    await redis.del(`vault:${vaultId}`);
    console.log(`Cleaned up vault ${vaultId}`);
  } catch (error) {
    console.error("Error cleaning up vault:", error);
  }
}

/**
 * Get vault statistics
 */
export async function getVaultStats(vaultId: string) {
  try {
    const vault = await getVault(vaultId);
    if (!vault) return null;

    return {
      vaultId,
      tokenCount: Object.keys(vault).length,
      tokens: Object.keys(vault),
    };
  } catch (error) {
    console.error("Error getting vault stats:", error);
    return null;
  }
}

// Matches vault tokens like [NAME_1] or [PHONE_2]. These are only unique within the
// document they were redacted from - redactPII() restarts the counter at 1 for every
// document, so "[NAME_1]" from one patient's report is a different person than
// "[NAME_1]" from another's.
const VAULT_TOKEN_PATTERN = /^\[[A-Z]+_\d+\]$/;

/**
 * Store extracted triples in Neo4j.
 *
 * `documentId` scopes vault-token entities (e.g. "[NAME_1]") to the document they came
 * from, so the same token reused across different patients' reports doesn't merge into
 * one shared node. Generic medical terms (e.g. "Aspirin") are left unscoped so the graph
 * still shares that knowledge across documents.
 */
export async function storeTriplesInNeo4j(
  triples: { subject: string; predicate: string; object: string }[],
  documentId?: string
) {
  const driver = getNeo4jDriver();
  if (!driver) {
    console.warn("Neo4j is not configured. Skipping triple storage.");
    return;
  }

  const session = driver.session();
  try {
    for (const { subject, predicate, object } of triples) {
      const subjectMerge = documentId && VAULT_TOKEN_PATTERN.test(subject)
        ? `MERGE (a:Entity {name: $subject, documentId: $documentId})`
        : `MERGE (a:Entity {name: $subject})`;
      const objectMerge = documentId && VAULT_TOKEN_PATTERN.test(object)
        ? `MERGE (b:Entity {name: $object, documentId: $documentId})`
        : `MERGE (b:Entity {name: $object})`;

      await session.run(
        `${subjectMerge}
         ${objectMerge}
         MERGE (a)-[:RELATIONSHIP {type: $predicate}]->(b)`,
        { subject, predicate, object, documentId }
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Serialize Neo4j path objects into clean JSON for Gemini consumption
 */
function serializeNeo4jPath(path: any): any {
  // Handle single-segment paths (most common case)
  if (path.segments && path.segments.length > 0) {
    const segment = path.segments[0];
    return {
      start: segment.start.properties.name,
      end: segment.end.properties.name,
      relationship: segment.relationship.properties.type,
    };
  }
  
  // Fallback for other path structures
  return {
    start: path.start?.properties?.name || "Unknown",
    end: path.end?.properties?.name || "Unknown",
    relationship: path.relationship?.properties?.type || "Unknown",
  };
}

/**
 * Query Neo4j for the immediate neighborhood of each extracted entity.
 *
 * `documentId` scopes the lookup when `entity` is a vault token (e.g. "[NAME_1]"), so it
 * only matches the node created for that specific document instead of every document
 * that happened to produce the same token. Generic medical terms are matched unscoped,
 * same as in storeTriplesInNeo4j.
 */
export async function queryNeo4jRelationships(entities: string[], documentId?: string) {
  const driver = getNeo4jDriver();
  if (!driver) {
    return [];
  }

  const session = driver.session();
  try {
    const relationships: Array<{ source: string; relationship: string; target: string }> = [];

    for (const entity of entities) {
      const matchClause = documentId && VAULT_TOKEN_PATTERN.test(entity)
        ? `MATCH (a:Entity {name: $entity_name, documentId: $documentId})-[r]-(b:Entity)`
        : `MATCH (a:Entity {name: $entity_name})-[r]-(b:Entity)`;

      const result = await session.run(
        `${matchClause}
         RETURN a.name AS source, r.type AS relationship, b.name AS target
         LIMIT 10`,
        { entity_name: entity, documentId }
      );

      for (const record of result.records) {
        relationships.push({
          source: record.get("source"),
          relationship: record.get("relationship"),
          target: record.get("target"),
        });
      }
    }

    // Deduplicate similar triples
    return relationships.filter((item, index, self) =>
      index === self.findIndex((other) =>
        other.source === item.source &&
        other.relationship === item.relationship &&
        other.target === item.target
      )
    );
  } finally {
    await session.close();
  }
}
