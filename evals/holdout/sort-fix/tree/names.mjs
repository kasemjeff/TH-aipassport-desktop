// names.mjs — alphabetical sorting for the contact list.

export function sortNames(names) {
  return [...names].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
