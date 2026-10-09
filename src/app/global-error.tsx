"use client";

/**
 * Last-resort boundary for failures in the root layout itself. It renders its
 * own <html>/<body> and does not receive the app's global styles or fonts, so
 * styling here must be self-contained. Metadata exports are unavailable in an
 * error boundary, hence the inline <title>.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <title>Job Radar — application error</title>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          // Matches the product's dark surface (globals.css tokens) because this
          // boundary renders outside the app shell and cannot read them.
          backgroundColor: "#08090c",
          color: "#f4f5f7",
          colorScheme: "dark",
        }}
      >
        <div style={{ maxWidth: "28rem", padding: "1.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
            Job Radar could not start
          </h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#9aa1ad" }}>
            A failure happened outside the page. Reloading the application is the
            next step.
          </p>
          {error.digest ? (
            <p
              style={{
                marginTop: "0.75rem",
                fontSize: "0.75rem",
                fontFamily: "ui-monospace, monospace",
                color: "#6b7280",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: "1.25rem",
              padding: "0.5rem 1rem",
              borderRadius: "9999px",
              border: "1px solid rgba(16, 185, 129, 0.4)",
              backgroundColor: "#10b981",
              color: "#022c22",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}