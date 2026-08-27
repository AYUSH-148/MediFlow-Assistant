/** @type {import('next').NextConfig} */
const nextConfig = {
    // (Optional) Export as a standalone site
    // See https://nextjs.org/docs/pages/api-reference/next-config-js/output#automatically-copying-traced-files
    output: 'standalone', // Feel free to modify/remove this option
    
    // Indicate that these packages should not be bundled by webpack
    experimental: {
        serverComponentsExternalPackages: ['sharp', 'onnxruntime-node', 'pdf-parse', 'pdfjs-dist', '@napi-rs/canvas'],

        // pdf-parse needs @napi-rs/canvas to polyfill DOMMatrix/ImageData/Path2D under
        // Node, but it loads it through a guarded runtime require that file tracing
        // cannot see - so the binary was left out of the deployed function and every
        // request to the ingest route 500'd. Named explicitly here because nothing in
        // the import graph points at it statically.
        outputFileTracingIncludes: {
            '/api/extractreportgemini': ['./node_modules/@napi-rs/canvas*/**/*'],
        },
    },
};

export default nextConfig;
