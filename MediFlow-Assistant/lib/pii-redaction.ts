import { Redis } from "@upstash/redis";
import neo4j from "neo4j-driver";

// Use the same Redis instance for both caching and vault
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Neo4j driver setup
// Example URI for AuraDB: "neo4j+s://<your-database-id>.databases.neo4j.io"
const neo4jUri = process.env.NEO4J_URI ?? "";
const neo4jUser = process.env.NEO4J_USER ?? "";
const neo4jPassword = process.env.NEO4J_PASSWORD ?? "";

if (!neo4jUri || !neo4jUser || !neo4jPassword) {
  throw new Error("NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD must all be set in the environment.");
}

const neo4jDriver = neo4j.driver(
  neo4jUri,
  neo4j.auth.basic(neo4jUser, neo4jPassword)
);

export async function verifyNeo4jConnectivity(): Promise<void> {
  try {
    await neo4jDriver.verifyConnectivity();
    console.log("✅ Neo4j connectivity verified.");
  } catch (error) {
    console.error("❌ Neo4j connectivity check failed:", error);
    throw error;
  }
}

// PII Entity types we want to detect and redact
const PII_PATTERNS = {
  // Names (basic pattern - can be enhanced with NLP)
  NAME: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g,

  // Phone numbers (various formats)
  PHONE: /(\+?\d{1,3}[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g,

  // Email addresses
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

  // Social Security Numbers (US format)
  SSN: /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g,

  // Dates of birth (various formats)
  DOB: /\b\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b/g,

  // Medical Record Numbers (common patterns)
  MRN: /\b(MRN|Medical Record|Patient ID)[:\s]*[A-Z0-9-]+\b/gi,

  // Addresses (basic street address pattern)
  ADDRESS: /\b\d+\s+[A-Za-z0-9\s,.-]+\b/g,
};

interface TokenVault {
  [token: string]: string; // token -> original value
}

interface RedactionResult {
  redactedText: string;
  vault: TokenVault;
  vaultId: string;
}

/**
 * Generate a unique token for PII replacement
 */
function generateToken(type: string, index: number): string {
  return `[${type}_${index}]`;
}

/**
 * Create a unique vault ID for this redaction session
 */
function generateVaultId(): string {
  return `vault_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Detect and redact PII from text using regex patterns
 * Returns redacted text and a vault mapping tokens to original values
 */
export function redactPII(text: string): RedactionResult {
  let redactedText = text;
  const vault: TokenVault = {};
  const vaultId = generateVaultId();

  // Process each PII pattern
  Object.entries(PII_PATTERNS).forEach(([type, pattern]) => {
    let match;
    let index = 1;

    // Reset lastIndex for global regex
    pattern.lastIndex = 0;

    while ((match = pattern.exec(text)) !== null) {
      const originalValue = match[0];
      const token = generateToken(type, index);

      // Replace in redacted text
      redactedText = redactedText.replace(originalValue, token);

      // Store in vault
      vault[token] = originalValue;

      index++;
    }
  });

  return {
    redactedText,
    vault,
    vaultId,
  };
}

/**
 * Store the token vault in Redis with TTL
 */
export async function storeVault(vaultId: string, vault: TokenVault, ttlSeconds: number = 86400): Promise<void> {
  try {
    await redis.setex(`vault:${vaultId}`, ttlSeconds, JSON.stringify(vault));
    console.log(`Stored vault ${vaultId} with ${Object.keys(vault).length} tokens`);
  } catch (error) {
    console.error("Error storing vault:", error);
    throw error;
  }
}

/**
 * Retrieve vault from Redis
 */
export async function getVault(vaultId: string): Promise<TokenVault | null> {
  try {
    const vaultData = await redis.get<string>(`vault:${vaultId}`);
    if (!vaultData) return null;

    return JSON.parse(vaultData);
  } catch (error) {
    console.error("Error retrieving vault:", error);
    return null;
  }
}

/**
 * Redact user question using the same patterns (no vault needed for questions)
 */
export function redactUserQuestion(question: string): string {
  let redactedQuestion = question;

  // Apply the same patterns but don't store tokens (since we're not saving this)
  Object.entries(PII_PATTERNS).forEach(([type, pattern]) => {
    let match;
    let index = 1;

    pattern.lastIndex = 0;

    while ((match = pattern.exec(question)) !== null) {
      const originalValue = match[0];
      const token = generateToken(type, index);

      redactedQuestion = redactedQuestion.replace(originalValue, token);
      index++;
    }
  });

  return redactedQuestion;
}

/**
 * Re-hydrate text by replacing tokens with original values from vault
 */
export function rehydrateText(text: string, vault: TokenVault): string {
  let rehydratedText = text;

  // Replace each token with its original value
  Object.entries(vault).forEach(([token, originalValue]) => {
    rehydratedText = rehydratedText.replace(new RegExp(token, "g"), originalValue);
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

/**
 * Store extracted triples in Neo4j
 */
export async function storeTriplesInNeo4j(triples: { subject: string; predicate: string; object: string }[]) {
  const session = neo4jDriver.session();
  try {
    for (const { subject, predicate, object } of triples) {
      await session.run(
        `MERGE (a:Entity {name: $subject})
         MERGE (b:Entity {name: $object})
         MERGE (a)-[:RELATIONSHIP {type: $predicate}]->(b)`,
        { subject, predicate, object }
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
 * Query Neo4j for the immediate neighborhood of each extracted entity
 */
export async function queryNeo4jRelationships(entities: string[]) {
  const session = neo4jDriver.session();
  try {
    const relationships: Array<{ source: string; relationship: string; target: string }> = [];

    for (const entity of entities) {
      const result = await session.run(
        `MATCH (a:Entity {name: $entity_name})-[r]-(b:Entity)
         RETURN a.name AS source, type(r) AS relationship, b.name AS target
         LIMIT 10`,
        { entity_name: entity }
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
