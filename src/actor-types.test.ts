import { describe, it, expect } from "vitest";
import { defineActor } from "../src/index.js";

// Guards the inferred methods surface: every assertion here fails when it falls back
// to `MethodOptions`.

type IsAny<T> = 0 extends 1 & T ? true : false;

describe("methods inference", () => {
  it("holds in an actor whose hook above `methods` mentions `this`", async () => {
    const Actor = defineActor({
      handlers: {},
      afterStart() {
        void this.name; // the hook that took the surface with it
      },
      methods: {
        one(): number {
          return 1;
        },
        two() {
          return this.one(); // its return type is inferred through `this`
        },
        probe(): void {
          const two = this.two;
          type Two = ReturnType<typeof two>;
          // `two` returns a number, and not `any`: under the constraint it is
          // `any`, this line compiles, and the guard is gone.
          const notAny: IsAny<Two> = false;
          // @ts-expect-error — no such method: only a typed surface errs here
          void this.noSuchMethod();
          // @ts-expect-error — `two()` returns a number, so this cannot compile
          const wrong: string = this.two();
          void notAny;
          void two;
          void wrong;
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    await proc.stop();
  });
});
