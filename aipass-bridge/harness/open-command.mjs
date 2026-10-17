// Which argv opens a URL in the platform's browser — one rule, shared by the
// two surfaces that need it (the RPC's `browser.open` and the desktop
// launcher's `openWindow`) and pinned by the suite from any OS, because a
// Windows dev machine cannot run the darwin or linux branches.
//
// argv, never a shell string: the URL is passed whole, so a `&` in it cannot
// split the command and no shell parses it. On Windows cmd's `start` needs
// its empty title spelled as a bare "" — without it the first quoted argument
// (`start`'s title slot) would swallow the URL and no window would open.
export function openCommandFor(platform, target) {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', target]];
  if (platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}
