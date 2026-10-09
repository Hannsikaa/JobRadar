import { describe, expect, it } from "vitest";

import { projectProfile, type ServerFacts } from "@/components/workflow";
import { emptySnapshot, type WorkflowSnapshot } from "@/lib/workflow/state";

/**
 * `projectProfile` is where the workflow decides what the server's record means
 * for each node, so it is the one place where a fake state could slip in.
 *
 * Every case below is a response the app can actually produce. None of them
 * invents a stage that has no server-side evidence: no file at all leaves Resume
 * Upload idle, and a file with no parsed content leaves Parse Profile short of
 * done even though the file is there.
 */

type Profile = NonNullable<ServerFacts["profile"]>;
type Stored = NonNullable<ServerFacts["resume"]>;

const UPLOADED: Profile = {
  resumeFileId: "68f0c1a2b3c4d5e6f7a8b9c0",
  resume: { name: "Ada Lovelace" },
};

const NOT_PARSED: Profile = {
  resumeFileId: "68f0c1a2b3c4d5e6f7a8b9c0",
  resume: { name: "" },
};

const STORED: Stored = {
  id: "68f0c1a2b3c4d5e6f7a8b9c0",
  originalFilename: "ada.pdf",
};

/** The common shape: profile read first, then resume and filename. */
function project(
  profile: Profile | null,
  resume: Stored | null = null,
  filename: string | null = null
): WorkflowSnapshot {
  return projectProfile(emptySnapshot(), { profile, resume, filename });
}

function statuses(snapshot: WorkflowSnapshot): string[] {
  return Object.values(snapshot).map((state) => state.status);
}

describe("projectProfile", () => {
  it("leaves everything idle when the server has no uploaded resume", () => {
    const snapshot = project({ resumeFileId: undefined });

    expect(statuses(snapshot)).toEqual(["idle", "idle", "idle", "idle", "idle", "idle"]);
  });

  it("leaves everything idle when neither endpoint reports anything", () => {
    const snapshot = projectProfile(emptySnapshot(), { profile: null, resume: null, filename: null });

    expect(statuses(snapshot)).toEqual(["idle", "idle", "idle", "idle", "idle", "idle"]);
  });

  it("treats an empty file id as no resume at all", () => {
    const snapshot = project({ resumeFileId: "" }, null, "cv.pdf");

    expect(statuses(snapshot)).toEqual(["idle", "idle", "idle", "idle", "idle", "idle"]);
  });

  it("marks Resume Upload done once the server has a file id", () => {
    const snapshot = project({ resumeFileId: "abc" }, null, "cv.pdf");

    expect(snapshot["resume-upload"].status).toBe("completed");
    expect(snapshot["resume-upload"].detail).toBe("cv.pdf");
  });

  it("abbreviates the file id when no filename is known", () => {
    const snapshot = project(UPLOADED);

    // Neither endpoint reports a filename, so the node shows the id rather than
    // a document name that was never reported.
    expect(snapshot["resume-upload"].detail).toBe("68f0c1a2…");
  });

  it("shows the real filename when only the resume endpoint knows it", () => {
    // The gap this case exists for: a file uploaded before any profile exists
    // (parse not run, or parse failed) has no `resumeFileId` yet, but the file
    // is on the server and `GET /api/resume` names it.
    const snapshot = project(null, STORED);

    expect(snapshot["resume-upload"].status).toBe("completed");
    expect(snapshot["resume-upload"].detail).toBe("ada.pdf");
    expect(snapshot["parse-profile"].status).toBe("idle");
  });

  it("prefers a filename this tab knows over the stored one", () => {
    const snapshot = project(UPLOADED, STORED, "just-uploaded.pdf");

    expect(snapshot["resume-upload"].detail).toBe("just-uploaded.pdf");
  });

  it("falls back to the stored filename when the profile only has an id", () => {
    const snapshot = project({ resumeFileId: "abc" }, STORED, null);

    expect(snapshot["resume-upload"].detail).toBe("ada.pdf");
  });

  it("does not mark Parse Profile done for an uploaded but unparsed resume", () => {
    const snapshot = project(NOT_PARSED, null, "cv.pdf");

    expect(snapshot["resume-upload"].status).toBe("completed");
    expect(snapshot["parse-profile"].status).toBe("idle");
  });

  it("does not mark Parse Profile done when a resume exists but no profile does", () => {
    const snapshot = project(null, STORED);

    expect(snapshot["parse-profile"].status).toBe("idle");
  });

  it("keeps Parse Profile in flight while a real parse is still running", () => {
    const inFlight: WorkflowSnapshot = {
      ...emptySnapshot(),
      "parse-profile": { status: "processing" },
    };

    expect(
      projectProfile(inFlight, { profile: NOT_PARSED, resume: null, filename: null })[
        "parse-profile"
      ].status
    ).toBe("processing");
  });

  it("marks Parse Profile done once parsed content exists", () => {
    const snapshot = project(UPLOADED, null, "cv.pdf");

    expect(snapshot["parse-profile"].status).toBe("completed");
  });

  it("leaves Review Profile idle until the profile has actually been reviewed", () => {
    const snapshot = project(UPLOADED, null, "cv.pdf");

    // Nothing has been saved through Profile Review yet, so the node points at
    // the page rather than claiming a review that never happened.
    expect(snapshot["review-profile"].status).toBe("idle");
    expect(snapshot["review-profile"].detail).toBe("Open to review");
  });

  it("marks Review Profile done once the profile carries a review timestamp", () => {
    const snapshot = project(
      { ...UPLOADED, reviewedAt: "2026-10-06T12:00:00.000Z" },
      null,
      "cv.pdf"
    );

    expect(snapshot["review-profile"].status).toBe("completed");
    expect(snapshot["review-profile"].detail).toBeUndefined();
  });

  it("drops Review Profile back to idle when a re-parse cleared the timestamp", () => {
    // The repository unsets `reviewedAt` when fresh text replaces what was
    // reviewed, so a replaced resume must not keep showing a review — even if
    // this tab still has the completed state in hand.
    const stale: WorkflowSnapshot = {
      ...emptySnapshot(),
      "resume-upload": { status: "completed" },
      "parse-profile": { status: "completed" },
      "review-profile": { status: "completed" },
    };

    const snapshot = projectProfile(stale, {
      profile: UPLOADED,
      resume: null,
      filename: null,
    });

    expect(snapshot["review-profile"].status).toBe("idle");
    expect(snapshot["review-profile"].detail).toBe("Open to review");
  });

  it("never advances the three discovery stages", () => {
    const snapshot = project(UPLOADED, STORED, "cv.pdf");

    expect(snapshot.serpapi.status).toBe("idle");
    expect(snapshot.process.status).toBe("idle");
    expect(snapshot["job-matches"].status).toBe("idle");
  });

  it("does not mutate the snapshot it was given", () => {
    const before = emptySnapshot();
    project(UPLOADED, STORED, "cv.pdf");

    expect(statuses(before)).toEqual(["idle", "idle", "idle", "idle", "idle", "idle"]);
  });

  it("resets a stale failure when the server reports a clean profile", () => {
    const stale: WorkflowSnapshot = {
      ...emptySnapshot(),
      "resume-upload": { status: "completed" },
      "parse-profile": { status: "failed", error: "The resume could not be parsed." },
    };

    const snapshot = projectProfile(stale, {
      profile: NOT_PARSED,
      resume: null,
      filename: null,
    });

    expect(snapshot["parse-profile"].status).toBe("idle");
    expect(snapshot["parse-profile"].error).toBeUndefined();
  });
});
