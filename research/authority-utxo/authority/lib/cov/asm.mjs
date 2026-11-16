// 名前付きスタック追跡つきの極小アセンブラ。pick/roll の深さを手計算しないための道具。
// 出力は @bsv/sdk の Script.fromASM に渡せる ASM 文字列。

/** Script 数値（LE 符号付き最小表現）の hex。 */
export function numHex(value) {
  let v = BigInt(value);
  if (v === 0n) return '';
  const neg = v < 0n;
  if (neg) v = -v;
  const bytes = [];
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  return Buffer.from(bytes).toString('hex');
}

/** 数値を push するトークン。 */
export function numTok(value) {
  const v = Number(value);
  if (v === 0) return 'OP_0';
  if (v === -1) return 'OP_1NEGATE';
  if (v >= 1 && v <= 16) return `OP_${v}`;
  return numHex(value);
}

export class Asm {
  constructor(initialNames = []) {
    this.tokens = [];
    this.st = [...initialNames];
    this.labels = []; // [chunk 位置, 名前]。失敗位置を規則名に引き戻すための注釈
  }

  /** 以降の検査に名前を付ける（エラー位置 → どの規則で落ちたかの対応表用）。 */
  mark(name) {
    const at = this.tokens.length ? this.tokens.join(' ').split(' ').length : 0;
    this.labels.push([at, name]);
    return this;
  }

  /** 低レベル: トークンを出し、pops 個を捨てて pushes を積む。 */
  raw(tokens, pops, pushes = []) {
    if (this.st.length < pops) throw new Error(`stack underflow before ${tokens}`);
    for (let i = 0; i < pops; i++) this.st.pop();
    this.st.push(...pushes);
    this.tokens.push(...[].concat(tokens));
    return this;
  }

  depth(name) {
    const i = this.st.lastIndexOf(name);
    if (i < 0) throw new Error(`unknown stack name: ${name}`);
    return this.st.length - 1 - i;
  }

  pick(name, as = name) {
    const d = this.depth(name);
    if (d === 0) this.raw('OP_DUP', 0, [as]);
    else if (d === 1) this.raw('OP_OVER', 0, [as]);
    else this.raw([numTok(d), 'OP_PICK'], 0, [as]);
    return this;
  }

  roll(name, as = name) {
    const d = this.depth(name);
    const i = this.st.length - 1 - d;
    if (d === 0) {
      this.st[i] = as;
      return this;
    }
    this.st.splice(i, 1);
    if (d === 1) this.tokens.push('OP_SWAP');
    else if (d === 2) this.tokens.push('OP_ROT');
    else this.tokens.push(numTok(d), 'OP_ROLL');
    this.st.push(as);
    return this;
  }

  pushHex(hex, as) {
    return this.raw(hex === '' ? 'OP_0' : hex, 0, [as]);
  }

  pushNum(n, as) {
    return this.raw(numTok(n), 0, [as]);
  }

  /** 先頭の name を捨てる。 */
  drop(name) {
    const d = this.depth(name);
    const i = this.st.length - 1 - d;
    if (d === 0) this.tokens.push('OP_DROP');
    else if (d === 1) this.tokens.push('OP_NIP');
    else this.tokens.push(numTok(d), 'OP_ROLL', 'OP_DROP');
    this.st.splice(i, 1);
    return this;
  }

  /**
   * operands を順に積み（名前はコピー、{h:hex} {n:数} は即値）、tokens を実行する。
   * 結果は result 名で1つ積む（null なら積まない）。
   */
  calc(operands, tokens, result) {
    for (const op of operands) {
      if (typeof op === 'string') this.pick(op, `_t${this.st.length}`);
      else if (op.h !== undefined) this.pushHex(op.h, `_t${this.st.length}`);
      else this.pushNum(op.n, `_t${this.st.length}`);
    }
    this.raw(tokens, operands.length, result ? [result] : []);
    return this;
  }

  /** スタック頂上の1要素に tokens を適用し名前を付ける（1→1）。 */
  top(tokens, result) {
    return this.raw(tokens, 1, [result]);
  }

  /** 頂上の条件で分岐。両枝の最終スタック名が一致しなければ例外。 */
  ifelse(thenFn, elseFn) {
    this.st.pop();
    this.tokens.push('OP_IF');
    const before = [...this.st];
    thenFn(this);
    const afterThen = [...this.st];
    this.st = before;
    this.tokens.push('OP_ELSE');
    elseFn(this);
    if (afterThen.join('|') !== this.st.join('|')) {
      throw new Error(`branch stack mismatch: [${afterThen}] vs [${this.st}]`);
    }
    this.tokens.push('OP_ENDIF');
    return this;
  }

  /** 全部捨てて OP_1 だけ残す（CLEANSTACK 用）。 */
  finish() {
    for (let n = this.st.length; n >= 2; n -= 2) this.tokens.push('OP_2DROP');
    if (this.st.length % 2 === 1) this.tokens.push('OP_DROP');
    this.st = [];
    return this.raw('OP_1', 0, ['ok']);
  }

  toAsm() {
    return this.tokens.join(' ');
  }
}
