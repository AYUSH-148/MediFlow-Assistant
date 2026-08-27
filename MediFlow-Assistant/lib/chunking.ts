import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

/**
 * Chunking that keeps a chunk's headings with it.
 *
 * `RecursiveCharacterTextSplitter` cuts on blank lines, then newlines, then spaces. It has
 * no idea a clinical report is mostly tables, so a cut lands wherever the character budget
 * runs out - and the rows after that cut are separated from the header row naming their
 * columns. Measured on the large eval fixture, 2 of 12 chunks carried table rows with no
 * header among them.
 *
 * A chunk in that state is worse than useless as evidence: "172 mg/dL   < 100   HIGH"
 * retrieved on its own does not say which analyte it belongs to, or which number is the
 * result and which the reference. The generator is left to infer column meaning from
 * position, and it will - sometimes wrongly, always confidently.
 *
 * The 150-character overlap was the existing mitigation, and it is a probabilistic one: it
 * carries the header across only when the cut happens to fall within 150 characters of it.
 *
 * So each chunk is prefixed with the headings that were in force where it starts - the
 * section it belongs to, and the column header of the table it is inside - unless the chunk
 * already contains them. This is deliberately independent of how the table was drawn:
 * pdf-parse's getTable() detects ruled tables through their border geometry and finds
 * nothing in a whitespace-aligned one, which is how most lab reports are laid out.
 *
 * The prefix is also useful beyond tables. A chunk lifted out of "SECTION 4 - LIVER" now
 * says so, both to the model reading it as evidence and to the embedding that has to match
 * a question about the liver.
 */

// A heading is short, is not prose, and is not a labelled field ("Patient: ..."), because a
// field would prefix chunks with an identifier rather than a topic.
function isSectionHeading(line: string): boolean {
  const text = line.trim();
  if (text.length === 0 || text.length > 80) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false;
  if (/[.!?]$/.test(text)) return false;
  if (/^[A-Za-z][A-Za-z ]{0,24}:\s*\S/.test(text)) return false;
  // A heading is one phrase across the page; wide internal gaps mean columns, and an
  // all-caps data row ("ALT (SGPT)    58 U/L    7 - 56    HIGH") is otherwise
  // indistinguishable from an all-caps heading.
  if (/\S {2,}\S/.test(text)) return false;
  return (
    /^(SECTION|PART|APPENDIX)\b/i.test(text) ||
    /^[A-Z0-9][A-Z0-9 \-–—:().,/&']*$/.test(text) ||
    /:$/.test(text)
  );
}

// A column header sits above the rows and, unlike them, carries no measurements - so the
// absence of digits is what separates "Test  Result  Reference Range  Flag" from
// "LDL Cholesterol  172 mg/dL  < 100  HIGH". Two or more wide gaps establish that the line
// is columnar at all.
function isColumnHeader(line: string): boolean {
  const text = line.trimEnd();
  if (text.trim().length === 0 || text.length > 120) return false;
  if (/\d/.test(text)) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false;
  return (text.match(/\S {2,}(?=\S)/g) ?? []).length >= 2;
}

/**
 * For every character offset, the section heading and column header in force there.
 *
 * Built in one forward pass rather than by scanning backwards per chunk, so cost stays
 * linear in the document rather than quadratic.
 */
function buildHeadingIndex(text: string) {
  const entries: Array<{ offset: number; section: string | null; column: string | null }> = [];
  let section: string | null = null;
  let column: string | null = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    if (isSectionHeading(line)) {
      section = line.trim();
      // A new section starts a new table; carrying the previous one's header forward would
      // caption these rows with the wrong columns, which is worse than no caption at all.
      column = null;
    } else if (isColumnHeader(line)) {
      column = line.trimEnd();
    }
    entries.push({ offset, section, column });
    offset += line.length + 1;
  }
  return entries;
}

function headingsAt(
  entries: ReturnType<typeof buildHeadingIndex>,
  offset: number
): { section: string | null; column: string | null } {
  let found = { section: null as string | null, column: null as string | null };
  for (const entry of entries) {
    if (entry.offset > offset) break;
    found = { section: entry.section, column: entry.column };
  }
  return found;
}

export interface ContextualChunk {
  text: string;
  /** True when a heading was prefixed, so the effect is measurable rather than assumed. */
  contextAdded: boolean;
}

export async function chunkWithContext(
  text: string,
  { chunkSize, chunkOverlap }: { chunkSize: number; chunkOverlap: number }
): Promise<ContextualChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const split = await splitter.splitText(text);
  const entries = buildHeadingIndex(text);

  // Chunks appear in document order, so the search resumes from the previous match rather
  // than restarting - a repeated line elsewhere in the report cannot pull the offset
  // backwards and caption a chunk with a heading from the wrong part of the document.
  let cursor = 0;

  return split.map((chunk) => {
    const probe = chunk.slice(0, 60);
    const at = text.indexOf(probe, cursor);
    // The splitter trims, so a probe can fail to match. Returning the chunk untouched is
    // the honest fallback: no context is strictly better than context from the wrong place.
    if (at === -1) return { text: chunk, contextAdded: false };
    cursor = at + 1;

    const { section, column } = headingsAt(entries, at);
    const prefix: string[] = [];
    if (section && !chunk.includes(section)) prefix.push(section);
    if (column && !chunk.includes(column.trim())) prefix.push(column);
    if (prefix.length === 0) return { text: chunk, contextAdded: false };

    return { text: `${prefix.join("\n")}\n${chunk}`, contextAdded: true };
  });
}
