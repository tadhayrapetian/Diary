// The demo mailbox builds its sample attachments with Buffer.from(string).
export const Buffer = { from: (text) => new TextEncoder().encode(String(text)) };
