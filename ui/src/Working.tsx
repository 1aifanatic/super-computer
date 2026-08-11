import { useEffect, useRef, useState } from "react";

/**
 * The companion shown while a Turn runs.
 *
 * A spinner says "something is happening"; this says *what* is happening and
 * for how long. Turns routinely run 10-90 seconds, so the wait is real.
 * Pure SVG and CSS — no library, no image, nothing on the wire.
 */

const VERBS: Record<string, string> = {
  read_file: "reading",
  write_file: "writing",
  edit_file: "editing",
  list_dir: "looking around",
  glob: "hunting for files",
  grep: "searching",
  bash: "running a command",
  web_fetch: "fetching a page",
  load_skill: "learning a skill",
};

/**
 * Shown between tool calls. Grouped by how long the Turn has been going, so
 * the commentary tracks the wait instead of contradicting it — "one moment"
 * after ninety seconds reads as a lie.
 */
const EARLY = [
  "thinking",
  "reading the room",
  "forming a plan",
  "picking an approach",
  "turning it over",
  "weighing it up",
  "getting oriented",
  "sizing this up",
];

const MIDDLE = [
  "still going",
  "working through it",
  "joining the dots",
  "checking the details",
  "making progress",
  "keeping at it",
  "following the thread",
  "nearly somewhere",
];

const LATE = [
  "this one is chunky",
  "still on it, honestly",
  "deep in the weeds",
  "not stuck, just thorough",
  "taking the scenic route",
  "worth the wait, probably",
  "almost there",
];

/** Random, never the same phrase twice in a row. */
function useRotatingPhrase(pool: string[], active: boolean, everyMs: number) {
  const [phrase, setPhrase] = useState(() => pool[Math.floor(Math.random() * pool.length)]);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setPhrase((current) => {
        const options = poolRef.current.filter((p) => p !== current);
        return options[Math.floor(Math.random() * options.length)] ?? current;
      });
    }, everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);

  return phrase;
}

export default function Working({ activity, startedAt }: { activity: string | null; startedAt: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, []);

  const seconds = Math.max(0, (now - startedAt) / 1000);
  const pool = seconds < 12 ? EARLY : seconds < 40 ? MIDDLE : LATE;
  const musing = useRotatingPhrase(pool, !activity, 3400);
  const label = activity ? (VERBS[activity] ?? activity.replace(/_/g, " ")) : musing;

  return (
    <div className="working" aria-live="polite" aria-label={`Working: ${label}`}>
      <Pet excited={!!activity} />
      <div className="working-text">
        <span className="working-label">{label}</span>
        <span className="working-dots"><i /><i /><i /></span>
      </div>
      {/* Only after a few seconds: an instant timer makes short Turns feel slow. */}
      {seconds > 3 && <span className="working-time mono">{seconds.toFixed(0)}s</span>}
    </div>
  );
}

function Pet({ excited }: { excited: boolean }) {
  return (
    <svg
      className={`pet ${excited ? "is-busy" : ""}`}
      viewBox="0 0 48 36"
      width="48"
      height="36"
      role="presentation"
    >
      <ellipse className="pet-shadow" cx="24" cy="32" rx="10" ry="2.4" />
      <g className="pet-hop">
        {/* Antenna: gives the silhouette something to whip around on landing. */}
        <g className="pet-lean">
          <path className="pet-antenna" d="M24 9 C 24 5, 27 4, 28.5 2.5" />
          <circle className="pet-antenna-tip" cx="29" cy="2" r="1.9" />
          <g className="pet-squash">
            <circle className="pet-body" cx="24" cy="19" r="11" />
            <circle className="pet-cheek" cx="16.5" cy="22" r="2.1" />
            <circle className="pet-cheek" cx="31.5" cy="22" r="2.1" />
            <g className="pet-blink">
              <circle className="pet-eye" cx="20" cy="17.5" r="1.75" />
              <circle className="pet-eye" cx="28" cy="17.5" r="1.75" />
            </g>
            <path className="pet-smile" d="M21 22.6 Q24 25.2 27 22.6" />
          </g>
        </g>
      </g>
    </svg>
  );
}
