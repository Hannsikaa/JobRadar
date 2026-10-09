import { describe, expect, it } from "vitest";

import { normalizeText, isSectionHeading } from "@/lib/resume/parser/normalization";
import { parseResumeStructure } from "@/lib/resume/parser/structure";

/**
 * Regression coverage for project extraction.
 *
 * Real resumes contain sections Job Radar does not store (positions of
 * responsibility, achievements, languages) and projects whose description or
 * technology line is missing. The parser must:
 *  - read project names/descriptions/technologies from the project section only,
 *  - never let a non-project section become a project or leak into one,
 *  - never let one project absorb the next project's name or description,
 *  - leave genuinely absent fields empty rather than inventing them.
 *
 * The text mirrors the shape DOCX/PDF extraction produces (a blank line between
 * every paragraph) and is fully anonymized.
 */

function parse(text: string) {
  return parseResumeStructure(
    normalizeText({ text, charCount: text.length, lineCount: text.split(/\r?\n/).length }),
  );
}

const DOCX_SHAPED_RESUME = [
  "Jordan Rivera",
  "",
  "Computer Science Student | Backend Development",
  "",
  "Example City | jordan.rivera@example.com",
  "",
  "Education",
  "",
  "Bachelor of Technology in Computer Science and Engineering, Example Institute of Technology, 2022 - 2026",
  "",
  "CGPA: 8.4/10",
  "",
  "Experience",
  "",
  "Backend Developer Intern - Northwind Systems - June 2025 - August 2025",
  "",
  "Built REST endpoints for the reporting service and wrote integration tests.",
  "",
  "Projects",
  "",
  "Inventory Tracker",
  "",
  "React | TypeScript | PostgreSQL",
  "",
  "Built a stock tracking dashboard with role based access and CSV export.",
  "",
  "Chat Relay",
  "",
  "Node.js | WebSockets | Redis",
  "",
  "Implemented a realtime message relay with horizontal scaling.",
  "",
  "Static Site Generator",
  "",
  "Go | Markdown",
  "",
  "Positions of Responsibility",
  "",
  "Technical Lead, Coding Club",
  "",
  "Organized weekly workshops and mentored juniors in data structures.",
  "",
  "Achievements",
  "",
  "Runner up, National Hackathon",
  "",
  "Languages",
  "",
  "English, Hindi",
].join("\n");

describe("project extraction from a DOCX-shaped resume", () => {
  it("keeps every distinct project with its own name, technologies and description", () => {
    const { profile } = parse(DOCX_SHAPED_RESUME);

    expect(profile.projects).toHaveLength(3);
    const [inventory, chat, staticSite] = profile.projects ?? [];

    expect(inventory?.name).toBe("Inventory Tracker");
    expect(inventory?.technologies).toEqual(["React", "TypeScript", "PostgreSQL"]);
    expect(inventory?.description).toBe(
      "Built a stock tracking dashboard with role based access and CSV export.",
    );

    expect(chat?.name).toBe("Chat Relay");
    expect(chat?.technologies).toEqual(["Node.js", "WebSockets", "Redis"]);
    expect(chat?.description).toBe("Implemented a realtime message relay with horizontal scaling.");

    expect(staticSite?.name).toBe("Static Site Generator");
    expect(staticSite?.technologies).toEqual(["Go", "Markdown"]);
  });

  it("leaves a missing description empty instead of inventing one", () => {
    const { profile } = parse(DOCX_SHAPED_RESUME);
    const staticSite = (profile.projects ?? []).find((p) => p.name === "Static Site Generator");

    expect(staticSite).toBeDefined();
    expect(staticSite?.description).toBeUndefined();
  });

  it("does not leak one project's description into another", () => {
    const { profile } = parse(DOCX_SHAPED_RESUME);
    const [inventory, chat] = profile.projects ?? [];

    expect(inventory?.description).not.toContain("realtime");
    expect(chat?.description).not.toContain("stock tracking");
  });

  it("does not turn a non-project section into a project or leak it into projects", () => {
    const { profile } = parse(DOCX_SHAPED_RESUME);

    const names = (profile.projects ?? []).map((project) => project.name);
    expect(names).not.toContain("Positions of Responsibility");

    const projectText = (profile.projects ?? [])
      .map((project) => `${project.name} ${project.description ?? ""} ${project.technologies.join(" ")}`)
      .join(" ");
    // Text from Positions of Responsibility / Achievements / Languages must not appear.
    expect(projectText).not.toMatch(/workshop|mentor|coding club|hackathon|hindi|english/i);
  });

  it("still parses the education and experience sections correctly", () => {
    const { profile } = parse(DOCX_SHAPED_RESUME);

    expect(profile.education).toHaveLength(1);
    expect(profile.education?.[0]?.school).toContain("Example Institute of Technology");
    expect(profile.experience).toHaveLength(1);
    expect(profile.experience?.[0]?.company).toBe("Northwind Systems");
    expect(profile.experience?.[0]?.title).toBe("Backend Developer Intern");
  });
});

describe("project boundary handling", () => {
  it("starts a new project even when the previous project has no description", () => {
    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Alpha App",
      "",
      "React, Node.js",
      "",
      "Beta Tool",
      "",
      "Python, Flask",
    ].join("\n");

    const projects = parse(text).profile.projects ?? [];
    expect(projects.map((project) => project.name)).toEqual(["Alpha App", "Beta Tool"]);
    expect(projects[0]?.technologies).toEqual(["React", "Node.js"]);
    expect(projects[1]?.technologies).toEqual(["Python", "Flask"]);
    expect(projects[0]?.description).toBeUndefined();
  });

  it("does not attach a later project's description to an earlier project", () => {
    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Alpha App",
      "",
      "React, Node.js",
      "",
      "Beta Tool",
      "",
      "Python, Flask",
      "",
      "Built a scheduling tool for students.",
    ].join("\n");

    const projects = parse(text).profile.projects ?? [];
    expect(projects).toHaveLength(2);
    expect(projects[0]?.name).toBe("Alpha App");
    expect(projects[0]?.description).toBeUndefined();
    expect(projects[1]?.name).toBe("Beta Tool");
    expect(projects[1]?.description).toBe("Built a scheduling tool for students.");
  });

  it("keeps separate descriptions with their own projects", () => {
    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Alpha App",
      "",
      "React",
      "",
      "Built the alpha experience.",
      "",
      "Beta Tool",
      "",
      "Python",
      "",
      "Built the beta experience.",
    ].join("\n");

    const projects = parse(text).profile.projects ?? [];
    expect(projects).toHaveLength(2);
    expect(projects[0]?.description).toBe("Built the alpha experience.");
    expect(projects[1]?.description).toBe("Built the beta experience.");
  });
});

describe("section boundary recognition after projects", () => {
  it("recognizes Positions of Responsibility instead of absorbing it into projects", () => {
    expect(isSectionHeading("Positions of Responsibility")).toEqual({
      section: "ignored",
      heading: "Positions of Responsibility",
    });

    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Alpha App",
      "",
      "React, Node.js",
      "",
      "Built an alpha app.",
      "",
      "Positions of Responsibility",
      "",
      "Technical Lead, Coding Club",
      "",
      "Organized weekly workshops and mentored juniors in data structures.",
    ].join("\n");

    const projects = parse(text).profile.projects ?? [];
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe("Alpha App");
    expect(projects[0]?.description).toBe("Built an alpha app.");
  });

  it("does not turn a trailing education section into a project", () => {
    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Portfolio Site",
      "",
      "HTML | CSS | JavaScript",
      "",
      "Built a responsive portfolio.",
      "",
      "Academic Details",
      "",
      "Bachelor of Science in Information Technology, Example University, 2020 - 2024",
    ].join("\n");

    const { profile } = parse(text);
    expect(profile.projects?.map((project) => project.name)).toEqual(["Portfolio Site"]);
    expect(profile.education).toHaveLength(1);
    expect(profile.education?.[0]?.school).toContain("Example University");
  });

  it("recognizes Employment History as experience, not projects", () => {
    const text = [
      "Sam Lee",
      "",
      "Projects",
      "",
      "Portfolio Site",
      "",
      "HTML, CSS",
      "",
      "Built a responsive portfolio.",
      "",
      "Employment History",
      "",
      "Data Analyst - Contoso - 2024 - Present",
      "",
      "Analyzed sales data and built reporting dashboards.",
    ].join("\n");

    const { profile } = parse(text);
    expect(profile.projects?.map((project) => project.name)).toEqual(["Portfolio Site"]);
    expect(profile.experience).toHaveLength(1);
    expect(profile.experience?.[0]?.company).toBe("Contoso");
    expect(profile.experience?.[0]?.title).toBe("Data Analyst");
  });
});
