import { cleanError } from './domain.ts'

export type AssistantTextDeliveryResult =
  | { readonly state: 'delivered'; readonly deliveredAt: string }
  | { readonly state: 'failed'; readonly error: string }
  | { readonly state: 'uncertain'; readonly error: string }

export interface AssistantTextDeliveryInput {
  readonly text: string
  readonly signal: AbortSignal
}

export interface AssistantTextDeliveryPort {
  deliver(input: AssistantTextDeliveryInput): Promise<AssistantTextDeliveryResult>
}

type DeliveryProviderV1 = {
  readonly protocolVersion: 1
  deliver(input: AssistantTextDeliveryInput): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProvider(value: unknown): value is DeliveryProviderV1 {
  return isRecord(value) && value.protocolVersion === 1 && typeof value.deliver === 'function'
}

function decodeResult(value: unknown): AssistantTextDeliveryResult | undefined {
  if (!isRecord(value)) return undefined
  if (value.state === 'delivered' && typeof value.deliveredAt === 'string' && value.deliveredAt !== '') {
    return { state: 'delivered', deliveredAt: value.deliveredAt }
  }
  if ((value.state === 'failed' || value.state === 'uncertain')
    && typeof value.error === 'string' && value.error !== '') {
    return { state: value.state, error: cleanError(value.error) }
  }
  return undefined
}

/** Resolve the host service at call time so provider lifecycle changes are visible immediately. */
export function createAssistantTextDeliveryPort(resolveProvider: () => unknown): AssistantTextDeliveryPort {
  return {
    async deliver(input) {
      const provider = resolveProvider()
      if (!isProvider(provider)) {
        return { state: 'failed', error: 'text delivery provider is unavailable or incompatible' }
      }
      try {
        const result = decodeResult(await provider.deliver(input))
        return result ?? { state: 'uncertain', error: 'text delivery provider returned an invalid result' }
      } catch (error: unknown) {
        return { state: 'uncertain', error: cleanError(error) }
      }
    },
  }
}
