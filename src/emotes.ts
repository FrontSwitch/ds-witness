export interface Emote {
  mask: number
  emoji: string
  label: string
}

export const EMOTES: Emote[] = [
  { mask: 1,  emoji: '❓', label: 'uncertain' },
  { mask: 2,  emoji: '❌', label: "doesn't apply" },
  { mask: 4,  emoji: '🔥', label: 'significant' },
  { mask: 8,  emoji: '💜', label: 'like' },
  { mask: 16, emoji: '🌱', label: 'improving' },
  { mask: 32, emoji: '🔍', label: 'curious' },
]

export function emoteIcons(mask: number): string {
  return EMOTES.filter(e => (mask & e.mask) !== 0).map(e => e.emoji).join('')
}
