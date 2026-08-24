import { isValidPreparedDeliveryObject, type PreparedDeliveryObject } from './types.ts'
import type { CronRunDeliveryMeaningRunPort } from './run-environment.ts'

type PreparedDeliveryBindingInspector = (preparedDelivery: PreparedDeliveryObject) => boolean
const preparedDeliveryBindingInspectors = new WeakMap<object, PreparedDeliveryBindingInspector>()
type DurableBusinessFinalizationInspector = () => boolean
const durableBusinessFinalizationInspectors = new WeakMap<object, DurableBusinessFinalizationInspector>()

export function registerPreparedDeliveryBindingInspector(
  port: CronRunDeliveryMeaningRunPort,
  inspector: PreparedDeliveryBindingInspector,
): () => void {
  preparedDeliveryBindingInspectors.set(port, inspector)
  return () => preparedDeliveryBindingInspectors.delete(port)
}

export function inspectPreparedDeliveryBinding(
  port: CronRunDeliveryMeaningRunPort,
  preparedDelivery: PreparedDeliveryObject,
): boolean {
  if (!isValidPreparedDeliveryObject(preparedDelivery)) return false
  const inspector = preparedDeliveryBindingInspectors.get(port)
  if (inspector === undefined) return false
  try {
    return inspector(preparedDelivery)
  } catch {
    return false
  }
}

export function registerDurableBusinessFinalizationInspector(
  port: CronRunDeliveryMeaningRunPort,
  inspector: DurableBusinessFinalizationInspector,
): () => void {
  durableBusinessFinalizationInspectors.set(port, inspector)
  return () => durableBusinessFinalizationInspectors.delete(port)
}

export function inspectDurableBusinessFinalization(port: CronRunDeliveryMeaningRunPort): boolean {
  const inspector = durableBusinessFinalizationInspectors.get(port)
  if (inspector === undefined) return false
  try {
    return inspector()
  } catch {
    return false
  }
}
