(function () {
  type Position = { file: string; lineText: string; line: number; column: number };
  type Message = { message: string; notes: { message: string; position: Position }[] };
  return {
    format(error: Message): string {
      const notes = error.notes.map(note => {
        const pos = note.position, gutter = `${pos.line} | `;
        return `${gutter}${pos.lineText}\n${" ".repeat(gutter.length + Math.max(0, pos.column - 1))}^\nnote: ${note.message}\n   at ${pos.file}:${pos.line}:${pos.column}\n\n`;
      }).join("");
      return `error: ${error.message}\n\n${notes}`;
    },
  };
})
