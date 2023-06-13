declare module 'pspki';

type NotifyFn = () => void;
type UnsubscibeFn = () => void;
type Process<State> = {
  send: (msg: Message) => void;
  wait: () => Promise<void>;
  subscribe: (fn: NotifyFn) => UnsubscibeFn;
  state: State;
};


type Message = {
  type: string;
};

type ProcessGeneratorOut<ProcessState> =  {
  done: boolean,
  value: ProcessState | undefined;
};
type ProcessGenerator<ProcessState> = {
  send: (Message) => ProcessGeneratorOut<ProcessState>;
};

type ProcessFn<Args> = (ctx: ProcessCtx, args: Args) => ProcessGenerator;
type ProcessMessageCb = (msg: Message) => void;

type ProcessStart<Args, State> = (args: Args) => Process<State>;

declare function spawn<Args, State>(args: ProcessFn<Args>, pname: string, toParent: ProcessMessageCb | undefined) => ProcessStart<Args, State>;
