import type { ResearchPage } from '@/lib/types/research'

/** Gateway contract maximum used by exhaustive scope-backed collections. */
export const RESEARCH_PAGE_LIMIT = 100

/**
 * Follow a cursor collection to completion while preserving server order.
 * Repeated cursors are rejected so a malformed response cannot create an
 * unbounded client request loop.
 */
export async function collectResearchPages<T>(
  fetchPage: (cursor?: string) => Promise<ResearchPage<T>>,
  itemId: (item: T) => string,
): Promise<ResearchPage<T>> {
  const items: T[] = []
  const seenItems = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const page = await fetchPage(cursor)
    for (const item of page.items) {
      const id = itemId(item)
      if (!seenItems.has(id)) {
        seenItems.add(id)
        items.push(item)
      }
    }

    const nextCursor = page.next_cursor ?? undefined
    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new Error('Research pagination returned a repeated cursor')
      }
      seenCursors.add(nextCursor)
    }
    cursor = nextCursor
  } while (cursor !== undefined)

  return { items, next_cursor: null }
}
