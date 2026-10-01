/**
 * @fileoverview A check on rendered `content[]` markdown: every blockquote of
 * force-written text ends with a blank line (or the end of the text), so no
 * server-written line after it can render inside the quote.
 * @module tests/fixtures/quote-run-ons
 */

/**
 * Each quote line followed directly by a line that is neither blank nor another
 * quote line, as `"quote line\nnext line"`; empty when every quote is closed.
 */
export function quoteRunOns(markdown: string): string[] {
  const lines = markdown.split('\n');
  return lines.flatMap((line, index) => {
    const next = lines[index + 1];
    return line.trimStart().startsWith('>') &&
      next !== undefined &&
      next.trim() !== '' &&
      !next.trimStart().startsWith('>')
      ? [`${line}\n${next}`]
      : [];
  });
}
