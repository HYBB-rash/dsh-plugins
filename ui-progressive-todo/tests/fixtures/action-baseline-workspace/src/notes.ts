export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  updatedAt: string
}

const notes: Note[] = []

export function listNotes(): readonly Note[] {
  return notes
}

export function exportNotes(): never {
  throw new Error('export format not decided')
}
