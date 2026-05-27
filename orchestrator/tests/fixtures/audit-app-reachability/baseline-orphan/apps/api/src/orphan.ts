// Genuinely orphan: NO file in apps/{web,mobile,api}/ imports this.
// The analyzer must still flag it after the bug-048 + bug-049 fixes land.
export function NeverCalled() {
  return "lonely";
}
