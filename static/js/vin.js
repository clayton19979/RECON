/* ==================================================================
   VIN FIELDS

   Every 17-character VIN carries its own arithmetic proof (the ISO 3779
   check digit, position 9) -- the same math app/db.py::vin_check_digit_ok
   runs before a decode or an agent intake is accepted. The server's check
   is the backstop; this is the front door: the person typing a VIN off a
   dash plate at the counter should hear "one character is off" while their
   eyes are still on the car, not from a refusal after the form is filled.

   One wiring helper for every box a VIN is typed into (recon intake, we-owe
   intake, add-a-vehicle), so all of them mask, count and verify the same
   way and none of them can drift.
   ================================================================== */

/* Mirror of app/db.py::_VIN_TRANSLITERATION. I, O and Q are absent on
   purpose: the standard excludes them because they read as 1 and 0. */
const VIN_TRANSLITERATION = {
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
// Position 9 is the check digit itself, so it contributes nothing to its own sum.
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/* True only for a well-formed 17-character VIN whose check digit works out.
   A shorter VIN isn't wrong, it just can't be verified -- callers decide
   what to do with partial input; this function only answers for full ones. */
function vinCheckDigitOk(vin) {
  const cleaned = String(vin || "").toUpperCase();
  if (cleaned.length !== 17) return false;
  let total = 0;
  for (let position = 0; position < 17; position++) {
    const value = VIN_TRANSLITERATION[cleaned[position]];
    if (value === undefined) return false;
    total += value * VIN_WEIGHTS[position];
  }
  const remainder = total % 11;
  return cleaned[8] === (remainder === 10 ? "X" : String(remainder));
}

/* Why a full VIN failed, in words that send the reader back to the right
   character. I/O/Q are the usual suspects -- they are never in a VIN, and
   each one looks like the digit that actually is. */
function vinProblemText(vin) {
  const impostor = { I: "a 1", O: "a 0", Q: "a 0" };
  const found = ["I", "O", "Q"].filter((ch) => vin.includes(ch));
  if (found.length === 1) {
    return `The letter ${found[0]} is never in a VIN — on the car it's probably ${impostor[found[0]]}`;
  }
  if (found.length > 1) {
    return `The letters ${found.join(" and ")} are never in a VIN — check those against the car`;
  }
  return "Doesn't check out — one character is probably misread";
}

/* Wire a VIN input to a small verdict line under it. Masks as you type
   (uppercase, letters and digits only, 17 at most), counts the characters
   on the way there, and the moment the 17th lands says whether the number
   proves itself or not. `onState` hears every change ("empty" | "partial" |
   "ok" | "bad") so a caller can react -- the intake dialogs use it to light
   the Decode VIN button. Returns the sync function so the caller can re-run
   it after setting the field from code (a form reset, a decoded plate). */
export function wireVinField(input, verdict, onState = null) {
  const sync = () => {
    const masked = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
    if (masked !== input.value) input.value = masked;
    const state = masked.length === 0 ? "empty"
      : masked.length < 17 ? "partial"
      : vinCheckDigitOk(masked) ? "ok" : "bad";
    verdict.hidden = state === "empty";
    verdict.classList.toggle("counting", state === "partial");
    verdict.classList.toggle("ok", state === "ok");
    verdict.classList.toggle("bad", state === "bad");
    verdict.textContent = state === "partial" ? `${masked.length} of 17 characters`
      : state === "ok" ? "✓ VIN checks out"
      : state === "bad" ? vinProblemText(masked)
      : "";
    input.classList.toggle("vin-ok", state === "ok");
    input.classList.toggle("vin-bad", state === "bad");
    if (onState) onState(state);
    return state;
  };
  input.addEventListener("input", sync);
  return sync;
}
