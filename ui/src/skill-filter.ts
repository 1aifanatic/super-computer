export interface SkillManifest {
  name: string;
  description: string;
}

/**
 * Ranks Skills for a partial "/query" typed in the composer.
 *
 * Kept in its own module with no JSX so it can be exercised directly by
 * `scripts/test-skill-filter.ts` -- this is the logic most likely to be subtly
 * wrong, and "it typechecks" is not evidence that ranking is sensible.
 */
export function filterSkills(skills: SkillManifest[], query: string): SkillManifest[] {
  const q = query.toLowerCase().trim();
  if (!q) return skills;

  const tokens = (s: string) => s.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  const qt = tokens(q);

  const score = (s: SkillManifest): number => {
    const name = s.name.toLowerCase();
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    // Word-order-insensitive: "design-diagram" must still find
    // "diagram-design", which is the exact mistake that started all this.
    const nt = tokens(name);
    const shared = qt.filter((t) => nt.some((n) => n.startsWith(t))).length;
    if (shared === qt.length) return 50;
    if (shared > 0) return 30 + shared;
    if (s.description.toLowerCase().includes(q)) return 10;
    return 0;
  };

  return skills
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s);
}
