// True when the string is hexadecimal (0-9, a-f), one character or more.
export const isHex = (s) => /[0-9a-f]+/i.test(s);
