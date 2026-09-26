import { canTransition, assertTransition, isTerminal, IllegalTransitionError } from '../src/protocol/stateMachine';

describe('transaction state machine', () => {
  it('allows the full happy-path sequence', () => {
    const path = [
      'CREATED', 'SIGNED', 'OFFERED', 'RECEIVED', 'VALIDATED',
      'ACCEPTED', 'COMMITTED', 'CONFIRMED', 'SETTLED',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('rejects skipping states', () => {
    expect(canTransition('CREATED', 'COMMITTED')).toBe(false);
    expect(() => assertTransition('CREATED', 'COMMITTED')).toThrow(IllegalTransitionError);
  });

  it('rejects moving out of a terminal state (except PENDING_RECONCILIATION handoff)', () => {
    expect(canTransition('SETTLED', 'CREATED')).toBe(false);
    expect(canTransition('REJECTED', 'ACCEPTED')).toBe(false);
  });

  it('allows TIMEOUT and FAILED to escalate to PENDING_RECONCILIATION', () => {
    expect(canTransition('TIMEOUT', 'PENDING_RECONCILIATION')).toBe(true);
    expect(canTransition('FAILED', 'PENDING_RECONCILIATION')).toBe(true);
  });

  it('only backend-driven resolution can leave PENDING_RECONCILIATION', () => {
    expect(canTransition('PENDING_RECONCILIATION', 'SETTLED')).toBe(true);
    expect(canTransition('PENDING_RECONCILIATION', 'REJECTED')).toBe(true);
    expect(canTransition('PENDING_RECONCILIATION', 'COMMITTED')).toBe(false);
  });

  it('identifies terminal states correctly', () => {
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('COMMITTED')).toBe(false);
  });
});
