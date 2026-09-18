# BUG-006: A hook's `this:` annotation erases the methods surface

**Found:** 2026-09-19, from email-agent — `this.slot.poolSize` shipped in a method body:
`slot` was a method, so the call returned `any` and the property was never checked. Eight
of that repo's ten actors were in the same state.

**Symptom:** a `this:` parameter on a hook is part of that function's signature, so
checking a config literal instantiates `ActorContext` while `Methods` is still being
inferred. That instantiation is built from the constraint (`{ [key: string]: Function }`)
and reused afterwards, so every `this.<method>()` in the config returns `any` and the
methods' own `ThisType` sees the same thing — with no diagnostic. It is the *position*
that decides: a hook written above `methods` which mentions `this` is enough, and no
method body has to mention `this` at all.

Measured across email-agent's ten `defineActor` sites: eight poisoned (the main actor,
connector, reflector, repl, matrix, schedule, tool-task, actor-server); the two clean
ones (chat, task-server) only because their `setup` never mentions `this`. Adding
`afterStart() { void this.name; }` above chat's `methods` poisons it; the same hook below
them does not.

**Root cause:** the config's contextual type mentions the type parameters being inferred
from it. A `ThisType` marker is applied after inference and is safe; a per-hook
annotation is part of the signature and is not.

**Fix:** `ActorConfig` carries one `ThisType`; the hooks carry no annotation except
`beforeStart` and `setup`, which keep one with `MethodOptions` in place of the inferred
methods — both need `never` for the state, and a `setup` that mentioned `InternalState`
would make the state inference depend on itself. A plugin's overlay is a `Partial<>`,
which does not carry the marker, so `mergeConfigs` restores it through
`ActorContextOf<C>`.

**Tests:** `src/actor-types.test.ts` — two `@ts-expect-error` rows that only exist on a
typed surface, plus an assertion that a method's return type is not `any`.
