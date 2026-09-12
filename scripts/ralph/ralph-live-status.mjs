// Наблюдения текущего процесса. Они не управляют лимитами и не заменяют state.json.
let state = { session: null, network: null, review: null, operation: null, phaseConfig: null, queueProgress: null };
const listeners = new Set();

export function readLiveStatus() {
  return structuredClone(state);
}

export function resetLiveStatus() {
  state = { session: null, network: null, review: null, operation: null, phaseConfig: null, queueProgress: null };
}

export function subscribeLiveStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishLiveStatus(event) {
  const { type, ...values } = event;
  switch (type) {
    case 'phase-config':
      state.phaseConfig = structuredClone(values.phaseConfig);
      state.session = null;
      state.review = null;
      state.operation = null;
      break;
    case 'queue-progress':
      state.queueProgress = structuredClone(values.queueProgress);
      break;
    case 'session-start':
      state.session = { turns: 0, toolResults: 0, lastEventMs: null, ...values, active: true };
      break;
    case 'session-progress':
      if (state.session) state.session = { ...state.session, ...values };
      break;
    case 'session-end':
      if (state.session) state.session = { ...state.session, ...values, active: false };
      break;
    case 'network-attempt':
    case 'review-attempt':
    case 'operation-start':
      state[type.split('-')[0]] = { ...values, active: true };
      break;
    case 'network-end':
    case 'operation-end':
    case 'review-end': {
      const key = type.split('-')[0];
      if (state[key]) state[key] = { ...state[key], ...values, active: false };
      break;
    }
    default:
      throw new Error(`Unknown live status event: ${type}`);
  }
  // Сбой наблюдателя не должен менять исход операции или приводить к её повтору.
  for (const listener of listeners) {
    try { listener(readLiveStatus()); } catch { /* interface observer only */ }
  }
}
