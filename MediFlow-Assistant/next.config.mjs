/** @type {import('next').NextConfig} */
const nextConfig = {
    // (Optional) Export as a standalone site
    // See https://nextjs.org/docs/pages/api-reference/next-config-js/output#automatically-copying-traced-files
    output: 'standalone', // Feel free to modify/remove this option
    
    // Indicate that these packages should not be bundled by webpack
    experimental: {
        serverComponentsExternalPackages: ['sharp', 'onnxruntime-node', 'pdf-parse', 'pdfjs-dist', '@napi-rs/canvas'],

        // Two pdf-parse dependencies that file tracing cannot see, both reached through
        // runtime strings rather than imports, so nothing in the graph points at them.
        //
        // @napi-rs/canvas polyfills DOMMatrix/ImageData/Path2D under Node and is loaded
        // through a guarded require; without it the module threw as it loaded and every
        // request to the ingest route 500'd. pdf.worker.mjs is resolved from a
        // `workerSrc ||= "./pdf.worker.mjs"` default; without it the text layer failed
        // with "Setting up fake worker failed" and every PDF fell back to Gemini OCR.
        outputFileTracingIncludes: {
            '/api/extractreportgemini': [
                './node_modules/@napi-rs/canvas*/**/*',
                './node_modules/pdf-parse/dist/pdf-parse/cjs/**/*',
            ],
        },
    },
};

export default nextConfig;
