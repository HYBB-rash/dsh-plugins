import { encodeCanonicalJson } from './canonical-json.ts'
import type { SourceCandidateReference } from './types.ts'

/** Internal collision-free key for a candidate's complete identity tuple. */
export function canonicalCandidateTupleKey(candidate: SourceCandidateReference): string {
  const encoded = encodeCanonicalJson({
    candidate: candidate.candidate,
    source: candidate.source,
    stableReference: candidate.stableReference,
  })
  if (encoded === undefined) throw new Error('personal Feed candidate reference is not canonical JSON')
  return encoded
}
