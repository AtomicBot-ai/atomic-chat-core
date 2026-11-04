/**
 * A system or developer message in the middle of a conversation, as the shims and the server pass
 * it to a llama.cpp chat template: user text wrapped the way Claude Code writes its own reminders.
 * Strict templates (Qwen3.5) refuse a system message after the first turn, and moving it to the
 * start of the prompt would make llama.cpp process the whole conversation again.
 */

/** `text` as a reminder, unless the client already wrapped it as one. */
export function asSystemReminder(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')) return trimmed
  return `<system-reminder>\n${trimmed}\n</system-reminder>`
}
