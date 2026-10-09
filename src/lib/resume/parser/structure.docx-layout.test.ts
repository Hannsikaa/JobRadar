import { describe, expect, it } from "vitest";

import { normalizeText } from "@/lib/resume/parser/normalization";
import { parseResumeStructure } from "@/lib/resume/parser/structure";

/**
 * Regression coverage for a DOCX-shaped resume.
 *
 * DOCX text extraction (mammoth) emits a blank line between every paragraph, so
 * a multi-line job or project has blank lines *inside* the entry. The parser
 * must treat an entry as ending when the next entry starts, not on the first
 * blank line, or one job becomes several entries and one project becomes several
 * projects. The content mirrors a real resume's structure but is fully
 * anonymized; the private resume is intentionally not committed.
 */
const DOCX_SHAPED_RESUME = [
  "Alex Example",
  "",
  "Computer Science Undergraduate | Software Engineering • Backend Systems",
  "",
  "Example City, Example State, India | www.linkedin.com/in/alex-example",
  "",
  "Education",
  "",
  "Bachelor's Degree in Computer Science and Engineering Example Institute of Technology and Science, Sampletown",
  "",
  "Aug 2024 – May 2028 - Pursuing 5th semester",
  "",
  "CGPA: 9.03/10",
  "",
  "Experience",
  "",
  "Acme Labs (Founding Software Developer - Tech Lead) - June 2026- Current",
  "",
  "Built and continue to maintain the Acme Labs website and internal admin system from the ground up, working directly with the founders to translate requirements into a production product.",
  "",
  "Developed the frontend, backend and database functionality using React, Node.js, FastAPI and MongoDB, while working across development, deployment and debugging.",
  "",
  "Progressed into a Tech Lead role, currently guiding a three-person technical team and coordinating development of the product.",
  "",
  "Widget Works(AI & Automation Intern) - June 2026 to September 2026",
  "",
  "Contributed to data preparation and seeding for the Community 100 product, working with structured data used within the platform.",
  "",
  "Explored Automation Anywhere and examined repetitive manual processes to identify opportunities for workflow improvement and automation.",
  "",
  "Projects",
  "",
  "Acme Labs — Website",
  "",
  "React | TypeScript | Next.js | MongoDB | Cloudflare",
  "",
  "Built a CMS for the founders that allows them to manage website content, images, reviews, messages and other information without changing the code.",
  "",
  "Added user roles and permissions to control access to different administrative functions and built the media management system.",
  "",
  "Sample Ledger Management System",
  "",
  "React | TypeScript | Node.js | Express | MongoDB",
  "",
  "Developed a full-stack financial ledger system for managing members, loans, installments, revenue and monthly financial records.",
  "",
  "Implemented monthly/yearly record locking, inactive-member workflows, CSV exports and revenue analytics to replace previously manual record management.",
  "",
  "Skills",
  "",
  "Programming: Python, Java, C, JavaScript",
  "",
  "Software Development: React, Node.js, FastAPI, REST APIs",
  "",
  "Databases: MongoDB, SQLite",
  "",
  "AI & Automation: OpenAI APIs, n8n, AI agents, workflow automation, prompt engineering",
  "",
  "Cloud & Infrastructure: Cloudflare Workers, Vercel",
  "",
  "Integration: Webhooks, API integration, Cloudinary",
  "",
  "Achievements",
  "",
  "3rd Place, College-wide Quiz Competition, Example Institute",
  "",
  "Leadership & Activities",
  "",
  "Women in STEM Club, Example Institute",
  "",
  "Languages",
  "",
  "English: Professional proficiency",
  "",
  "Telugu: Native",
].join("\n");

function parse() {
  const text = DOCX_SHAPED_RESUME;
  return parseResumeStructure(
    normalizeText({ text, charCount: text.length, lineCount: text.split(/\r?\n/).length }),
  );
}

describe("parseResumeStructure (DOCX blank-line layout)", () => {
  it("keeps ignored sections out of skills", () => {
    const { profile } = parse();

    expect(profile.skills).toContain("Python");
    expect(profile.skills).toContain("OpenAI APIs");
    expect(profile.skills).toContain("n8n");
    // Content from Achievements / Leadership / Languages must not leak in.
    expect(profile.skills.some((skill) => /quiz|club|languages|native|proficiency/i.test(skill))).toBe(
      false,
    );
  });

  it("parses one combined degree/institution line with dates and grade", () => {
    const { profile } = parse();

    expect(profile.education).toHaveLength(1);
    const [education] = profile.education ?? [];
    expect(education?.degree).toBe("Bachelor's Degree in Computer Science and Engineering");
    expect(education?.school).toBe("Example Institute of Technology and Science, Sampletown");
    expect(education?.fieldOfStudy).toBe("Computer Science and Engineering");
    expect(education?.startYear).toBe(2024);
    expect(education?.endYear).toBe(2028);
    expect(education?.grade).toBe("9.03/10");
  });

  it("keeps each job as one entry across interior blank lines", () => {
    const { profile } = parse();

    expect(profile.experience).toHaveLength(2);
    const [first, second] = profile.experience ?? [];
    expect(first?.title).toBe("Founding Software Developer - Tech Lead");
    expect(first?.company).toBe("Acme Labs");
    expect(first?.startDate).toBe("June 2026");
    expect(first?.currentlyWorking).toBe(true);
    expect(first?.description).toContain("Built and continue to maintain");

    expect(second?.title).toBe("AI & Automation Intern");
    expect(second?.company).toBe("Widget Works");
    expect(second?.startDate).toBe("June 2026");
    expect(second?.endDate).toBe("September 2026");
  });

  it("keeps projects as separate entries with parsed technologies", () => {
    const { profile } = parse();

    expect(profile.projects).toHaveLength(2);
    const [first, second] = profile.projects ?? [];
    expect(first?.name).toBe("Acme Labs — Website");
    expect(first?.technologies).toEqual(["React", "TypeScript", "Next.js", "MongoDB", "Cloudflare"]);
    expect(first?.description).toContain("Built a CMS");

    expect(second?.name).toBe("Sample Ledger Management System");
    expect(second?.technologies).toEqual(["React", "TypeScript", "Node.js", "Express", "MongoDB"]);
  });
});