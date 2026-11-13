// ── posipaki-durable-actor ──────────────────────────────────────────────────
//
// An actor whose state is the fold of a durable record log, and whose only words are whether it took a request.
//
//   const counter = authoritative(counterSpec);     // owns the log, filters and writes
//   const follower = proxy(counterSpec);            // follows it, forwards requests
//
// Both answer the same `RecordHandle`, so a caller cannot tell which it was given.  `conformance` is the suite a
// spec has to pass; `mirrorChannel` is how an authority tells its followers what changed; `logChannel` is a log
// for tests and demos.

export {
  authoritative,
  type AuthoritativeArgs,
  type AuthoritativeProc,
  type FilterResult,
  type RecordHandle,
  type RecordInMessage,
  type RecordOutMessage,
  type RecordPublic,
  type RecordSpec,
  reasonOf,
  written,
} from './record';

export {
  proxy,
  type ProxyArgs,
  type ProxyMode,
  type ProxyOptions,
  type ProxyProc,
} from './proxy';

export { mirrorChannel, type Stateful } from './mirror';

export { logChannel, openLog, type Log } from './log';

export { ChannelClosed } from './closed';

export {
  conformance,
  LAWS,
  runLaw,
  runLaws,
  type LawCase,
  type LawFailure,
  type LawName,
} from './conformance';
