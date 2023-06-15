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

  it('should set process id to unique symbol created from the process name', () => {
    const proc = spawn(p1, 'p1')(null);
    expect(proc.id).not.toBe(Symbol.for('p1'));
    expect(proc.id.toString()).toEqual('Symbol(p1)');
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
    proc._tick();
    expect(proc.state).toEqual({'state': 's2'});
  });

  it('should notify subscriber when the state changes', () => {
    const callback = jest.fn();
    const proc = spawn<Nil, SimpleStore, ChangeM>(p2, 'p2')(null);
    proc.subscribe(callback);
    proc.send({ type: 'CHANGE', data: 's2' });
    proc._tick();
    expect(callback).toBeCalledTimes(1);
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
    proc._tick();
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
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 0 });

    proc.send({ type: 'PING', pseq: 1 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 1 });

    proc.send({ type: 'PING', pseq: 2 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 2 });

    proc.send({ type: 'PING', pseq: 3 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 3 });

    proc.send({ type: 'PING', pseq: 4 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 4 });
    expect(bus).toBeCalledWith({ type: 'EXIT', pid: proc.id });
    expect(bus).toBeCalledTimes(6);
  });

  it('should exit ping-pong when sequence breaks', () => {
    const bus = jest.fn();
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(p4, 'p4', bus)(null);

    proc.send({ type: 'PING', pseq: 0 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'PONG', pseq: 0 });

    proc.send({ type: 'PING', pseq: 2 });
    proc._tick();
    expect(bus).toBeCalledWith({ type: 'EXIT', pid: proc.id });

    expect(bus).toBeCalledTimes(2);
  });

  it('should allow two subscribers', () => {
    const sub1 = jest.fn();
    const sub2 = jest.fn();

    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(p4, 'p4')(null);

    const cb1 = ()=> sub1(proc.state ? proc.state.seq : null);
    const cb2 = ()=> sub2(proc.state ? proc.state.seq : null);

    expect(proc.isListenedTo).toBe(false);;
    const un1 = proc.subscribe(cb1);

    // dispatch
    jest.clearAllMocks();
    proc.send({ type: 'PING', pseq: 0 });
    proc.tick();

    // check callbacks
    expect(sub1).toBeCalledWith(1);
    expect(sub2).not.toBeCalled();
    expect(proc.isListenedTo).toBe(true);

    const un2 = proc.subscribe(cb2);

    // dispatch
    jest.clearAllMocks();
    proc.send({ type: 'PING', pseq: 1 });
    proc.tick();

    // check callbacks
    expect(sub1).toBeCalledWith(2);
    expect(sub2).toBeCalledWith(2);
    expect(proc.isListenedTo).toBe(true);

    un2();

    // dispatch
    jest.clearAllMocks();
    proc.send({ type: 'PING', pseq: 2 });
    proc.tick();

    // check callbacks
    expect(sub1).toBeCalledWith(3);
    expect(sub2).not.toBeCalled();
    expect(proc.isListenedTo).toBe(true);

    un1();

    // dispatch
    jest.clearAllMocks();
    proc.send({ type: 'PING', pseq: 3 });
    proc.tick();

    // check callbacks
    expect(sub1).not.toBeCalled();
    expect(sub2).not.toBeCalled();
    expect(proc.isListenedTo).toBe(false);
  });

  it('should pause the process and keep messages in a buffer until resume', () => {
    const proc = spawn<Nil, CountStore, PingM, ExitMessage | PongM>(p4, 'p4')(null);
    proc.pause();
    proc.send({ type: 'PING', pseq: 0 });
    proc.send({ type: 'PING', pseq: 1 });
    proc.send({ type: 'PING', pseq: 2 });

    expect(proc.state).toEqual({ seq: 0 });
    proc.resume();
    proc.tick();
    expect(proc.state).toEqual({ seq: 3 });
  });

});
