isHex in app.mjs matches anywhere in the string — even "zzz1a" passes.

Make it true only when the whole string is hexadecimal (0-9, a-f), one character or more (use ^ and $), then run node check.mjs.
