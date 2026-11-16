/** @typedef {{ version: 1, n: number, P: number, T: number, R: string[] }} AuthorityState */

export const STATE_PREFIX = 'AUTH1';

/** @returns {AuthorityState} */
export function createState({ n, P, T, R }) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid n');
  if (!Number.isSafeInteger(P) || P < 0) throw new Error('invalid P');
  if (!Number.isSafeInteger(T) || T < 0) throw new Error('invalid T');
  if (!Array.isArray(R) || R.length === 0 || !R.every((h) => typeof h === 'string' && /^[a-f0-9]{40}$/.test(h))) {
    throw new Error('invalid R');
  }
  return { version: 1, n, P, T, R: [...R] };
}

/** @param {AuthorityState} s */
export function canonicalStateBytes(s) {
  return Buffer.from(
    JSON.stringify({
      v: s.version,
      n: s.n,
      P: s.P,
      T: s.T,
      R: s.R,
    }),
    'utf8'
  );
}

/** @param {AuthorityState} a @param {AuthorityState} b */
export function statesEqual(a, b) {
  return (
    a.version === b.version &&
    a.n === b.n &&
    a.P === b.P &&
    a.T === b.T &&
    a.R.length === b.R.length &&
    a.R.every((h, i) => h === b.R[i])
  );
}

/** @param {AuthorityState} s */
export function holderHash(s) {
  return s.R[s.R.length - 1];
}

/** @param {AuthorityState} child @param {AuthorityState} parent */
export function isShrinkOf(child, parent) {
  return (child.P & parent.P) === child.P && child.T <= parent.T;
}

/** @param {string} ancestorHash @param {AuthorityState} target */
export function ancestorIndex(ancestorHash, target) {
  return target.R.indexOf(ancestorHash);
}

/** @param {string} ancestorHash @param {AuthorityState} target */
export function hasAncestor(ancestorHash, target) {
  return ancestorIndex(ancestorHash, target) >= 0;
}