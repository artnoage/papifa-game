export function readPreference(name) {
  try { return localStorage.getItem('papifa.' + name); } catch { return null; }
}

export function savePreference(name, value) {
  try { localStorage.setItem('papifa.' + name, value); } catch { /* Private browsing can disable storage. */ }
}
