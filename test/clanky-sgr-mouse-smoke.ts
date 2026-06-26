import { isClankyLeftMouseButton, parseClankySgrMouse } from "../agent/lib/clanky-sgr-mouse.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

assert(parseClankySgrMouse("not a mouse report") === undefined, "non-mouse input should not parse");
assert(parseClankySgrMouse("\x1b[<0;1;1") === undefined, "an incomplete report missing its terminator should not parse");

const press = parseClankySgrMouse("\x1b[<0;12;7M");
assert(press !== undefined && press.kind === "press", "button 0 press should classify as press");
assert(press.col === 12 && press.row === 7, "press should carry 1-based column and row");
assert(isClankyLeftMouseButton(press), "button 0 should be the left button");

const drag = parseClankySgrMouse("\x1b[<32;13;7M");
assert(drag !== undefined && drag.kind === "drag", "the motion flag (32) should classify as drag");
assert(isClankyLeftMouseButton(drag), "left-button drag should still read as the left button");

const release = parseClankySgrMouse("\x1b[<0;12;7m");
assert(release !== undefined && release.kind === "release" && release.release, "the trailing m should classify as release");

const wheelUp = parseClankySgrMouse("\x1b[<64;5;5M");
assert(wheelUp !== undefined && wheelUp.kind === "wheel" && wheelUp.wheelDirection === "up", "button 64 should be a wheel-up notch");
const wheelDown = parseClankySgrMouse("\x1b[<65;5;5M");
assert(wheelDown?.wheelDirection === "down", "button 65 should be a wheel-down notch");
assert(parseClankySgrMouse("\x1b[<64;5;5m")?.wheelDirection === undefined, "a wheel release should carry no scroll direction");

const rightPress = parseClankySgrMouse("\x1b[<2;1;1M");
assert(rightPress !== undefined && !isClankyLeftMouseButton(rightPress), "button 2 should not read as the left button");

console.log("clanky-sgr-mouse-smoke: ok");
