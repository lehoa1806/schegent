/**
 * Where a long word in a host sentence may break.
 *
 * A setting key (`a.b.c`) or a file path, its folders joined by slashes, is one word to the
 * browser, so a line too narrow for it breaks it, if at all, at whatever letter the line ends on.
 * This splits a sentence into runs, each after the first starting at a dot or a slash that joins
 * two parts of a word, so the page can offer a break before it (`BreakAtJoins.svelte` draws a
 * `<wbr>` there). That is where the Chicago Manual of Style breaks a URL carried over to a new
 * line: before a dot or a single slash, so the new line starts with the mark that shows the word
 * goes on.
 */

/**
 * A dot or a slash with a character on each side that is not a space, a dot or a slash, unless it
 * is a decimal point. A dot that ends a sentence or starts a word, the dots of an ellipsis and a
 * number such as `1.5` are left alone.
 */
const JOIN = /(?<=[^\s./])(?=[./][^\s./])(?!(?<=\d)\.\d)/u;

/**
 * Splits `text` before each join, in order. Joined, the runs give `text` back; a text with no
 * join is one run.
 */
export function splitAtJoins(text: string): readonly string[] {
  return text.split(JOIN);
}
