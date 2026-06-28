import { Redis } from "@upstash/redis";

// Use the same Redis instance for both caching and vault
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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
    rehydratedText = rehydratedText.replace(new RegExp(token, 'g'), originalValue);
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
