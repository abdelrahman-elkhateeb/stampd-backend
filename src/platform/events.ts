/**
 * In-process domain events (Trello BE-09 → BE-15 notifications). A module
 * publishes after its change has committed; subscribers (e.g. the
 * notification service) react without the publisher knowing them. A failing
 * subscriber is logged and never affects the change or other subscribers.
 */
export type DomainEvent = {
  name: string
  companyId: string
  at: Date
  payload: Record<string, unknown>
}

type Handler = (event: DomainEvent) => Promise<void> | void

const handlers = new Map<string, Set<Handler>>()

/** Subscribe to one event name, or "*" for every event. Returns an unsubscribe. */
export function subscribe(name: string, handler: Handler): () => void {
  const set = handlers.get(name) ?? new Set()
  set.add(handler)
  handlers.set(name, set)
  return () => set.delete(handler)
}

export async function publish(
  event: DomainEvent,
  onError: (error: unknown, event: DomainEvent) => void = () => {}
): Promise<void> {
  const targets = [
    ...(handlers.get(event.name) ?? []),
    ...(handlers.get("*") ?? []),
  ]
  await Promise.all(
    targets.map(async (handler) => {
      try {
        await handler(event)
      } catch (error) {
        onError(error, event)
      }
    })
  )
}
