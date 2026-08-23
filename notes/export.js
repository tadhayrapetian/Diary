/** Turning the notebook into something readable outside this program. */

function stamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/** The whole notebook as one Markdown file, newest first, pins marked. */
export function toMarkdown(notes, now = Date.now()) {
  const lines = ['# Заметки', '', `Выгружено ${stamp(now)} · всего: ${notes.length}`, ''];
  for (const note of notes) {
    lines.push('---', '', `${note.pinned ? '📌 ' : ''}*${stamp(note.updated)}*`, '', note.text, '');
  }
  return lines.join('\n');
}
