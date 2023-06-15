import { spawn } from '../src/index';

describe('Process', () => {
  function* p1() {
    yield {state: 'p1'};
  }

  it('should expose process state returned from generator', () => {
    const proc = spawn(p1, 'p1')(null);
    expect(proc.state).toEqual({'state': 'p1'});
  });
});
