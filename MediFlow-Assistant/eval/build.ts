import { loadEnv, requireEnv } from "./lib/env";

// Must run before anything that touches process.env at module load, which is every API
// client in this codebase. Hence the dynamic import of the corpus builder below.
const envFiles = loadEnv();

async function main(): Promise<void> {
  requireEnv(["PINECONE_API_KEY", "HF_TOKEN"]);

  console.log(`Loaded environment from: ${envFiles.length ? envFiles.join(", ") : "(process only)"}`);

  const { buildCorpus } = await import("./lib/corpus");
  const manifest = await buildCorpus();

  const chunks = manifest.reports.reduce((sum, report) => sum + report.chunkCount, 0);
  console.log(
    `\nCorpus ready: ${manifest.reports.length} documents, ${chunks} chunks, ` +
      `chunk size ${manifest.chunkSize} / overlap ${manifest.chunkOverlap}.`
  );
  console.log(`Manifest written to eval/.corpus.json. Run "npm run eval" next.`);
}

main().catch((error) => {
  console.error(`\nCorpus build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
