import type { ReactNode } from "react";

/**
 * A small markdown renderer that returns React nodes.
 *
 * Deliberately not `marked` + `dangerouslySetInnerHTML`: this renders text
 * produced by a language model, and sometimes text a model read out of a file
 * or fetched from the web. Building elements directly means untrusted content
 * can never become markup, so there is no injection surface to sanitise.
 *
 * Covers what models actually emit: headings, fenced and inline code, bold,
 * italic, strikethrough, links, ordered and unordered lists, blockquotes,
 * tables and rules. Anything else degrades to plain text rather than breaking.
 */

export default function Markdown({ text }: { text: string }) {
  // Parsing happens during render, so a bug here would blank the entire app
  // rather than one message. Model output is unbounded and occasionally
  // malformed; degrading to plain text is always better than a white screen.
  try {
    return <div className="md">{renderBlocks(text)}</div>;
  } catch {
    return <div className="md"><p className="md-p">{text}</p></div>;
  }
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. Everything inside is literal, including markdown.
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(
        <pre key={key++} className="md-pre">
          {lang && <span className="md-lang">{lang}</span>}
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 6)}` as "h2";
      out.push(
        <Tag key={key++} className={`md-h md-h${level}`}>
          {inline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    // Table: a header row followed by a |---|---| separator.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (r: string) =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{head.map((h, n) => <th key={n}>{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      const items: ReactNode[] = [];
      const match = (l: string) => (ordered ? /^(\s*)\d+[.)]\s+(.*)$/.exec(l) : /^(\s*)[-*+]\s+(.*)$/.exec(l));
      while (i < lines.length) {
        const m = match(lines[i]);
        if (!m) {
          // A blank line inside a list is allowed; two ends it.
          if (lines[i].trim() === "" && i + 1 < lines.length && match(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const parts = [m[2]];
        i++;
        // Continuation lines indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !match(lines[i])) parts.push(lines[i++].trim());
        items.push(<li key={items.length}>{inline(parts.join(" "))}</li>);
      }
      out.push(
        ordered ? (
          <ol key={key++} className="md-list md-ol">{items}</ol>
        ) : (
          <ul key={key++} className="md-list md-ul">{items}</ul>
        ),
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) para.push(lines[i++]);
    out.push(
      <p key={key++} className="md-p">
        {inline(para.join(" "))}
      </p>,
    );
  }

  return out;
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line)
  );
}

/** Inline spans. Code is matched first so markup inside backticks stays literal. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g;

  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = pattern.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];

    if (tok.startsWith("`")) {
      nodes.push(<code key={key++} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={key++}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = link[2];
      // Only http(s). A model emitting javascript: must not become a live link.
      const safe = /^https?:\/\//i.test(href);
      nodes.push(
        safe ? (
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="md-a">
            {link[1]}
          </a>
        ) : (
          <span key={key++}>{link[1]}</span>
        ),
      );
    } else {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
