// The kit's two head lines (the hero's entrance and the moments' guard), as a file so the
// site's CSP (script-src 'self') needs no inline-script exception. Load it plain, in <head>.
document.documentElement.classList.add('m-enter', 'mo-js');
setTimeout(() => document.documentElement.classList.add('m-enter-done'), 700);
setTimeout(() => document.documentElement.classList.add('mo-safe'), 2500);
