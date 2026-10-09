import { describe, expect, it } from "vitest";

import {
  certificationSchema,
  educationSchema,
  experienceSchema,
  jobPreferencesSchema,
  jobProfileSchema,
  normalizeStringList,
  projectSchema,
  resumeProfileSchema,
} from "@/lib/profile/schemas";

describe("normalizeStringList", () => {
  it("trims entries, drops blank ones, and removes exact duplicates", () => {
    expect(
      normalizeStringList(["  React ", "", "   ", "React", "Node", "Node ", "node"]),
    ).toEqual(["React", "Node", "node"]);
  });

  it("keeps first-seen ordering and original casing", () => {
    expect(normalizeStringList(["TS", "Java", "TS", "TS"])).toEqual(["TS", "Java"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(normalizeStringList([])).toEqual([]);
  });
});

describe("educationSchema", () => {
  it("requires school and degree", () => {
    const result = educationSchema.safeParse({ school: "  ", degree: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "school",
        "degree",
      ]);
    }
  });

  it("defaults currentlyStudying to false and accepts a missing end year", () => {
    const result = educationSchema.parse({
      school: "  State University ",
      degree: "BSc Computer Science",
      currentlyStudying: true,
    });

    expect(result).toEqual({
      school: "State University",
      degree: "BSc Computer Science",
      fieldOfStudy: undefined,
      grade: undefined,
      startYear: undefined,
      endYear: undefined,
      currentlyStudying: true,
    });
  });

  it("rejects an end year before the start year", () => {
    const result = educationSchema.safeParse({
      school: "State University",
      degree: "BSc",
      startYear: 2022,
      endYear: 2019,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["endYear"]);
    }
  });

  it("rejects implausible years", () => {
    expect(
      educationSchema.safeParse({ school: "S", degree: "D", startYear: 200 }).success,
    ).toBe(false);
    expect(
      educationSchema.safeParse({ school: "S", degree: "D", endYear: 3000 }).success,
    ).toBe(false);
  });
});

describe("experienceSchema", () => {
  it("requires company and title", () => {
    expect(experienceSchema.safeParse({ company: "Acme" }).success).toBe(false);
  });

  it("accepts several date shapes and normalizes them", () => {
    const result = experienceSchema.parse({
      company: " Acme ",
      title: " Engineer ",
      startDate: " 2021-03 ",
      endDate: "Present",
    });

    expect(result.startDate).toBe("2021-03");
    expect(result.endDate).toBe("Present");
    expect(result.currentlyWorking).toBe(false);
  });

  it("rejects a date that is not a recognizable shape", () => {
    expect(
      experienceSchema.safeParse({ company: "Acme", title: "E", startDate: "spring" }).success,
    ).toBe(false);
  });
});

describe("projectSchema", () => {
  it("normalizes technologies and defaults the list to empty", () => {
    expect(projectSchema.parse({ name: "Radar" })).toEqual({
      name: "Radar",
      description: undefined,
      link: undefined,
      technologies: [],
      startDate: undefined,
      endDate: undefined,
    });

    expect(
      projectSchema.parse({ name: "Radar", technologies: [" Node ", "Node", ""] }).technologies,
    ).toEqual(["Node"]);
  });

  it("accepts http and https links", () => {
    expect(projectSchema.safeParse({ name: "R", link: "https://a.dev" }).success).toBe(true);
    expect(projectSchema.safeParse({ name: "R", link: "http://a.dev" }).success).toBe(true);
  });

  it("rejects a link with an unsafe or invalid scheme", () => {
    expect(projectSchema.safeParse({ name: "R", link: "javascript:alert(1)" }).success).toBe(false);
    expect(projectSchema.safeParse({ name: "R", link: "ftp://a.dev" }).success).toBe(false);
    expect(projectSchema.safeParse({ name: "R", link: "not a url" }).success).toBe(false);
  });
});

describe("certificationSchema", () => {
  it("requires name and issuer", () => {
    expect(certificationSchema.safeParse({ name: "AWS SAA" }).success).toBe(false);
  });

  it("accepts an optional credential id and link", () => {
    const result = certificationSchema.parse({
      name: "AWS SAA",
      issuer: " Amazon ",
      date: "2023-05",
      credentialId: "ABC123",
      link: "https://cert.example",
    });

    expect(result.issuer).toBe("Amazon");
    expect(result.date).toBe("2023-05");
  });
});

describe("resumeProfileSchema", () => {
  it("requires a non-empty name after trimming", () => {
    expect(resumeProfileSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(resumeProfileSchema.parse({ name: " Ada " }).name).toBe("Ada");
  });

  it("defaults every collection and strips unknown keys", () => {
    const result = resumeProfileSchema.parse({
      name: "Ada",
      skills: [" TypeScript ", "TypeScript", ""],
      injected: "should not survive",
    });

    expect(result).toMatchObject({
      name: "Ada",
      skills: ["TypeScript"],
      technologies: [],
      languages: [],
      education: [],
      experience: [],
      projects: [],
      certifications: [],
    });
    expect(Object.hasOwn(result, "injected")).toBe(false);
  });

  it("validates nested entries", () => {
    expect(
      resumeProfileSchema.safeParse({ name: "Ada", projects: [{ description: "no name" }] })
        .success,
    ).toBe(false);
  });
});

describe("jobPreferencesSchema", () => {
  it("treats an empty target-role list as unanswered rather than invalid", () => {
    // The resume parser cannot know someone's intended next role and must still
    // be able to create a profile, so an empty list is a question left open —
    // not a filter that matches nothing. `{}` is the same thing.
    expect(jobPreferencesSchema.safeParse({ targetRoles: [] }).success).toBe(true);
    expect(jobPreferencesSchema.safeParse({ targetRoles: ["   "] }).success).toBe(true);
    expect(jobPreferencesSchema.safeParse({}).success).toBe(true);
    expect(jobPreferencesSchema.parse({ targetRoles: ["   "] }).targetRoles).toEqual([]);
  });

  it("still refuses a target-roles value that is not a list", () => {
    expect(jobPreferencesSchema.safeParse({ targetRoles: "Backend" }).success).toBe(false);
    expect(jobPreferencesSchema.safeParse({ targetRoles: [1, 2] }).success).toBe(false);
  });

  it("applies documented defaults", () => {
    const result = jobPreferencesSchema.parse({ targetRoles: [" Backend " ] });

    expect(result).toEqual({
      targetRoles: ["Backend"],
      locations: [],
      jobTypes: [],
      experienceLevel: "mid",
      minimumSalary: undefined,
      salaryCurrency: undefined,
      remoteOnly: false,
      freshnessDays: 7,
    });
  });

  it("rejects an unknown experience level or freshness value", () => {
    expect(
      jobPreferencesSchema.safeParse({ targetRoles: ["a"], experienceLevel: "expert" }).success,
    ).toBe(false);
    expect(
      jobPreferencesSchema.safeParse({ targetRoles: ["a"], freshnessDays: 5 }).success,
    ).toBe(false);
  });

  it("accepts only the supported freshness values", () => {
    for (const days of [1, 3, 7, 14]) {
      expect(
        jobPreferencesSchema.safeParse({ targetRoles: ["a"], freshnessDays: days }).success,
      ).toBe(true);
    }
  });

  it("rejects a negative salary and normalizes the currency", () => {
    expect(
      jobPreferencesSchema.safeParse({ targetRoles: ["a"], minimumSalary: -1 }).success,
    ).toBe(false);

    const result = jobPreferencesSchema.parse({
      targetRoles: ["a"],
      minimumSalary: 0,
      salaryCurrency: " eur ",
    });

    expect(result.minimumSalary).toBe(0);
    expect(result.salaryCurrency).toBe("EUR");
  });

  it("rejects an over-long currency code", () => {
    expect(
      jobPreferencesSchema.safeParse({
        targetRoles: ["a"],
        salaryCurrency: "EUROSOMETHINGLONG",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown job type", () => {
    expect(
      jobPreferencesSchema.safeParse({ targetRoles: ["a"], jobTypes: ["full-time", "wizard"] })
        .success,
    ).toBe(false);
  });
});

describe("jobProfileSchema", () => {
  it("parses a complete minimal profile", () => {
    const result = jobProfileSchema.safeParse({
      resume: { name: "Ada" },
      preferences: { targetRoles: ["Backend Engineer"] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resume.name).toBe("Ada");
      expect(result.data.preferences.freshnessDays).toBe(7);
    }
  });

  it("reports the path of a nested problem", () => {
    const result = jobProfileSchema.safeParse({
      resume: { name: "Ada", experience: [{ company: "Acme" }] },
      preferences: { targetRoles: ["Backend"] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["resume", "experience", 0, "title"]);
    }
  });
});