import { describe, it, expect } from "vitest";
import { recordFailedPin, lockoutSecondsLeft, failedPinAttempts, clearPinLockout } from "./PinModal";

// The PIN dialog unmounts on Cancel, so the attempt count has to live outside it: with the count
// in component state, reopening the dialog reset the limit.
describe("PIN lockout survives the dialog being closed", () => {
  it("starts a 10 second cooldown on the third wrong PIN and keeps it across reopen", () => {
    const profile = 901;
    const t0 = 1_000_000;
    expect(recordFailedPin(profile, t0)).toBe(1);
    expect(recordFailedPin(profile, t0)).toBe(2);
    expect(lockoutSecondsLeft(profile, t0)).toBe(0);
    expect(recordFailedPin(profile, t0)).toBe(3);
    // "Reopening" is just reading the shared state again.
    expect(failedPinAttempts(profile, t0 + 4_000)).toBe(3);
    expect(lockoutSecondsLeft(profile, t0 + 4_000)).toBe(6);
  });

  it("gives three fresh attempts once the cooldown has run out", () => {
    const profile = 902;
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) recordFailedPin(profile, t0);
    expect(lockoutSecondsLeft(profile, t0 + 10_000)).toBe(0);
    expect(failedPinAttempts(profile, t0 + 10_000)).toBe(0);
    expect(recordFailedPin(profile, t0 + 10_000)).toBe(1);
  });

  it("keeps profiles apart and clears on a correct PIN", () => {
    recordFailedPin(903);
    recordFailedPin(903);
    expect(failedPinAttempts(904)).toBe(0);
    clearPinLockout(903);
    expect(failedPinAttempts(903)).toBe(0);
  });

  // The dialog's countdown reads the deadline every second. One that also cleared the lockout
  // whenever no cooldown was running handed the attempts back, and the limit never tripped.
  it("keeps one or two failures however often the countdown is read", () => {
    const profile = 905;
    const t0 = 3_000_000;
    recordFailedPin(profile, t0);
    recordFailedPin(profile, t0);
    expect(lockoutSecondsLeft(profile, t0 + 60_000)).toBe(0);
    expect(failedPinAttempts(profile, t0 + 60_000)).toBe(2);
    expect(recordFailedPin(profile, t0 + 60_000)).toBe(3);
    expect(lockoutSecondsLeft(profile, t0 + 60_000)).toBe(10);
  });
});
