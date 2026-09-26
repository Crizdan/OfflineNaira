export type TxState =
  | 'CREATED'
  | 'SIGNED'
  | 'OFFERED'
  | 'RECEIVED'
  | 'VALIDATED'
  | 'ACCEPTED'
  | 'COMMITTED'
  | 'CONFIRMED'
  | 'SETTLED'
  | 'FAILED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'PENDING_RECONCILIATION';

export const TERMINAL_STATES: ReadonlySet<TxState> = new Set([
  'SETTLED',
  'REJECTED',
  'TIMEOUT',
  'FAILED',
  'PENDING_RECONCILIATION',
]);

/** Explicit allow-list of transitions. Anything not listed here is illegal. */
const ALLOWED: Record<TxState, TxState[]> = {
  CREATED: ['SIGNED', 'FAILED'],
  SIGNED: ['OFFERED', 'FAILED'],
  OFFERED: ['RECEIVED', 'TIMEOUT', 'FAILED'],
  RECEIVED: ['VALIDATED', 'REJECTED', 'FAILED'],
  VALIDATED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['COMMITTED', 'FAILED'],
  COMMITTED: ['CONFIRMED', 'PENDING_RECONCILIATION'],
  CONFIRMED: ['SETTLED', 'PENDING_RECONCILIATION'],
  SETTLED: [],
  REJECTED: [],
  TIMEOUT: ['PENDING_RECONCILIATION'],
  FAILED: ['PENDING_RECONCILIATION'],
  PENDING_RECONCILIATION: ['SETTLED', 'REJECTED'], // resolved by backend reconciliation only
};

export class IllegalTransitionError extends Error {
  constructor(from: TxState, to: TxState) {
    super(`Illegal transaction state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TxState, to: TxState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Throws on any transition not explicitly allowed. Callers must not bypass this. */
export function assertTransition(from: TxState, to: TxState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function isTerminal(state: TxState): boolean {
  return TERMINAL_STATES.has(state);
}
