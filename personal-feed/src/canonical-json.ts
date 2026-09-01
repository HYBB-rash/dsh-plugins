export function encodeCanonicalJson(value: unknown, ancestors = new Set<object>()): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return encodeJsonNumber(value)
  if (typeof value !== 'object') return undefined
  if (Array.isArray(value)) return encodeCanonicalArray(value, ancestors)
  return encodeCanonicalObject(value, ancestors)
}

function encodeJsonNumber(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

function encodeCanonicalArray(value: unknown[], ancestors: Set<object>): string | undefined {
  if (Object.getPrototypeOf(value) !== Array.prototype || !hasOnlyDenseArrayKeys(value)) return undefined
  if (ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    const encoded: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
      const item = encodeCanonicalJson(descriptor.value, ancestors)
      if (item === undefined) return undefined
      encoded.push(item)
    }
    return `[${encoded.join(',')}]`
  } finally {
    ancestors.delete(value)
  }
}

function hasOnlyDenseArrayKeys(value: unknown[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => {
    if (key === 'length') return true
    if (typeof key !== 'string') return false
    const index = Number(key)
    return Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key
  })
}

function encodeCanonicalObject(value: object, ancestors: Set<object>): string | undefined {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (ancestors.has(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  ancestors.add(value)
  try {
    const encoded: string[] = []
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
      const item = encodeCanonicalJson(descriptor.value, ancestors)
      if (item === undefined) return undefined
      encoded.push(`${JSON.stringify(key)}:${item}`)
    }
    return `{${encoded.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}
