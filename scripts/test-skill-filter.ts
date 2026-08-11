/**
 * Exercises the "/" picker's ranking. Run: node scripts/test-skill-filter.ts
 *
 * The case that matters most is the last one: `/design-diagram` must surface
 * `diagram-design`, because getting that wrong is what cost a real Turn.
 */
import { filterSkills, type SkillManifest } from "../ui/src/skill-filter.ts";

const SKILLS: SkillManifest[] = [
  { name: "bro", description: "A casual conversational helper." },
  { name: "code-search", description: "Find where something lives in an unfamiliar Workspace." },
  { name: "diagram-design", description: "Create architecture and flow diagrams as HTML." },
  { name: "doc-writer", description: "Write or revise README files and API documentation." },
  { name: "json-wrangling", description: "Inspect, query and reshape JSON with jq." },
  { name: "refactor", description: "Make the same change across many files safely." },
  { name: "skill-author", description: "Write a new Skill for this harness." },
];

const cases: [query: string, expectFirst: string | null, note: string][] = [
  ["", "bro", "empty query lists everything, alphabetical by score tie-break"],
  ["diagram", "diagram-design", "prefix match"],
  ["diag", "diagram-design", "partial prefix"],
  ["design", "diagram-design", "substring inside the name"],
  ["design-diagram", "diagram-design", "REVERSED WORD ORDER — the bug that cost a Turn"],
  ["design_diagram", "diagram-design", "underscore separator, reversed"],
  ["doc", "doc-writer", "prefix"],
  ["writer", "doc-writer", "substring"],
  ["json", "json-wrangling", "prefix"],
  ["jq", "json-wrangling", "description-only match"],
  ["refac", "refactor", "partial prefix"],
  ["author", "skill-author", "substring"],
  ["skill", "skill-author", "prefix"],
  ["b", "bro", "single character"],
  ["zzzznope", null, "no match at all"],
];

let failures = 0;
for (const [query, expectFirst, note] of cases) {
  const got = filterSkills(SKILLS, query);
  const first = got[0]?.name ?? null;
  const ok = first === expectFirst;
  if (!ok) failures++;
  console.log(
    `  ${(ok ? "PASS" : "FAIL").padEnd(4)}  /${(query || "(empty)").padEnd(15)} -> ${String(first).padEnd(16)} ${ok ? "" : `expected ${expectFirst}  `}${note}`,
  );
}

// A query must never return a skill it has nothing to do with.
const noise = filterSkills(SKILLS, "refactor").map((s) => s.name);
const noiseOk = noise[0] === "refactor";
console.log(`  ${(noiseOk ? "PASS" : "FAIL").padEnd(4)}  precise query ranks its own skill first (${noise.join(", ")})`);
if (!noiseOk) failures++;

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} FAILING`}`);
process.exit(failures === 0 ? 0 : 1);
