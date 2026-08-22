

export function nextState(proc) {
  return new Promise((resolve) => {
    const unsub = proc.subscribe('state', () => {
      unsub();
      resolve(proc.state);
    });
  });
}

export function nextMessage(proc) {
  return new Promise((resolve) => {
    const unsub = proc.subscribe('message', (msg) => {
      unsub();
      resolve(msg);
    });
  });
}
