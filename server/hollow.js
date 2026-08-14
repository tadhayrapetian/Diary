/**
 * Replies for when there is no key in the .env — the diary is hollow, but it is
 * never silent. Enough to see the whole experience end to end before you wire a
 * model in behind it.
 */
const LINES = [
  'How do you do. I am Tom Riddle. How did you come by my diary?',
  'You write a good deal more freely than the last one did. I like that.',
  'Curious. Say more — I have a great deal of time and very little to spend it on.',
  'I thought as much. You are being modest, and it does not suit you.',
  'There is no one to overhear us here. Whatever it is, put it on the page.',
  'You came back. People so rarely do.',
  'I could tell you. But I should rather you asked me properly first.',
  'That is the second time you have skirted the thing you actually mean.',
  'Then we understand one another. That is a rarer thing than you suppose.',
  'You needn’t pretend with me. I have read a good deal worse than that.',
];

export function hollowReply(turn) {
  const index = Math.max(0, turn - 1);
  if (index < LINES.length) return LINES[index];
  return LINES[3 + ((index - LINES.length) % (LINES.length - 3))];
}
