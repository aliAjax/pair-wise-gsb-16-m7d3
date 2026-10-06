// Node 环境 shim：localStorage / navigator
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() {
    return mem.size;
  },
};
if (!(globalThis as { navigator?: unknown }).navigator) {
  (globalThis as unknown as { navigator: { onLine: boolean } }).navigator = { onLine: true };
}

async function main() {
  await import("./smoke");
  localStorage.clear();
  await import("./ui");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
