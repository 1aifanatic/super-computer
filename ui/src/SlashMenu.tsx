import { useEffect, useRef } from "react";
import type { SkillManifest } from "./skill-filter";

export { filterSkills } from "./skill-filter";
export type { SkillManifest } from "./skill-filter";

/**
 * The "/" picker above the composer.
 *
 * Exists because a Turn was lost to `/design-diagram` when the Skill was
 * actually called `diagram-design`. Fuzzy resolution now catches that, but the
 * better fix is not making the Operator remember names at all.
 */
export default function SlashMenu({
  skills,
  query,
  active,
  onHover,
  onPick,
}: {
  skills: SkillManifest[];
  query: string;
  active: number;
  onHover: (i: number) => void;
  onPick: (name: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible when navigating by keyboard.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!skills.length) {
    return (
      <div className="slash-menu">
        <div className="slash-empty">
          No skill matches <code className="mono">/{query}</code>. Press Escape to keep typing normally.
        </div>
      </div>
    );
  }

  return (
    <div className="slash-menu" ref={listRef} role="listbox" aria-label="Skills">
      {skills.map((s, i) => (
        <button
          key={s.name}
          data-i={i}
          role="option"
          aria-selected={i === active}
          className={`slash-item ${i === active ? "is-active" : ""}`}
          onMouseEnter={() => onHover(i)}
          // mousedown, not click: the textarea would blur first and the menu
          // would close before the click ever landed.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s.name);
          }}
        >
          <span className="slash-name mono">/{s.name}</span>
          <span className="slash-desc">{s.description}</span>
        </button>
      ))}
      <div className="slash-hint">
        <kbd>↑</kbd><kbd>↓</kbd> to choose · <kbd>Tab</kbd> or <kbd>Enter</kbd> to insert · <kbd>Esc</kbd> to dismiss
      </div>
    </div>
  );
}

