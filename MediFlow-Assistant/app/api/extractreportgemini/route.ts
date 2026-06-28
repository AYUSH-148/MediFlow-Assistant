import { GoogleGenerativeAI } from "@google/generative-ai";
import { redactPII, storeVault } from "@/lib/pii-redaction";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
});

const prompt = `Attached is an image of a clinical report.
Go over the clinical report and identify biomarkers that show slight or large abnormalities. Then summarize in 100 words. You may increase the word limit if the report has multiple pages. Make sure to include numerical values and key details from the report, including report title.

IMPORTANT: Extract ALL text content from the report, including any patient names, dates, contact information, or other identifying details that appear in the document. Include this raw information in your summary so it can be processed for data security.

## Summary: `;

export async function POST(req: Request, res: Response) {
    const { base64 } = await req.json();
    const filePart = fileToGenerativePart(base64)

    console.log("Processing report extraction...");
    const generatedContent = await model.generateContent([prompt, filePart]);

    console.log(generatedContent);
    const rawSummary = generatedContent.response.candidates![0].content.parts[0].text;

    // ==================== PII REDACTION ====================
    console.log("🔒 Applying PII redaction to extracted report...");

    // Redact PII from the extracted summary
    const redactionResult = redactPII(rawSummary!);

    console.log(`📊 Redacted ${Object.keys(redactionResult.vault).length} PII entities`);
    console.log("Vault ID:", redactionResult.vaultId);

    // Store the vault in Redis for later re-hydration
    await storeVault(redactionResult.vaultId, redactionResult.vault);

    // Return both redacted summary and vault ID
    const response = {
        redactedSummary: redactionResult.redactedText,
        vaultId: redactionResult.vaultId,
        piiCount: Object.keys(redactionResult.vault).length,
    };

    console.log("✅ Report processed with PII redaction");
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