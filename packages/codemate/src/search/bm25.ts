/** BM25 scoring parameters */
const K1 = 0.9
const B = 0.4

/** Minimum token length to keep after tokenization */
const MIN_TOKEN_LENGTH = 2

/** A document entry for indexing */
export interface BM25Document {
  id: string
  text: string
}

/** A search result with relevance score */
export interface BM25Result {
  id: string
  score: number
}

/** A BM25 index with a search method */
export interface BM25Index {
  search: (query: string, topK?: number) => BM25Result[]
}

/**
 * Tokenize text into searchable terms.
 *
 * Converts to lowercase, splits on non-alphanumeric characters,
 * and filters out empty strings and tokens shorter than 2 characters.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
}

/**
 * Build a BM25 index over the given documents.
 *
 * Returns an object with a `search` method that scores documents
 * against a query string using the BM25 ranking function.
 */
export function createBM25Index(documents: BM25Document[]): BM25Index {
  // Guard: empty corpus returns no results
  if (documents.length === 0) {
    return { search: () => [] }
  }

  // term -> docID -> term frequency
  const invertedIndex = new Map<string, Map<string, number>>()
  // docID -> document length (token count)
  const docLengths = new Map<string, number>()

  // Build the inverted index
  for (const doc of documents) {
    const tokens = tokenize(doc.text)
    docLengths.set(doc.id, tokens.length)

    const termFrequencies = new Map<string, number>()
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1)
    }

    for (const [term, freq] of termFrequencies) {
      const posting = invertedIndex.get(term) ?? new Map<string, number>()
      posting.set(doc.id, freq)
      invertedIndex.set(term, posting)
    }
  }

  const totalDocs = documents.length
  const totalLength = documents.reduce((sum, doc) => sum + (docLengths.get(doc.id) ?? 0), 0)
  const avgDocLength = totalLength / totalDocs

  return {
    search(query: string, topK?: number): BM25Result[] {
      const queryTokens = tokenize(query)
      if (queryTokens.length === 0) return []

      // Accumulate scores per document
      const scores = new Map<string, number>()

      for (const term of queryTokens) {
        const posting = invertedIndex.get(term)
        if (!posting) continue

        const docsWithTerm = posting.size
        const idf = Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5))

        for (const [docId, tf] of posting) {
          const docLength = docLengths.get(docId) ?? 0
          const numerator = tf * (K1 + 1)
          const denominator = tf + K1 * (1 - B + B * (docLength / avgDocLength))
          const score = idf * (numerator / denominator)

          scores.set(docId, (scores.get(docId) ?? 0) + score)
        }
      }

      // Sort by score descending, then by id for stable ordering
      const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

      const limit = topK ?? sorted.length
      return sorted.slice(0, limit).map(([id, score]) => ({ id, score }))
    },
  }
}

export * as BM25 from "./bm25"
