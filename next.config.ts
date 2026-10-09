import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep pdfjs-dist out of the server bundle.
   *
   * pdf-parse loads its text extractor via pdfjs-dist, which dynamically imports
   * `pdf.worker.mjs` at runtime. When Next bundles pdfjs-dist, that import is
   * rewritten to a dev-server chunk that is never emitted, and extraction fails
   * with "Setting up fake worker failed: Cannot find module 'pdf.worker.mjs'".
   * Loading the package from node_modules at runtime (the way Node and vitest
   * resolve it) makes the worker import resolve to the real file.
   */
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;