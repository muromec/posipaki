import { inspect } from 'util';
import { spawn, ProcessCtx, Message, ExitMessage } from '../src/index';

describe('Process', () => {
  type SimpleStore = {
    state: string,
  };
  type ChangeM = {
    type: 'CHANGE',
    data: string,
  };
  type Nil = null;

  function* p1() {
    yield {state: 's1'};
  }

  it('should expose process state returned from generator', () => {
    const proc = spawn(p1, 'p1')(null);
    expect(proc.state).toEqual({'state': 's1'});
  });

  function* p2() {
    const state = {state: 'p1'};
    yield state;
    const msg: ChangeM = yield null;
    state.state = msg.data;
  }

  it('should change internal state in response to message', () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, 'p2')(null);
    proc.send({ type: 'CHANGE', data: 's2' });
    proc._tick(null);
    expect(proc.state).toEqual({'state': 's2'});
  });

  it('should notify subscriber when the state changes', () => {
    const callback = jest.fn();
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, 'p2')(null);
    proc.subscribe(callback);
    proc.send({ type: 'CHANGE', data: 's2' });
    proc._tick(null);
    expect(callback).toBeCalledTimes(2); // second time on exit
  });

  it('should resolve proc.wait() when generator runs out', async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p1, 'p2')(null);
    const res = proc.wait();
    expect(await res).toBe(undefined);
  });

  it('should wait for generator to run out', async () => {
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, 'p2')(null);
    const res = proc.wait();
    expect(inspect(res)).toMatch(/pending/);
    
    proc.send({ type: 'CHANGE', data: 's2' });
    proc._tick(null);
    expect(inspect(res)).not.toMatch(/pending/);

    expect(await res).toBe(undefined);
  });

  type PongM = {
    type: 'PONG',
    pseq: number,
  };
  function* p3(ctx: ProcessCtx<Message, ExitMessage | PongM>) {
    yield null;
    ctx.toParent({ type: 'PONG', pseq: 0 });
  }

  it('should emit messages to parent', () => {
    const bus = jest.fn();
    const proc = spawn<Nil, SimpleStore, Message, ExitMessage | PongM>(p3, 'p3', bus)(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 0 });
    expect(bus).toBeCalledWith({ type: 'EXIT', pid: proc.id });
  });

  type PingM = {
    type: 'PING',
    pseq: number,
  };
  type CountStore = {
    seq: number,
  };

  function* p4(ctx: ProcessCtx<PingM, ExitMessage | PongM>) {
    const state = { seq: 0 };
    yield state;

    while(state.seq < 5) {
      const msg : PingM = yield null;
      if (msg.pseq !== state.seq) {
        break;
      }
      ctx.toParent({ type: 'PONG', pseq: state.seq });
      state.seq += 1
    }
  }

  it('should play ping-pong and keep count of messages', () => {
    const bus = jest.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(p4, 'p4', bus)(null);

    proc.send({ type: 'PING', pseq: 0 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 0 });

    proc.send({ type: 'PING', pseq: 1 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 1 });

    proc.send({ type: 'PING', pseq: 2 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 2 });

    proc.send({ type: 'PING', pseq: 3 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 3 });

    proc.send({ type: 'PING', pseq: 4 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 4 });
    expect(bus).toBeCalledWith({ type: 'EXIT', pid: proc.id });
    expect(bus).toBeCalledTimes(6);
  });

  it('should exit ping-pong when sequence breaks', () => {
    const bus = jest.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(p4, 'p4', bus)(null);

    proc.send({ type: 'PING', pseq: 0 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 0 });

    proc.send({ type: 'PING', pseq: 2 });
    proc._tick(null);
    expect(bus).toBeCalledWith({ type: 'EXIT', pid: proc.id });

    expect(bus).toBeCalledTimes(2);
  });

});
