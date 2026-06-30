import { GoogleGenerativeAI } from "@google/generative-ai";
import { redactPII, redactTriples, storeVault, storeTriplesInNeo4j, getVault } from "@/lib/pii-redaction";
import { generateDocumentId, generateEmbedding, upsertVectors, pinecone } from "@/utils";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
});

const prompt = `Attached is an image of a clinical report.
Go over the clinical report and identify biomarkers that show slight or large abnormalities. Then summarize in 100 words. You may increase the word limit if the report has multiple pages. Make sure to include numerical values and key details from the report, including report title.

IMPORTANT: Extract ALL text content from the report, including any patient names, dates, contact information, or other identifying details that appear in the document. Include this raw information in your summary so it can be processed for data security.

Additionally, extract entity relationships as triples in the format: {"subject": "Entity A", "predicate": "relationship", "object": "Entity B"}. Focus on medical entities like drugs, conditions, symptoms, treatments, etc. Output as a JSON array of triples.

Output your response in the following JSON format:
{
  "summary": "Your summary text here",
  "triples": [{"subject": "...", "predicate": "...", "object": "..."}, ...]
}

## Response:`;

export async function POST(req: Request, res: Response) {
    const { base64 } = await req.json();
    const filePart = fileToGenerativePart(base64)

    console.log("Processing report extraction...");
    const generatedContent = await model.generateContent([prompt, filePart]);

    console.log(generatedContent);
    const rawResponse = generatedContent.response.candidates![0].content.parts[0].text;

    // Parse the JSON response
    let parsedResponse;
    try {
        parsedResponse = JSON.parse(rawResponse!);
    } catch (error) {
        console.error("Failed to parse Gemini response as JSON:", error);
        return new Response(JSON.stringify({ error: "Invalid response format from Gemini" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const { summary: rawSummary, triples } = parsedResponse;

    // ==================== PII REDACTION ====================
    console.log("🔒 Applying PII redaction to extracted report...");

    // Redact PII from the extracted summary
    const redactionResult = redactPII(rawSummary);

    console.log(`📊 Redacted ${Object.keys(redactionResult.vault).length} PII entities`);
    const documentId = generateDocumentId(redactionResult.redactedText);
    console.log("Document ID:", documentId);

    const existingVault = await getVault(documentId);
    if (existingVault) {
        console.log(`✅ Document already exists: ${documentId}. Refreshing TTL and skipping duplicate storage.`);
        await storeVault(documentId, existingVault);
    } else {
        // Store the vault in Redis for later re-hydration
        await storeVault(documentId, redactionResult.vault);

        // Store redacted content in Pinecone for semantic retrieval
        try {
            const embedding = await generateEmbedding(redactionResult.redactedText);
            await upsertVectors(pinecone, 'medic', [
                {
                    id: documentId,
                    values: embedding,
                    metadata: {
                        documentId,
                        chunk: redactionResult.redactedText,
                        piiCount: Object.keys(redactionResult.vault).length,
                    },
                },
            ], 'diagnosis2');
            console.log('✅ Stored redacted summary in Pinecone');
        } catch (error) {
            console.error('Failed to store redacted summary in Pinecone:', error);
        }
    }

    // ==================== STORE TRIPLES IN NEO4J ====================
    if (triples && Array.isArray(triples)) {
        const redactedTriples = redactTriples(triples, redactionResult.vault);
        console.log(`📈 Storing ${redactedTriples.length} redacted triples in Neo4j...`);
        try {
            await storeTriplesInNeo4j(redactedTriples);
            console.log("✅ Redacted triples stored successfully");
        } catch (error) {
            console.error("Failed to store triples in Neo4j:", error);
            // Continue without failing the request
        }
    }

    // Return both redacted summary and vault ID
    const response = {
        redactedSummary: redactionResult.redactedText,
        vaultId: documentId,
        piiCount: Object.keys(redactionResult.vault).length,
        triplesStored: triples ? triples.length : 0,
    };

    console.log("✅ Report processed with PII redaction and GraphRAG storage");
    return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

function fileToGenerativePart(imageData: string) {
    return {
        inlineData: {
            data: imageData.split(",")[1],
            mimeType: imageData.substring(
                imageData.indexOf(":") + 1,
                imageData.lastIndexOf(";")
            ),
        },
    }
}