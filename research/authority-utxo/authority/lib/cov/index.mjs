export { COV, DEFAULT_PARAMS, covParams, ROOT_R, STATE_LEN, encodeState, covLockingScript, codeAsmCached, ruleAt } from './script.mjs';
export { deriveR, makeUtxo, spendUse, spendDelegate, spendReclaim, VERIFY_FLAGS } from './spend.mjs';

export { spendAnnounce, spendAnnounceUse, spendAnnounceDelegate, spendConfirmUse, spendConfirmDelegate, intentHash, announceAndConfirm } from './spend.mjs';

// USE_K keeps the existing use path; omitted k remains one.
export { spendUse as spendUseK } from "./spend.mjs";
