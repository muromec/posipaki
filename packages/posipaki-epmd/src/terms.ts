
// ── the external term format ────────────────────────────────────────────────
//
// Erlang terms on the wire: a version byte, then a tag and its payload. This is the few tags a distribution
// client has to understand — integers, atoms, binaries, tuples, lists, maps, pids and references — written by
// hand here and read back by `TermReader`.
//
// A tag this file does not know is refused where it is read: an unused byte is a fault in this file or a peer
// speaking something else, and both are worth a sentence that names the byte.

/**
 * A BEAM term.
 *
 * `Also` is the leaf a layer adds to a term it has not written yet: a process of this side before it crosses, a
 * process of the other node after it has. Everything here is a term whose leaves are only the wire's own.
 */
export type Term<Also = never> =
  | { kind: "atom"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "binary"; bytes: Buffer }
  | { kind: "string"; value: string }
  | { kind: "tuple"; items: Term<Also>[] }
  | { kind: "list"; items: Term<Also>[] }
  | { kind: "map"; pairs: Array<[Term<Also>, Term<Also>]> }
  | { kind: "pid"; node: string; id: number; serial: number; creation: number }
  /**
   * A reference, as the node that minted it wrote it: `bytes` is the whole term, tag and words.
   *
   * A monitor names its watch by a reference the watching node made, and the answer carries that same one back, so
   * the octets are kept rather than decoded: what this side hands back is provably what it was given.
   */
  | { kind: "ref"; node: string; bytes: Buffer }
  | Also;

// ── the terms this side composes ────────────────────────────────────────────
//
// A message is built the same way wherever it is built: `tuple([ourPid, binary(<<"hi">>)])`, and `write` is the only
// thing that turns one into octets. Two ways to build — constructors and writers — was one way too many.

/** An atom. */
export function atom(name: string): Term {
  return { kind: "atom", name };
}

/** An integer, whatever its size. */
export function integer(value: number): Term {
  return { kind: "int", value };
}

/** A binary: the octets, as they are. */
export function binary(bytes: Uint8Array): Term {
  return { kind: "binary", bytes: Buffer.from(bytes) };
}

/** A process id on `node`, minted by the incarnation `creation` names. */
export function pid(node: string, id: number, serial: number, creation: number): Extract<Term, { kind: "pid" }> {
  return { kind: "pid", node, id, serial, creation };
}

/**
 * A reference as a node mints one: `NEWER_REFERENCE_EXT`, with the words left uninterpreted.
 *
 * This side sets no watches of its own, so nothing here mints one in anger; a peer of its tests needs the octets a node
 * would write, and this is those.
 */
export function reference(
  node: string,
  creation: number,
  words: readonly number[] = [0, 0, 0, 0],
): Extract<Term, { kind: "ref" }> {
  const head = Buffer.alloc(3);
  head[0] = 90; // NEWER_REFERENCE_EXT
  head.writeUInt16BE(words.length, 1);
  const body = Buffer.alloc(4 + words.length * 4);
  body.writeUInt32BE(creation, 0);
  words.forEach((word, index) => body.writeUInt32BE(word, 4 + index * 4));
  return { kind: "ref", node, bytes: Buffer.concat([head, atomBytes(node), body]) };
}

/** A tuple, which is what a message with an address in it always is. */
export function tuple<Also = never>(...items: Term<Also>[]): Term<Also> {
  return { kind: "tuple", items };
}

/** A list, in the order it will be read. */
export function list<Also = never>(...items: Term<Also>[]): Term<Also> {
  return { kind: "list", items };
}

/** A map, as its pairs. */
export function map<Also = never>(...pairs: Array<[Term<Also>, Term<Also>]>): Term<Also> {
  return { kind: "map", pairs };
}

/** Reads the terms of a packet, one after another, from the byte after its version magic. */
export class TermReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  peek(): number {
    return this.offset < this.buffer.length ? this.buffer[this.offset] : -1;
  }

  skip(count: number): void {
    this.offset += count;
  }

  done(): boolean {
    return this.offset >= this.buffer.length;
  }

  term(): Term {
    const start = this.offset;
    const tag = this.u8();
    switch (tag) {
      case 97:
        return { kind: "int", value: this.u8() };
      case 98:
        return { kind: "int", value: this.i32() };
      case 70:
        return { kind: "float", value: this.f64() };
      case 100:
        return { kind: "atom", name: this.text(this.u16(), "latin1") };
      case 118:
        return { kind: "atom", name: this.text(this.u16(), "utf8") };
      case 115:
        return { kind: "atom", name: this.text(this.u8(), "utf8") };
      case 119:
        return { kind: "atom", name: this.text(this.u8(), "latin1") };
      case 104:
        return { kind: "tuple", items: this.items(this.u8()) };
      case 105:
        return { kind: "tuple", items: this.items(this.u32()) };
      case 106:
        return { kind: "list", items: [] };
      case 107:
        return { kind: "string", value: this.text(this.u16(), "latin1") };
      case 108: {
        const items = this.items(this.u32());
        const tail = this.term();
        if (tail.kind !== "list" || tail.items.length > 0) {
          throw new Error("this script reads proper lists only, and this one does not end in []");
        }
        return { kind: "list", items };
      }
      case 109:
        return { kind: "binary", bytes: this.take(this.u32()) };
      case 77: {
        const bytes = this.take(this.u32());
        const bits = this.u8();
        if (bits !== 8) {
          throw new Error(`a binary whose last byte holds ${bits} of 8 bits is not read here`);
        }
        return { kind: "binary", bytes };
      }
      case 116: {
        const pairs: Array<[Term, Term]> = [];
        for (let left = this.u32(); left > 0; left -= 1) pairs.push([this.term(), this.term()]);
        return { kind: "map", pairs };
      }
      case 88:
        return {
          kind: "pid",
          node: this.atomName(),
          id: this.u32(),
          serial: this.u32(),
          creation: this.u32(),
        };
      case 90: {
        // NEWER_REFERENCE_EXT is what a node mints now: the count of words comes first, then the node, the creation
        // and the words themselves.
        const words = this.u16();
        const node = this.atomName();
        this.u32();
        for (let left = words; left > 0; left -= 1) this.u32();
        return { kind: "ref", node, bytes: this.buffer.subarray(start, this.offset) };
      }
      case 114:
      case 101: {
        // The two older forms, which a node accepts but no longer writes: 114 carries a count, 101 is one word.
        const words = tag === 114 ? this.u16() : 1;
        const node = this.atomName();
        this.u8();
        for (let left = words; left > 0; left -= 1) this.u32();
        return { kind: "ref", node, bytes: this.buffer.subarray(start, this.offset) };
      }
      default:
        throw new Error(`the term format tag ${tag} at byte ${start} is not read by this script`);
    }
  }

  private items(count: number): Term[] {
    const items: Term[] = [];
    for (let index = 0; index < count; index += 1) items.push(this.term());
    return items;
  }

  private atomName(): string {
    const named = this.term();
    if (named.kind !== "atom") throw new Error(`a node name was a ${named.kind}, not an atom`);
    return named.name;
  }

  private u8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private u16(): number {
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  private u32(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private i32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private f64(): number {
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  private take(count: number): Buffer {
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  private text(count: number, encoding: BufferEncoding): string {
    return this.take(count).toString(encoding);
  }
}

export function render(term: Term): string {
  switch (term.kind) {
    case "atom":
      return term.name;
    case "int":
    case "float":
      return String(term.value);
    case "binary":
      return term.bytes.toString("utf8");
    case "string":
      return term.value;
    case "tuple":
      return `{${term.items.map(render).join(", ")}}`;
    case "list":
      return `[${term.items.map(render).join(", ")}]`;
    case "map":
      return `#{${term.pairs.map(([key, value]) => `${render(key)} => ${render(value)}`).join(", ")}}`;
    case "pid":
      return `#PID<${term.node}.${term.id}.${term.serial}>`;
    case "ref":
      return `#Ref<${term.node}>`;
  }
}

/**
 * The octets of a term.
 *
 * This is the only encoder: a message is built with the constructors above, and written here. A reference goes back as
 * the octets it arrived as: an id this side minted would be a lie about its node, so it only ever echoes one.
 */
export function write(term: Term): Buffer {
  switch (term.kind) {
    case "atom":
      return atomBytes(term.name);
    case "int":
      return integerBytes(term.value);
    case "float": {
      const out = Buffer.alloc(9);
      out[0] = 70; // NEW_FLOAT_EXT
      out.writeDoubleBE(term.value, 1);
      return out;
    }
    case "binary":
      return binaryBytes(term.bytes);
    case "string": {
      const bytes = Buffer.from(term.value, "latin1");
      if (bytes.length > 0xffff) {
        return write({ kind: "list", items: [...bytes].map((code) => ({ kind: "int", value: code })) });
      }
      const head = Buffer.alloc(3);
      head[0] = 107; // STRING_EXT
      head.writeUInt16BE(bytes.length, 1);
      return Buffer.concat([head, bytes]);
    }
    case "tuple": {
      const items = term.items.map(write);
      if (items.length <= 255) return Buffer.concat([Buffer.from([104, items.length]), ...items]);
      const head = Buffer.alloc(5);
      head[0] = 105; // LARGE_TUPLE_EXT
      head.writeUInt32BE(items.length, 1);
      return Buffer.concat([head, ...items]);
    }
    case "list": {
      if (term.items.length === 0) return Buffer.from([106]); // NIL_EXT
      const head = Buffer.alloc(5);
      head[0] = 108; // LIST_EXT
      head.writeUInt32BE(term.items.length, 1);
      return Buffer.concat([head, ...term.items.map(write), Buffer.from([106])]);
    }
    case "map": {
      const head = Buffer.alloc(5);
      head[0] = 116; // MAP_EXT
      head.writeUInt32BE(term.pairs.length, 1);
      return Buffer.concat([head, ...term.pairs.flatMap(([key, value]) => [write(key), write(value)])]);
    }
    case "pid":
      return pidBytes(term.node, term.id, term.serial, term.creation);
    case "ref":
      // Echoed, never minted: the octets it arrived as are what goes back, so the peer reads its own id.
      return term.bytes;
  }
}

/** An atom's octets: the short tag under 256 characters, the wide one past it. */
function atomBytes(name: string): Buffer {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length < 256) return Buffer.concat([Buffer.from([119, bytes.length]), bytes]);
  const head = Buffer.alloc(3);
  head[0] = 118; // ATOM_UTF8_EXT
  head.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

/** An integer's octets: one byte while it fits, four when it does not. */
function integerBytes(value: number): Buffer {
  if (value >= 0 && value < 256) return Buffer.from([97, value]);
  const out = Buffer.alloc(5);
  out[0] = 98; // INTEGER_EXT
  out.writeInt32BE(value, 1);
  return out;
}

/** A pid's octets: the node's atom, then the id, the serial and the creation. */
function pidBytes(node: string, id: number, serial: number, creation: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(id, 0);
  body.writeUInt32BE(serial, 4);
  body.writeUInt32BE(creation, 8);
  return Buffer.concat([Buffer.from([88]), atomBytes(node), body]); // NEW_PID_EXT: the node first
}

/** A binary's octets: a thirty-two bit length whatever the size, because there is no small form. */
function binaryBytes(data: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 109; // BINARY_EXT
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}
