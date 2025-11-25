
export class EventEmitter<EvMap extends Record<string, any>> {
  private listeners = new Map<keyof EvMap, Set<(...payload: EvMap[keyof EvMap]) => void>>();

  on<K extends keyof EvMap>(event: K, handler: (...payload: EvMap[K]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as any); 
  }

  off<K extends keyof EvMap>(event: K, handler: (...payload: EvMap[K]) => void) {
    this.listeners.get(event)?.delete(handler as any);
  }

  once<K extends keyof EvMap>(event: K, handler: (payload: EvMap[K]) => void) {
        const wrapper = (payload: EvMap[K]) => {
        this.off(event, wrapper as any);
        handler(payload);
        };
        this.on(event, wrapper as any);
    }

  emit<K extends keyof EvMap>(event: K, ...payload: EvMap[K]) {
  console.debug(event,payload)

    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        h(...payload);
      } catch (err) {
        console.error(`Error in event handler for ${String(event)}:`, err);
      }
    }
  }

  removeAll() {
    this.listeners.clear();
  }
}