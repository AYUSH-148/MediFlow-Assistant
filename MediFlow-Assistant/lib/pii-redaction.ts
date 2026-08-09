import { Redis } from "@upstash/redis";
import neo4j from "neo4j-driver";
import { span, setSpanMetadata } from "@/lib/tracing";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Initialized lazily so builds succeed without Neo4j credentials in the environment.
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
    return true;
  } catch (error) {
    console.error("Neo4j connectivity check failed:", error);
    return false;
  }
}

// PII detection rules. Each rule has a type (used for the token label) and a regex; when
// a regex has a capturing group, only group 1 is redacted (e.g. the name after a
// "Patient:" label), leaving the surrounding context intact.
//
// The patterns are deliberately precise. The whole document is redacted before chunking,
// so broad patterns - any two capitalized words as a NAME, a number followed by anything
// as an ADDRESS - would tokenize large amounts of legitimate clinical data and wreck
// retrieval. Unambiguous PII (email, phone, SSN, MRN) is matched aggressively; contextual
// PII (name, DOB, address) is anchored to labels or structural cues.
//
// Inter-token whitespace uses [ \t], never \s: \s matches newlines, so a multi-word name
// capture would swallow the start of the next line ("John Doe\nDOB") and store a vault
// value that no longer matches the real name elsewhere in the text.

// Field labels and filler that must never be absorbed into a captured name. Without this
// guard "Patient: Rahul Mehta   MRN: 884213" captures "Rahul Mehta MRN", and the plain
// name as it appears in the summary no longer matches that vault value - so it survives
// redaction and reaches the client.
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

  // Same, but with no separator and an ALL-CAPS name - how OCR of a scanned header
  // usually reads ("PATIENT RAHUL MEHTA"). Two or three ALL-CAPS words are required:
  // with no separator to anchor on, a single word would let ordinary prose through,
  // while "PATIENT HAS ANEMIA" is rejected because excluding "HAS" breaks the run.
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
  // words, then a street-type suffix. Case-SENSITIVE and Title-case-anchored on purpose -
  // the abbreviated suffixes (St, Dr, Rd, Ln, Ct, Pl…) otherwise collide with ALL-CAPS
  // clinical terms, matching "St" inside "ST-segment". The trailing (?![-A-Za-z]) rejects
  // hyphenated continuations for the same reason.
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
  // transcribes as "PATIENT RAHUL MEHTA" while the model's summary says "Rahul Mehta";
  // an exact replace leaves that second spelling in place, so the name reaches the
  // browser and the response cache even though it is sitting in the vault. The values
  // are specific enough (names, emails, phone/MRN digits) that loose matching does not
  // endanger surrounding clinical text.
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
 * Store the token vault in Redis with a TTL.
 *
 * Best-effort: if Redis is unreachable, log and continue rather than failing the caller,
 * since the redacted report has already been produced without it.
 *
 * The vault maps every placeholder back to its real value, so shipping it to a trace
 * backend alongside the redacted text would hand over both the ciphertext and the key.
 * Only token labels and the count are recorded unless PHI capture is enabled.
 */
export async function storeVault(vaultId: string, vault: TokenVault, ttlSeconds: number = 86400): Promise<boolean> {
  return span(
    "vault_store",
    { vaultId, vault, ttlSeconds },
    async () => {
      try {
        await redis.setex(`vault:${vaultId}`, ttlSeconds, JSON.stringify(vault));
        setSpanMetadata({ stored: true, tokenCount: Object.keys(vault).length });
        return true;
      } catch (error) {
        console.error("Error storing vault:", error);
        setSpanMetadata({
          stored: false,
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    {
      runType: "chain",
      tags: ["vault", "redis", "write", "pii-boundary"],
      safeInputs: {
        vaultId,
        ttlSeconds,
        tokenCount: Object.keys(vault).length,
        tokens: Object.keys(vault),
      },
      safeOutputs: (stored) => ({ stored }),
    }
  );
}

export async function getVault(vaultId: string): Promise<TokenVault | null> {
  return span(
    "vault_fetch",
    { vaultId },
    async () => {
      try {
        // Upstash auto-deserializes stored JSON, so get() returns an object even though
        // storeVault() wrote a string. Both are handled - JSON.parse on an object throws
        // and would silently disable rehydration.
        const vaultData = await redis.get<TokenVault | string>(`vault:${vaultId}`);
        if (!vaultData) {
          // A miss here is why an answer can come back still full of "[NAME_1]".
          setSpanMetadata({ found: false });
          return null;
        }

        const vault =
          typeof vaultData === "string" ? (JSON.parse(vaultData) as TokenVault) : vaultData;
        setSpanMetadata({ found: true, tokenCount: Object.keys(vault).length });
        return vault;
      } catch (error) {
        console.error("Error retrieving vault:", error);
        setSpanMetadata({
          found: false,
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    {
      runType: "retriever",
      tags: ["vault", "redis", "pii-boundary"],
      safeOutputs: (vault) => ({
        found: vault !== null,
        tokenCount: vault ? Object.keys(vault).length : 0,
        tokens: vault ? Object.keys(vault) : [],
      }),
    }
  );
}

/**
 * Redact a user question with the same rules. The vault is discarded - questions are
 * never rehydrated - so token numbering here is independent of the document vault. This
 * only keeps PII out of the semantic cache, the retrieval query, and the prompt.
 */
export function redactUserQuestion(question: string): string {
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

/** Replace vault tokens in `text` with the original values. */
export function rehydrateText(text: string, vault: TokenVault): string {
  let rehydratedText = text;

  // Literal split/join rather than new RegExp(token): tokens like "[NAME_1]" contain
  // regex-special characters that would otherwise be read as a character class.
  Object.entries(vault).forEach(([token, originalValue]) => {
    rehydratedText = rehydratedText.split(token).join(originalValue);
  });

  return rehydratedText;
}

/** Delete a vault ahead of its TTL. */
export async function cleanupVault(vaultId: string): Promise<void> {
  try {
    await redis.del(`vault:${vaultId}`);
  } catch (error) {
    console.error("Error cleaning up vault:", error);
  }
}

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

// Detects a vault token like [NAME_1] anywhere in a string. Tokens are unique only
// within the document they were redacted from - the counter restarts at 1 for every
// document - so any string carrying one is private to its document.
//
// Deliberately unanchored rather than "is exactly one token": the model glues tokens to
// other text, producing names like "[NAME_4], Delhi" or "0.[ADDRESS_3]/mL". Those still
// carry an identifier, so containment is the correct test.
const CONTAINS_VAULT_TOKEN = /\[[A-Z]+_\d+\]/;

// Global variant for enumerating tokens. Kept separate because a /g regex carries
// lastIndex state, which is unsafe to share with .test() calls.
const ALL_VAULT_TOKENS = /\[[A-Z]+_\d+\]/g;

/**
 * Every distinct vault token appearing in `text`, so callers can assert their absence
 * after rehydration - a surviving token is otherwise a silent failure that shows the user
 * a literal "[NAME_1]". The returned values are token LABELS, never the identifiers
 * behind them, so they are safe to record in a trace.
 */
export function findVaultTokens(text: string): string[] {
  return Array.from(new Set(text.match(ALL_VAULT_TOKENS) ?? []));
}

// The same test for Neo4j's `=~`, which uses Java regex syntax and is fully anchored -
// hence the explicit .* on both ends. Passed as a query parameter rather than inlined, so
// the backslashes never have to survive Cypher's string-literal escaping. Keep in sync
// with the RegExp above.
const CYPHER_CONTAINS_VAULT_TOKEN = ".*\\[[A-Z]+_\\d+\\].*";

/**
 * Whether a triple element must be kept private to its source document. Two independent
 * reasons, because token shape alone only fingerprints what the redactor happened to
 * catch:
 *
 *  - it carries a vault token, so redaction already identified it as PII; or
 *  - it still contains a raw vault VALUE. redactTriples() substitutes case-sensitively,
 *    unlike redactDocument(), so a name can come back through the model in a different
 *    case ("RAHUL MEHTA" from a header-derived triple) and survive tokenisation.
 *
 * This makes the node private, which stops it bridging documents; it does NOT un-write
 * the raw value from the node name.
 */
function isDocumentPrivate(text: string, vault?: TokenVault): boolean {
  if (CONTAINS_VAULT_TOKEN.test(text)) return true;
  if (!vault) return false;

  const haystack = text.toLowerCase();
  return Object.values(vault).some(
    (value) => value && haystack.includes(value.toLowerCase())
  );
}

/**
 * Store extracted triples in Neo4j.
 *
 * `documentId` scopes entities carrying patient data (e.g. "[NAME_1]") to the document
 * they came from, so the same token reused across different patients' reports does not
 * merge into one shared node. Generic medical terms ("Aspirin") are left unscoped so the
 * graph still shares that knowledge across documents.
 *
 * Pass `vault` so scoping is decided against what redaction actually found rather than
 * the shape of the string alone - see isDocumentPrivate. Omitting it weakens the decision
 * to shape-only.
 */
export async function storeTriplesInNeo4j(
  triples: { subject: string; predicate: string; object: string }[],
  documentId?: string,
  vault?: TokenVault
) {
  // Triples arrive redacted, but vault substitution only replaces values the
  // label-anchored rules found, so a triple can still carry a name - hence the gating.
  // Counts and the scoping decision are always recorded.
  return span(
    "graph_store_triples",
    { triples, documentId: documentId ?? null, tripleCount: triples.length },
    async () => {
      const driver = getNeo4jDriver();
      if (!driver) {
        console.warn("Neo4j is not configured. Skipping triple storage.");
        // Distinguishes "graph is empty because Neo4j is unconfigured" from
        // "graph is empty because the model extracted nothing".
        setSpanMetadata({ skipped: true, reason: "neo4j-not-configured" });
        return { stored: 0, skipped: true };
      }

      const session = driver.session();
      try {
        let scopedNodes = 0;
        // Split out so the trace shows WHY a node was scoped: a vault-value hit means a
        // raw identifier reached the graph despite redaction.
        let scopedByToken = 0;
        let scopedByVaultValue = 0;
        // A private node with no documentId is unattributable, and
        // queryNeo4jRelationships refuses to traverse into those - so it would be written
        // and then be unreachable.
        let unscopeablePrivateNodes = 0;

        for (const { subject, predicate, object } of triples) {
          const subjectPrivate = isDocumentPrivate(subject, vault);
          const objectPrivate = isDocumentPrivate(object, vault);
          const subjectScoped = !!documentId && subjectPrivate;
          const objectScoped = !!documentId && objectPrivate;

          for (const [text, isPrivate, scoped] of [
            [subject, subjectPrivate, subjectScoped],
            [object, objectPrivate, objectScoped],
          ] as Array<[string, boolean, boolean]>) {
            if (!isPrivate) continue;
            if (!scoped) {
              unscopeablePrivateNodes++;
            } else if (CONTAINS_VAULT_TOKEN.test(text)) {
              scopedByToken++;
            } else {
              scopedByVaultValue++;
            }
          }

          if (subjectScoped) scopedNodes++;
          if (objectScoped) scopedNodes++;

          const subjectMerge = subjectScoped
            ? `MERGE (a:Entity {name: $subject, documentId: $documentId})`
            : `MERGE (a:Entity {name: $subject})`;
          const objectMerge = objectScoped
            ? `MERGE (b:Entity {name: $object, documentId: $documentId})`
            : `MERGE (b:Entity {name: $object})`;

          await session.run(
            `${subjectMerge}
             ${objectMerge}
             MERGE (a)-[:RELATIONSHIP {type: $predicate}]->(b)`,
            { subject, predicate, object, documentId }
          );
        }
        setSpanMetadata({
          stored: triples.length,
          documentScopedNodes: scopedNodes,
          scopedByToken,
          // Non-zero means redaction found the identifier in the report but redactTriples
          // failed to substitute it, so the raw value is now a node name.
          scopedByVaultValue,
          // Non-zero means private data was written unscoped and is now unreachable.
          unscopeablePrivateNodes,
          vaultProvided: !!vault,
        });
        return { stored: triples.length, skipped: false };
      } finally {
        await session.close();
      }
    },
    {
      runType: "chain",
      tags: ["neo4j", "graph", "write"],
      safeInputs: { documentId: documentId ?? null, tripleCount: triples.length },
    }
  );
}

/** Flatten a Neo4j path object into plain JSON. */
function serializeNeo4jPath(path: any): any {
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
 * Query Neo4j for the immediate neighbourhood of each entity.
 *
 * `documentId` scopes the lookup when `entity` carries a vault token, so it matches only
 * the node created for that document rather than every document that produced the same
 * token. Generic medical terms are matched unscoped, as in storeTriplesInNeo4j.
 *
 * The NEIGHBOUR is scoped too, and that is the half that matters. "Atorvastatin" is
 * unscoped by design, so traversing out of it would return the "[NAME_n]" nodes of every
 * patient ever prescribed it - and the chat route then rehydrates through the CURRENT
 * document's vault, resolving another patient's token to this patient's name. The model
 * would be handed a relationship belonging to someone else, and nothing about that output
 * looks wrong from the outside.
 *
 * The neighbour filter tests for a token anywhere in the name rather than for a
 * documentId property, because the graph can hold token-bearing nodes with no documentId
 * (storeTriplesInNeo4j only scopes when one is supplied). Such a node is unattributable,
 * so "no documentId" cannot be read as "generic knowledge". A neighbour is admitted only
 * when it is genuinely generic (no documentId and no token) or scoped to this document.
 *
 * Only the shape can be tested here - the entity name comes from the model, which has
 * only seen redacted text. The vault-value half of the decision belongs on the write
 * path. With no documentId, `b.documentId = null` is UNKNOWN rather than true, so the
 * predicate collapses to the generic-only branch: the right reading of "no report
 * attached".
 */
export async function queryNeo4jRelationships(entities: string[], documentId?: string) {
  const driver = getNeo4jDriver();
  if (!driver) {
    return [];
  }

  const session = driver.session();
  try {
    const relationships: Array<{ source: string; relationship: string; target: string }> = [];
    // The chat route passes "" when no report is attached. Normalising "" and undefined
    // to null keeps the comparison below a plain IS NULL / equality test rather than a
    // match against the empty string, which no node carries.
    const scopeId = documentId ? documentId : null;

    for (const entity of entities) {
      const matchClause = scopeId && CONTAINS_VAULT_TOKEN.test(entity)
        ? `MATCH (a:Entity {name: $entity_name, documentId: $documentId})-[r]-(b:Entity)`
        : `MATCH (a:Entity {name: $entity_name})-[r]-(b:Entity)`;

      const result = await session.run(
        `${matchClause}
         WHERE (b.documentId IS NULL AND NOT b.name =~ $tokenPattern)
            OR b.documentId = $documentId
         RETURN a.name AS source, r.type AS relationship, b.name AS target
         LIMIT 10`,
        {
          entity_name: entity,
          documentId: scopeId,
          tokenPattern: CYPHER_CONTAINS_VAULT_TOKEN,
        }
      );

      for (const record of result.records) {
        relationships.push({
          source: record.get("source"),
          relationship: record.get("relationship"),
          target: record.get("target"),
        });
      }
    }

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
