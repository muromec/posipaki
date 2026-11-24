
// ── the external term format ────────────────────────────────────────────────
//
// Erlang terms on the wire: a version byte, then a tag and its payload. This is the few tags a distribution
// client has to understand — integers, atoms, binaries, tuples, lists, maps, pids and references — written by
// hand here and read back by `TermReader`.
//
// A tag this file does not know is refused where it is read: an unused byte is a fault in this file or a peer
// speaking something else, and both are worth a sentence that names the byte.

export type Term =
  | { kind: "atom"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "binary"; bytes: Buffer }
  | { kind: "string"; value: string }
  | { kind: "tuple"; items: Term[] }
  | { kind: "list"; items: Term[] }
  | { kind: "map"; pairs: Array<[Term, Term]> }
  | { kind: "pid"; node: string; id: number; serial: number; creation: number }
  | { kind: "ref"; node: string };

export function atom(name: string): Buffer {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length < 256) return Buffer.concat([Buffer.from([119, bytes.length]), bytes]);
  const head = Buffer.alloc(3);
  head[0] = 118; // ATOM_UTF8_EXT
  head.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

export function integer(value: number): Buffer {
  if (value >= 0 && value < 256) return Buffer.from([97, value]);
  const out = Buffer.alloc(5);
  out[0] = 98; // INTEGER_EXT
  out.writeInt32BE(value, 1);
  return out;
}

/** A process id on `node`, whose creation value is the one that node announced. */
export function pid(node: string, id: number, serial: number, creation: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(id, 0);
  body.writeUInt32BE(serial, 4);
  body.writeUInt32BE(creation, 8);
  return Buffer.concat([Buffer.from([88]), atom(node), body]); // NEW_PID_EXT: node first
}

export function binary(data: Uint8Array): Buffer {
  // BINARY_EXT carries a 32-bit length whatever the size: there is no small form.
  const head = Buffer.alloc(5);
  head[0] = 109;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

export function tuple(items: Buffer[]): Buffer {
  if (items.length > 255) throw new Error(`a tuple of ${items.length} items has no small-tuple tag`);
  return Buffer.concat([Buffer.from([104, items.length]), ...items]);
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
        const node = this.atomName();
        this.u32();
        this.u32();
        return { kind: "ref", node };
      }
      case 114:
      case 101: {
        const ids = this.u16();
        const node = this.atomName();
        this.u32();
        for (let left = ids; left > 0; left -= 1) this.u32();
        return { kind: "ref", node };
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
    const atom = this.term();
    if (atom.kind !== "atom") throw new Error(`a node name was a ${atom.kind}, not an atom`);
    return atom.name;
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
 * The octets of a term that was built as a value.
 *
 * The writers above are for the terms this script composes; this is for a term that came from elsewhere — read
 * from a node, or written by a test — and has to go back on the wire. A reference is read but never written
 * here: nothing this script says is identified by one, and an id it cannot mint would be a lie about its node.
 */
export function write(term: Term): Buffer {
  switch (term.kind) {
    case "atom":
      return atom(term.name);
    case "int":
      return integer(term.value);
    case "float": {
      const out = Buffer.alloc(9);
      out[0] = 70; // NEW_FLOAT_EXT
      out.writeDoubleBE(term.value, 1);
      return out;
    }
    case "binary":
      return binary(term.bytes);
    case "string": {
      const bytes = Buffer.from(term.value, "latin1");
      if (bytes.length > 0xffff) return write({ kind: "list", items: [...bytes].map((code) => ({ kind: "int", value: code })) });
      const head = Buffer.alloc(3);
      head[0] = 107; // STRING_EXT
      head.writeUInt16BE(bytes.length, 1);
      return Buffer.concat([head, bytes]);
    }
    case "tuple": {
      const items = term.items.map(write);
      if (items.length <= 255) return tuple(items);
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
      return pid(term.node, term.id, term.serial, term.creation);
    case "ref":
      throw new Error("a reference is read from a node, never written by this script");
  }
}

/**
 * Why a term cannot go on this wire, or null when it can.
 *
 * `write` refuses what it cannot compose — a reference, because an id it cannot mint would be a lie about its node —
 * and a caller that has to send a term it did not build wants to ask before anything is written.
 */
export function unwritable(term: Term): string | null {
  try {
    write(term);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
